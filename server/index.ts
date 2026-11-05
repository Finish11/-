import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { createServer as createViteServer } from 'vite';
import { db, seedDefaultSitesForUser } from './db.ts';
import {
  createSession,
  getUserFromRequest,
  hashPassword,
  requireAuth,
  verifyPassword,
  type AuthedRequest,
} from './auth.ts';
import { inspectClientConnection, probeVpnEndpoint, tcpSiteProbe } from './networkProbe.ts';
import { registerVpnRoutes } from './vpnRoutes.ts';

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // Prevent iframe/preview blocking headers — allow Arena live preview embedding cleanly
  app.use((_req, res, next) => {
    res.removeHeader('X-Frame-Options');
    next();
  });

  function setSessionCookie(req: express.Request, res: express.Response, token: string) {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('pulsenet_token', token, {
      httpOnly: true,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
      partitioned: isHttps,
      maxAge: 30 * 24 * 3600 * 1000,
    } as express.CookieOptions);
  }

  function buildUserBootstrap(userId: number) {
    let sites = db
      .prepare(`SELECT * FROM sites WHERE user_id = ? ORDER BY id ASC`)
      .all(userId);
    if (sites.length === 0) {
      seedDefaultSitesForUser(userId, false);
      sites = db
        .prepare(`SELECT * FROM sites WHERE user_id = ? ORDER BY id ASC`)
        .all(userId);
    }

    const scanRows = db
      .prepare(
        `SELECT id, user_id, verdict, verdict_title, verdict_summary, vpn_detected, vpn_mode,
                ip_address, country_code, country_name, city, isp, asn,
                total_sites, ok_sites, slow_sites, blocked_sites,
                ru_ok_pct, global_ok_pct, dpi_ok_pct, avg_latency_ms,
                carrier_label, note, pinned, results_json, created_at
         FROM scans
         WHERE user_id = ?
         ORDER BY pinned DESC, created_at DESC
         LIMIT 50`
      )
      .all(userId) as Array<Record<string, unknown>>;

    const scans = scanRows.map((r) => ({
      ...r,
      vpn_detected: Boolean(r.vpn_detected),
      pinned: Boolean(r.pinned),
      results: JSON.parse(String(r.results_json || '[]')),
      results_json: undefined,
    }));

    const vpnRows = db
      .prepare(
        `SELECT * FROM vpn_profiles WHERE user_id = ? ORDER BY is_primary DESC, id ASC`
      )
      .all(userId) as Array<Record<string, unknown>>;

    const profiles = vpnRows.map((r) => ({
      ...r,
      whitelist_bypass: Boolean(r.whitelist_bypass),
      is_primary: Boolean(r.is_primary),
    }));

    const incRows = db
      .prepare(
        `SELECT i.*,
                CASE WHEN u.user_id IS NOT NULL THEN 1 ELSE 0 END AS user_upvoted
         FROM incidents i
         LEFT JOIN incident_upvotes u ON u.incident_id = i.id AND u.user_id = ?
         ORDER BY CASE WHEN i.status = 'active' THEN 0 ELSE 1 END, i.created_at DESC`
      )
      .all(userId) as Array<Record<string, unknown>>;

    const incidents = incRows.map((r) => ({
      ...r,
      ru_sites_ok: Boolean(r.ru_sites_ok),
      foreign_sites_ok: Boolean(r.foreign_sites_ok),
      user_upvoted: Boolean(r.user_upvoted),
      is_owner: r.user_id === userId,
      // В этой базе отчёты только настоящие — флаг остаётся false и в
      // интерфейсе не появляется пометка «пример».
      demo: false,
    }));

    const subRows = db
      .prepare(`SELECT * FROM vpn_subscriptions WHERE user_id = ? ORDER BY id DESC`)
      .all(userId) as Array<Record<string, unknown>>;
    const nodeCounts = db
      .prepare(
        `SELECT subscription_id, COUNT(*) as cnt FROM vpn_profiles
         WHERE user_id = ? AND subscription_id IS NOT NULL GROUP BY subscription_id`
      )
      .all(userId) as Array<{ subscription_id: number; cnt: number }>;
    const countMap = new Map(nodeCounts.map((c) => [c.subscription_id, c.cnt]));

    const subscriptions = subRows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      name: r.name,
      url: r.url,
      format: r.format,
      provider: r.provider,
      auto_update: Boolean(r.auto_update),
      update_interval_hours: r.update_interval_hours,
      last_synced_at: r.last_synced_at,
      last_sync_status: r.last_sync_status,
      last_sync_message: r.last_sync_message,
      traffic_used_bytes: r.traffic_used_bytes,
      traffic_total_bytes: r.traffic_total_bytes,
      expires_on: r.expires_on,
      node_count: countMap.get(Number(r.id)) || 0,
      created_at: r.created_at,
    }));

    return { sites, scans, profiles, incidents, subscriptions };
  }

  // ==================== AUTH ROUTES ====================
  app.post('/api/auth/demo', (req, res) => {
    const demoUser = db
      .prepare(`SELECT id, email, name, region, carrier, created_at FROM users WHERE email = ?`)
      .get('demo@pulsenet.ru') as
      | { id: number; email: string; name: string; region: string; carrier: string; created_at: string }
      | undefined;

    if (!demoUser) {
      res.status(404).json({ error: 'Демо-аккаунт не найден' });
      return;
    }

    const token = createSession(demoUser.id);
    setSessionCookie(req, res, token);
    res.json({ user: demoUser, token, ...buildUserBootstrap(demoUser.id) });
  });

  app.post('/api/auth/register', (req, res) => {
    const { email, password, name, region, carrier } = req.body || {};
    if (!email || !password || !name) {
      res.status(400).json({ error: 'Заполните имя, email и пароль' });
      return;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    if (String(password).length < 4) {
      res.status(400).json({ error: 'Пароль должен содержать минимум 4 символа' });
      return;
    }

    const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(normalizedEmail);
    if (exists) {
      res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
      return;
    }

    const now = new Date().toISOString();
    const passHash = hashPassword(String(password));
    const result = db
      .prepare(
        `INSERT INTO users (email, name, region, carrier, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        normalizedEmail,
        String(name).trim(),
        String(region || 'Москва').trim(),
        String(carrier || 'МТС').trim(),
        passHash,
        now
      );

    const userId = Number(result.lastInsertRowid);
    seedDefaultSitesForUser(userId, false);

    const user = {
      id: userId,
      email: normalizedEmail,
      name: String(name).trim(),
      region: String(region || 'Москва').trim(),
      carrier: String(carrier || 'МТС').trim(),
      created_at: now,
    };

    const token = createSession(userId);
    setSessionCookie(req, res, token);
    res.status(201).json({ user, token, ...buildUserBootstrap(userId) });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'Введите email и пароль' });
      return;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const row = db
      .prepare(
        `SELECT id, email, name, region, carrier, password_hash, created_at FROM users WHERE email = ?`
      )
      .get(normalizedEmail) as
      | {
          id: number;
          email: string;
          name: string;
          region: string;
          carrier: string;
          password_hash: string;
          created_at: string;
        }
      | undefined;

    if (!row || !verifyPassword(String(password), row.password_hash)) {
      res.status(401).json({ error: 'Неверный email или пароль' });
      return;
    }

    const token = createSession(row.id);
    setSessionCookie(req, res, token);

    res.json({
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        region: row.region,
        carrier: row.carrier,
        created_at: row.created_at,
      },
      token,
      ...buildUserBootstrap(row.id),
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const session = getUserFromRequest(req);
    if (session) {
      db.prepare(`DELETE FROM sessions WHERE token = ?`).run(session.token);
    }
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.clearCookie('pulsenet_token', {
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
    });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const session = getUserFromRequest(req);
    if (!session) {
      res.status(401).json({ error: 'Не авторизован' });
      return;
    }
    res.json({
      user: session.user,
      token: session.token,
      ...buildUserBootstrap(session.user.id),
    });
  });

  app.patch('/api/auth/profile', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const { name, region, carrier } = req.body || {};
    const current = req.user!;
    const nextName = name ? String(name).trim() : current.name;
    const nextRegion = region ? String(region).trim() : current.region;
    const nextCarrier = carrier ? String(carrier).trim() : current.carrier;

    db.prepare(`UPDATE users SET name = ?, region = ?, carrier = ? WHERE id = ?`).run(
      nextName,
      nextRegion,
      nextCarrier,
      userId
    );

    res.json({
      user: {
        ...current,
        name: nextName,
        region: nextRegion,
        carrier: nextCarrier,
      },
    });
  });

  // ==================== NETWORK CLIENT INSPECTION ====================
  app.post('/api/network/inspect', async (req, res) => {
    try {
      const info = await inspectClientConnection(req, req.body || {});
      res.json(info);
    } catch {
      res.status(500).json({ error: 'Ошибка анализа сетевого подключения' });
    }
  });

  /**
   * Серверный релей замеров: браузер пользователя может быть заблокирован ТСПУ
   * (или сидеть в песочнице без доступа к домену), поэтому при провале прямого
   * замера мы пробуем открыть probe_url с сервера. Это отличает «сайт лёг» от
   * «в этой сети вырезан конкретный домен / SNI».
   */
  app.post('/api/net/probe', requireAuth, async (req: AuthedRequest, res) => {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: 'Некорректный URL для замера' });
      return;
    }
    try {
      const result = await tcpSiteProbe(url);
      res.json(result);
    } catch {
      res.json({ ok: false, latency_ms: null, reason: 'probe_failed' });
    }
  });

  /**
   * Образец подписки в формате base64 (как отдают панели Remnawave / Marzban).
   * Нужен, чтобы можно было протестировать VPN-клиент без своего провайдера.
   */
  app.get('/api/sample-subscription', (_req, res) => {
    const nodes = [
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@aeza.net:443?security=reality&sni=www.microsoft.com&fp=chrome&type=tcp&flow=xtls-rprx-vision#🇳🇱%20Амстердам%20•%20Reality',
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@upcloud.com:443?security=reality&sni=cloudflare.com&fp=chrome&type=tcp#🇫🇮%20Хельсинки%20•%20Reality',
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@hetzner.com:8443?security=tls&sni=hetzner.com&type=grpc#🇩🇪%20Франкфурт%20•%20gRPC',
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@selectel.ru:443?security=reality&sni=gosuslugi.ru&fp=chrome&type=tcp#🇷🇺%20RU-каскад%20(Анти-белый%20список)',
      'trojan://demo-pass-2026@bahnhof.net:443?security=tls&sni=bahnhof.net#🇸🇪%20Стокгольм%20•%20Trojan',
      'hysteria2://demo-pass-2026@leaseweb.com:443?sni=leaseweb.com#🇳🇱%20Амстердам%20•%20Hysteria2',
      'ss://YWVzLTI1Ni1nY206ZGVtby1wYXNzLTIwMjY@ovhcloud.com:8388#🇵🇱%20Варшава%20•%20Shadowsocks',
      'vmess://' +
        Buffer.from(
          JSON.stringify({
            v: '2',
            ps: '🇹🇷 Стамбул • VMess',
            add: 'digitalocean.com',
            port: '443',
            id: '8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc',
            net: 'ws',
            tls: 'tls',
          })
        ).toString('base64'),
    ];
    const body = Buffer.from(nodes.join('\n')).toString('base64');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('profile-title', 'base64:' + Buffer.from('Демо-подписка ПульсСети').toString('base64'));
    res.setHeader(
      'subscription-userinfo',
      'upload=734003200; download=2415919104; total=53687091200; expire=1798761600'
    );
    res.send(body);
  });

  // ==================== VPN SUBSCRIPTIONS (Happ / v2rayN / Clash) ====================
  registerVpnRoutes(app, requireAuth);

  // ==================== SITES CRUD ====================
  app.get('/api/sites', requireAuth, (req: AuthedRequest, res) => {
    const sites = db
      .prepare(`SELECT * FROM sites WHERE user_id = ? ORDER BY id ASC`)
      .all(req.user!.id);
    res.json({ sites });
  });

  app.post('/api/sites', requireAuth, (req: AuthedRequest, res) => {
    const { name, domain, probe_url, category, marker_role, description } = req.body || {};
    if (!name || !domain) {
      res.status(400).json({ error: 'Укажите название и домен сайта' });
      return;
    }
    const cleanDomain = String(domain)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');

    const finalProbeUrl = probe_url && String(probe_url).trim()
      ? String(probe_url).trim()
      : `https://${cleanDomain}/favicon.ico`;

    const now = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO sites (
          user_id, name, domain, probe_url, category, marker_role,
          enabled, last_status, last_latency_ms, last_checked_at, description, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'unknown', NULL, NULL, ?, ?)`
      )
      .run(
        req.user!.id,
        String(name).trim(),
        cleanDomain,
        finalProbeUrl,
        String(category || 'custom'),
        String(marker_role || 'global_neutral'),
        String(description || '').trim(),
        now
      );

    const site = db.prepare(`SELECT * FROM sites WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ site });
  });

  app.patch('/api/sites/:id', requireAuth, (req: AuthedRequest, res) => {
    const siteId = Number(req.params.id);
    const existing = db
      .prepare(`SELECT * FROM sites WHERE id = ? AND user_id = ?`)
      .get(siteId, req.user!.id) as Record<string, unknown> | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Сайт не найден' });
      return;
    }

    const body = req.body || {};
    const nextName = body.name !== undefined ? String(body.name).trim() : existing.name;
    const nextDomain =
      body.domain !== undefined
        ? String(body.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
        : existing.domain;
    const nextProbeUrl =
      body.probe_url !== undefined ? String(body.probe_url).trim() : existing.probe_url;
    const nextCategory = body.category !== undefined ? String(body.category) : existing.category;
    const nextMarkerRole =
      body.marker_role !== undefined ? String(body.marker_role) : existing.marker_role;
    const nextEnabled =
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
    const nextDescription =
      body.description !== undefined ? String(body.description).trim() : existing.description;
    const nextLastStatus =
      body.last_status !== undefined ? String(body.last_status) : existing.last_status;
    const nextLatency =
      body.last_latency_ms !== undefined ? body.last_latency_ms : existing.last_latency_ms;
    const nextCheckedAt =
      body.last_checked_at !== undefined ? body.last_checked_at : existing.last_checked_at;

    db.prepare(
      `UPDATE sites
       SET name = ?, domain = ?, probe_url = ?, category = ?, marker_role = ?,
           enabled = ?, description = ?, last_status = ?, last_latency_ms = ?, last_checked_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      nextName,
      nextDomain,
      nextProbeUrl,
      nextCategory,
      nextMarkerRole,
      nextEnabled,
      nextDescription,
      nextLastStatus,
      nextLatency,
      nextCheckedAt,
      siteId,
      req.user!.id
    );

    const updated = db.prepare(`SELECT * FROM sites WHERE id = ?`).get(siteId);
    res.json({ site: updated });
  });

  app.delete('/api/sites/:id', requireAuth, (req: AuthedRequest, res) => {
    const siteId = Number(req.params.id);
    const info = db
      .prepare(`DELETE FROM sites WHERE id = ? AND user_id = ?`)
      .run(siteId, req.user!.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Сайт не найден' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/sites/reset', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    db.prepare(`DELETE FROM sites WHERE user_id = ?`).run(userId);
    seedDefaultSitesForUser(userId, false);
    const sites = db
      .prepare(`SELECT * FROM sites WHERE user_id = ? ORDER BY id ASC`)
      .all(userId);
    res.json({ sites });
  });

  // ==================== SCANS CRUD ====================
  app.get('/api/scans', requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT id, user_id, verdict, verdict_title, verdict_summary, vpn_detected, vpn_mode,
                ip_address, country_code, country_name, city, isp, asn,
                total_sites, ok_sites, slow_sites, blocked_sites,
                ru_ok_pct, global_ok_pct, dpi_ok_pct, avg_latency_ms,
                carrier_label, note, pinned, results_json, created_at
         FROM scans
         WHERE user_id = ?
         ORDER BY pinned DESC, created_at DESC
         LIMIT 50`
      )
      .all(req.user!.id) as Array<Record<string, unknown>>;

    const scans = rows.map((r) => ({
      ...r,
      vpn_detected: Boolean(r.vpn_detected),
      pinned: Boolean(r.pinned),
      results: JSON.parse(String(r.results_json || '[]')),
      results_json: undefined,
    }));

    res.json({ scans });
  });

  app.post('/api/scans', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const b = req.body || {};
    const now = new Date().toISOString();
    const resultsArr = Array.isArray(b.results) ? b.results : [];

    const tx = db.transaction(() => {
      const scanRes = db
        .prepare(
          `INSERT INTO scans (
            user_id, verdict, verdict_title, verdict_summary, vpn_detected, vpn_mode,
            ip_address, country_code, country_name, city, isp, asn,
            total_sites, ok_sites, slow_sites, blocked_sites,
            ru_ok_pct, global_ok_pct, dpi_ok_pct, avg_latency_ms,
            carrier_label, note, pinned, results_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          userId,
          String(b.verdict || 'OPEN_INTERNET'),
          String(b.verdict_title || 'Проверка завершена'),
          String(b.verdict_summary || ''),
          b.vpn_detected ? 1 : 0,
          String(b.vpn_mode || 'direct'),
          String(b.ip_address || '0.0.0.0'),
          String(b.country_code || 'RU'),
          String(b.country_name || 'Россия'),
          String(b.city || ''),
          String(b.isp || 'Неизвестный провайдер'),
          String(b.asn || ''),
          Number(b.total_sites || resultsArr.length),
          Number(b.ok_sites || 0),
          Number(b.slow_sites || 0),
          Number(b.blocked_sites || 0),
          Number(b.ru_ok_pct || 0),
          Number(b.global_ok_pct || 0),
          Number(b.dpi_ok_pct || 0),
          Number(b.avg_latency_ms || 0),
          String(b.carrier_label || ''),
          String(b.note || ''),
          JSON.stringify(resultsArr),
          now
        );

      const updateSiteStmt = db.prepare(
        `UPDATE sites
         SET last_status = ?, last_latency_ms = ?, last_checked_at = ?
         WHERE id = ? AND user_id = ?`
      );
      for (const item of resultsArr) {
        if (item && item.site_id) {
          updateSiteStmt.run(
            String(item.status || 'unknown'),
            item.latency_ms ?? null,
            now,
            Number(item.site_id),
            userId
          );
        }
      }

      return Number(scanRes.lastInsertRowid);
    });

    const scanId = tx();
    const row = db.prepare(`SELECT * FROM scans WHERE id = ?`).get(scanId) as Record<string, unknown>;
    res.status(201).json({
      scan: {
        ...row,
        vpn_detected: Boolean(row.vpn_detected),
        pinned: Boolean(row.pinned),
        results: JSON.parse(String(row.results_json || '[]')),
        results_json: undefined,
      },
    });
  });

  app.patch('/api/scans/:id', requireAuth, (req: AuthedRequest, res) => {
    const scanId = Number(req.params.id);
    const existing = db
      .prepare(`SELECT * FROM scans WHERE id = ? AND user_id = ?`)
      .get(scanId, req.user!.id) as Record<string, unknown> | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Запись проверки не найдена' });
      return;
    }

    const body = req.body || {};
    const nextCarrier =
      body.carrier_label !== undefined ? String(body.carrier_label).trim() : existing.carrier_label;
    const nextNote = body.note !== undefined ? String(body.note).trim() : existing.note;
    const nextPinned =
      body.pinned !== undefined ? (body.pinned ? 1 : 0) : existing.pinned;

    db.prepare(
      `UPDATE scans SET carrier_label = ?, note = ?, pinned = ? WHERE id = ? AND user_id = ?`
    ).run(nextCarrier, nextNote, nextPinned, scanId, req.user!.id);

    const updated = db.prepare(`SELECT * FROM scans WHERE id = ?`).get(scanId) as Record<string, unknown>;
    res.json({
      scan: {
        ...updated,
        vpn_detected: Boolean(updated.vpn_detected),
        pinned: Boolean(updated.pinned),
        results: JSON.parse(String(updated.results_json || '[]')),
        results_json: undefined,
      },
    });
  });

  app.delete('/api/scans/:id', requireAuth, (req: AuthedRequest, res) => {
    const scanId = Number(req.params.id);
    const info = db
      .prepare(`DELETE FROM scans WHERE id = ? AND user_id = ?`)
      .run(scanId, req.user!.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Запись не найдена' });
      return;
    }
    res.json({ ok: true });
  });

  // ==================== VPN PROFILES CRUD ====================
  app.get('/api/vpn-profiles', requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM vpn_profiles WHERE user_id = ? ORDER BY is_primary DESC, id ASC`
      )
      .all(req.user!.id) as Array<Record<string, unknown>>;

    const profiles = rows.map((r) => ({
      ...r,
      whitelist_bypass: Boolean(r.whitelist_bypass),
      is_primary: Boolean(r.is_primary),
    }));
    res.json({ profiles });
  });

  app.post('/api/vpn-profiles', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const b = req.body || {};
    if (!b.name || !b.host) {
      res.status(400).json({ error: 'Укажите название и адрес (хост/IP) VPN-сервера' });
      return;
    }

    const port = Number(b.port || 443);
    const probe = await probeVpnEndpoint(String(b.host), port);
    const now = new Date().toISOString();

    if (b.is_primary) {
      db.prepare(`UPDATE vpn_profiles SET is_primary = 0 WHERE user_id = ?`).run(userId);
    }

    const result = db
      .prepare(
        `INSERT INTO vpn_profiles (
          user_id, name, protocol, location, country_code, host, port,
          provider, dpi_resistance, whitelist_bypass, status, latency_ms,
          uptime_pct, is_primary, notes, last_checked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        String(b.name).trim(),
        String(b.protocol || 'VLESS + Reality'),
        String(b.location || 'Нидерланды').trim(),
        String(b.country_code || 'NL').toUpperCase(),
        String(b.host).trim(),
        port,
        String(b.provider || '').trim(),
        String(b.dpi_resistance || 'high'),
        b.whitelist_bypass ? 1 : 0,
        probe.status,
        probe.latency_ms,
        probe.status === 'online' ? 100.0 : probe.status === 'degraded' ? 85.0 : 0.0,
        b.is_primary ? 1 : 0,
        String(b.notes || '').trim(),
        now,
        now
      );

    const row = db
      .prepare(`SELECT * FROM vpn_profiles WHERE id = ?`)
      .get(result.lastInsertRowid) as Record<string, unknown>;

    res.status(201).json({
      profile: {
        ...row,
        whitelist_bypass: Boolean(row.whitelist_bypass),
        is_primary: Boolean(row.is_primary),
      },
    });
  });

  app.patch('/api/vpn-profiles/:id', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const existing = db
      .prepare(`SELECT * FROM vpn_profiles WHERE id = ? AND user_id = ?`)
      .get(id, userId) as Record<string, unknown> | undefined;

    if (!existing) {
      res.status(404).json({ error: 'VPN-профиль не найден' });
      return;
    }

    const b = req.body || {};
    if (b.is_primary) {
      db.prepare(`UPDATE vpn_profiles SET is_primary = 0 WHERE user_id = ?`).run(userId);
    }

    db.prepare(
      `UPDATE vpn_profiles
       SET name = ?, protocol = ?, location = ?, country_code = ?, host = ?, port = ?,
           provider = ?, dpi_resistance = ?, whitelist_bypass = ?, is_primary = ?, notes = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      b.name !== undefined ? String(b.name).trim() : existing.name,
      b.protocol !== undefined ? String(b.protocol) : existing.protocol,
      b.location !== undefined ? String(b.location).trim() : existing.location,
      b.country_code !== undefined ? String(b.country_code).toUpperCase() : existing.country_code,
      b.host !== undefined ? String(b.host).trim() : existing.host,
      b.port !== undefined ? Number(b.port) : existing.port,
      b.provider !== undefined ? String(b.provider).trim() : existing.provider,
      b.dpi_resistance !== undefined ? String(b.dpi_resistance) : existing.dpi_resistance,
      b.whitelist_bypass !== undefined ? (b.whitelist_bypass ? 1 : 0) : existing.whitelist_bypass,
      b.is_primary !== undefined ? (b.is_primary ? 1 : 0) : existing.is_primary,
      b.notes !== undefined ? String(b.notes).trim() : existing.notes,
      id,
      userId
    );

    const row = db.prepare(`SELECT * FROM vpn_profiles WHERE id = ?`).get(id) as Record<string, unknown>;
    res.json({
      profile: {
        ...row,
        whitelist_bypass: Boolean(row.whitelist_bypass),
        is_primary: Boolean(row.is_primary),
      },
    });
  });

  app.post('/api/vpn-profiles/:id/check', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const existing = db
      .prepare(`SELECT * FROM vpn_profiles WHERE id = ? AND user_id = ?`)
      .get(id, userId) as Record<string, unknown> | undefined;

    if (!existing) {
      res.status(404).json({ error: 'VPN-профиль не найден' });
      return;
    }

    const probe = await probeVpnEndpoint(String(existing.host), Number(existing.port || 443));
    const now = new Date().toISOString();
    const prevUptime = Number(existing.uptime_pct || 95);
    const nextUptime =
      probe.status === 'online'
        ? Math.min(100, Number((prevUptime * 0.9 + 10).toFixed(1)))
        : probe.status === 'degraded'
        ? Number((prevUptime * 0.9 + 7).toFixed(1))
        : Math.max(0, Number((prevUptime * 0.85).toFixed(1)));

    db.prepare(
      `UPDATE vpn_profiles SET status = ?, latency_ms = ?, uptime_pct = ?, last_checked_at = ? WHERE id = ?`
    ).run(probe.status, probe.latency_ms, nextUptime, now, id);

    const updated = db.prepare(`SELECT * FROM vpn_profiles WHERE id = ?`).get(id) as Record<string, unknown>;
    res.json({
      profile: {
        ...updated,
        whitelist_bypass: Boolean(updated.whitelist_bypass),
        is_primary: Boolean(updated.is_primary),
      },
    });
  });

  app.post('/api/vpn-profiles/check-all', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const rows = db
      .prepare(`SELECT * FROM vpn_profiles WHERE user_id = ? ORDER BY is_primary DESC, id ASC`)
      .all(userId) as Array<Record<string, unknown>>;

    const now = new Date().toISOString();
    await Promise.all(
      rows.map(async (r) => {
        const probe = await probeVpnEndpoint(String(r.host), Number(r.port || 443));
        db.prepare(
          `UPDATE vpn_profiles SET status = ?, latency_ms = ?, last_checked_at = ? WHERE id = ?`
        ).run(probe.status, probe.latency_ms, now, r.id);
      })
    );

    const updatedRows = db
      .prepare(`SELECT * FROM vpn_profiles WHERE user_id = ? ORDER BY is_primary DESC, id ASC`)
      .all(userId) as Array<Record<string, unknown>>;

    res.json({
      profiles: updatedRows.map((r) => ({
        ...r,
        whitelist_bypass: Boolean(r.whitelist_bypass),
        is_primary: Boolean(r.is_primary),
      })),
    });
  });

  app.delete('/api/vpn-profiles/:id', requireAuth, (req: AuthedRequest, res) => {
    const info = db
      .prepare(`DELETE FROM vpn_profiles WHERE id = ? AND user_id = ?`)
      .run(Number(req.params.id), req.user!.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'VPN-профиль не найден' });
      return;
    }
    res.json({ ok: true });
  });

  // ==================== REGIONAL INCIDENTS CRUD ====================
  app.get('/api/incidents', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const rows = db
      .prepare(
        `SELECT i.*,
                CASE WHEN u.user_id IS NOT NULL THEN 1 ELSE 0 END AS user_upvoted
         FROM incidents i
         LEFT JOIN incident_upvotes u ON u.incident_id = i.id AND u.user_id = ?
         ORDER BY CASE WHEN i.status = 'active' THEN 0 ELSE 1 END, i.created_at DESC`
      )
      .all(userId) as Array<Record<string, unknown>>;

    const incidents = rows.map((r) => ({
      ...r,
      ru_sites_ok: Boolean(r.ru_sites_ok),
      foreign_sites_ok: Boolean(r.foreign_sites_ok),
      user_upvoted: Boolean(r.user_upvoted),
      is_owner: r.user_id === userId,
    }));

    res.json({ incidents });
  });

  app.post('/api/incidents', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const b = req.body || {};
    if (!b.region || !b.carrier || !b.title) {
      res.status(400).json({ error: 'Заполните регион, оператора и заголовок отчёта' });
      return;
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const ins = db
        .prepare(
          `INSERT INTO incidents (
            user_id, author_name, region, carrier, incident_type, severity,
            status, title, description, upvotes, ru_sites_ok, foreign_sites_ok, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?, ?)`
        )
        .run(
          user.id,
          user.name,
          String(b.region).trim(),
          String(b.carrier).trim(),
          String(b.incident_type || 'whitelist'),
          String(b.severity || 'critical'),
          String(b.title).trim(),
          String(b.description || '').trim(),
          b.ru_sites_ok !== undefined ? (b.ru_sites_ok ? 1 : 0) : 1,
          b.foreign_sites_ok !== undefined ? (b.foreign_sites_ok ? 1 : 0) : 0,
          now
        );
      const incId = Number(ins.lastInsertRowid);
      db.prepare(`INSERT INTO incident_upvotes (incident_id, user_id) VALUES (?, ?)`).run(
        incId,
        user.id
      );
      return incId;
    });

    const incId = tx();
    const row = db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(incId) as Record<string, unknown>;
    res.status(201).json({
      incident: {
        ...row,
        ru_sites_ok: Boolean(row.ru_sites_ok),
        foreign_sites_ok: Boolean(row.foreign_sites_ok),
        user_upvoted: true,
        is_owner: true,
      },
    });
  });

  app.patch('/api/incidents/:id', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const existing = db
      .prepare(`SELECT * FROM incidents WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Отчёт не найден' });
      return;
    }
    if (existing.user_id !== userId) {
      res.status(403).json({ error: 'Редактировать можно только собственные отчёты' });
      return;
    }

    const b = req.body || {};
    db.prepare(
      `UPDATE incidents
       SET region = ?, carrier = ?, incident_type = ?, severity = ?, status = ?, title = ?, description = ?
       WHERE id = ?`
    ).run(
      b.region !== undefined ? String(b.region).trim() : existing.region,
      b.carrier !== undefined ? String(b.carrier).trim() : existing.carrier,
      b.incident_type !== undefined ? String(b.incident_type) : existing.incident_type,
      b.severity !== undefined ? String(b.severity) : existing.severity,
      b.status !== undefined ? String(b.status) : existing.status,
      b.title !== undefined ? String(b.title).trim() : existing.title,
      b.description !== undefined ? String(b.description).trim() : existing.description,
      id
    );

    const upvoted = db
      .prepare(`SELECT 1 FROM incident_upvotes WHERE incident_id = ? AND user_id = ?`)
      .get(id, userId);
    const row = db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id) as Record<string, unknown>;

    res.json({
      incident: {
        ...row,
        ru_sites_ok: Boolean(row.ru_sites_ok),
        foreign_sites_ok: Boolean(row.foreign_sites_ok),
        user_upvoted: Boolean(upvoted),
        is_owner: true,
      },
    });
  });

  app.post('/api/incidents/:id/upvote', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const existing = db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Отчёт не найден' });
      return;
    }

    const tx = db.transaction(() => {
      const hasVote = db
        .prepare(`SELECT 1 FROM incident_upvotes WHERE incident_id = ? AND user_id = ?`)
        .get(id, userId);

      if (hasVote) {
        db.prepare(`DELETE FROM incident_upvotes WHERE incident_id = ? AND user_id = ?`).run(
          id,
          userId
        );
        db.prepare(`UPDATE incidents SET upvotes = MAX(0, upvotes - 1) WHERE id = ?`).run(id);
        return false;
      } else {
        db.prepare(`INSERT INTO incident_upvotes (incident_id, user_id) VALUES (?, ?)`).run(
          id,
          userId
        );
        db.prepare(`UPDATE incidents SET upvotes = upvotes + 1 WHERE id = ?`).run(id);
        return true;
      }
    });

    const userUpvoted = tx();
    const updated = db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id) as Record<string, unknown>;
    res.json({
      incident: {
        ...updated,
        ru_sites_ok: Boolean(updated.ru_sites_ok),
        foreign_sites_ok: Boolean(updated.foreign_sites_ok),
        user_upvoted: userUpvoted,
        is_owner: updated.user_id === userId,
      },
    });
  });

  app.delete('/api/incidents/:id', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const info = db
      .prepare(`DELETE FROM incidents WHERE id = ? AND user_id = ?`)
      .run(id, userId);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Отчёт не найден или нет прав на удаление' });
      return;
    }
    res.json({ ok: true });
  });

  // ==================== FRONTEND SERVING (VITE MIDDLEWARE / PROD DIST) ====================
  const httpServer = http.createServer(app);

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`PulseNet full-stack server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
