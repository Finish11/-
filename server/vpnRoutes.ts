import type express from 'express';
import QRCode from 'qrcode';
import { db } from './db.ts';
import { type AuthedRequest } from './auth.ts';
import { probeVpnEndpoint, mapLimit } from './networkProbe.ts';
import {
  fetchSubscription,
  parseShareLink,
  parseSubscriptionText,
  type ParsedNode,
} from './subscription.ts';

function boolize<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    whitelist_bypass: Boolean(row.whitelist_bypass),
    is_primary: Boolean(row.is_primary),
  } as T;
}

function serializeSubscription(row: Record<string, unknown>, nodeCount: number) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    url: row.url,
    format: row.format,
    provider: row.provider,
    auto_update: Boolean(row.auto_update),
    update_interval_hours: row.update_interval_hours,
    last_synced_at: row.last_synced_at,
    last_sync_status: row.last_sync_status,
    last_sync_message: row.last_sync_message,
    traffic_used_bytes: row.traffic_used_bytes,
    traffic_total_bytes: row.traffic_total_bytes,
    expires_on: row.expires_on,
    node_count: nodeCount,
    created_at: row.created_at,
  };
}

export function registerVpnRoutes(app: express.Express, requireAuth: express.RequestHandler) {
  // ---------- СПИСОК ПОДПИСОК ----------
  app.get('/api/vpn-subscriptions', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const rows = db
      .prepare(`SELECT * FROM vpn_subscriptions WHERE user_id = ? ORDER BY id DESC`)
      .all(userId) as Array<Record<string, unknown>>;

    const counts = db
      .prepare(
        `SELECT subscription_id, COUNT(*) as cnt FROM vpn_profiles
         WHERE user_id = ? AND subscription_id IS NOT NULL GROUP BY subscription_id`
      )
      .all(userId) as Array<{ subscription_id: number; cnt: number }>;
    const map = new Map(counts.map((c) => [c.subscription_id, c.cnt]));

    res.json({
      subscriptions: rows.map((r) => serializeSubscription(r, map.get(Number(r.id)) || 0)),
    });
  });

  // ---------- ДОБАВИТЬ ПОДПИСКУ ----------
  app.post('/api/vpn-subscriptions', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const b = req.body || {};
    const url = String(b.url || '').trim();
    if (!url) {
      res.status(400).json({ error: 'Вставьте ссылку подписки (subscription URL)' });
      return;
    }

    const now = new Date().toISOString();
    let payload;
    try {
      payload = await fetchSubscription(url);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Не удалось загрузить подписку',
      });
      return;
    }

    if (payload.nodes.length === 0) {
      res.status(422).json({
        error:
          'В подписке не найдено ни одного сервера. Поддерживаются VLESS/Reality, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, WireGuard и формат Clash.',
      });
      return;
    }

    const name =
      String(b.name || '').trim() ||
      payload.profile_title ||
      `Подписка ${new Date().toLocaleDateString('ru-RU')}`;

    const info = db
      .prepare(
        `INSERT INTO vpn_subscriptions (
          user_id, name, url, format, provider, auto_update, update_interval_hours,
          last_synced_at, last_sync_status, last_sync_message,
          traffic_used_bytes, traffic_total_bytes, expires_on, raw_snapshot, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        name,
        url,
        payload.format,
        String(b.provider || '').trim(),
        b.auto_update === false ? 0 : 1,
        Number(b.update_interval_hours || 12),
        now,
        `Импортировано серверов: ${payload.nodes.length}`,
        payload.traffic_used_bytes,
        payload.traffic_total_bytes,
        payload.expires_on,
        payload.raw_text.slice(0, 200_000),
        now
      );

    const subscriptionId = Number(info.lastInsertRowid);
    const probes = await mapLimit(payload.nodes, 4, (n) => probeVpnEndpoint(n.host, n.port, 2));

    const insertNode = db.prepare(
      `INSERT INTO vpn_profiles (
        user_id, subscription_id, group_name, name, protocol, location, country_code,
        host, port, provider, dpi_resistance, whitelist_bypass, status, latency_ms,
        uptime_pct, is_primary, notes, raw_link, last_latency_all, last_checked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = db.transaction(() => {
      payload!.nodes.forEach((node: ParsedNode, idx: number) => {
        const probe = probes[idx];
        insertNode.run(
          userId,
          subscriptionId,
          node.group_name || name,
          node.name,
          node.protocol,
          node.location,
          node.country_code,
          node.host,
          node.port,
          node.provider,
          node.dpi_resistance,
          node.whitelist_bypass ? 1 : 0,
          probe.status,
          probe.latency_ms,
          probe.status === 'online' ? 100 : probe.status === 'degraded' ? 82 : 0,
          0,
          '',
          node.raw_link,
          probe.latency_all,
          now,
          now
        );
      });
    });
    tx();

    const profiles = db
      .prepare(
        `SELECT * FROM vpn_profiles WHERE user_id = ? ORDER BY is_primary DESC, id ASC`
      )
      .all(userId) as Array<Record<string, unknown>>;
    const subRow = db
      .prepare(`SELECT * FROM vpn_subscriptions WHERE id = ?`)
      .get(subscriptionId) as Record<string, unknown>;

    res.status(201).json({
      subscription: serializeSubscription(subRow, payload.nodes.length),
      profiles: profiles.map(boolize),
      imported: payload.nodes.length,
      online: probes.filter((p) => p.status === 'online').length,
    });
  });

  // ---------- ОБНОВИТЬ (синхронизировать) ПОДПИСКУ ----------
  app.post(
    '/api/vpn-subscriptions/:id/sync',
    requireAuth,
    async (req: AuthedRequest, res) => {
      const userId = req.user!.id;
      const id = Number(req.params.id);
      const sub = db
        .prepare(`SELECT * FROM vpn_subscriptions WHERE id = ? AND user_id = ?`)
        .get(id, userId) as Record<string, unknown> | undefined;
      if (!sub) {
        res.status(404).json({ error: 'Подписка не найдена' });
        return;
      }

      const now = new Date().toISOString();
      let payload;
      try {
        payload = await fetchSubscription(String(sub.url));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Ошибка загрузки подписки';
        db.prepare(
          `UPDATE vpn_subscriptions SET last_sync_status = 'error', last_sync_message = ? WHERE id = ?`
        ).run(message, id);
        res.status(400).json({ error: message });
        return;
      }

      const probes = await mapLimit(payload.nodes, 4, (n) => probeVpnEndpoint(n.host, n.port, 2));

      const tx = db.transaction(() => {
        // Удаляем старые узлы этой подписки, оставляя только что импортированные заново
        db.prepare(
          `DELETE FROM vpn_profiles WHERE subscription_id = ? AND user_id = ?`
        ).run(id, userId);

        const insertNode = db.prepare(
          `INSERT INTO vpn_profiles (
            user_id, subscription_id, group_name, name, protocol, location, country_code,
            host, port, provider, dpi_resistance, whitelist_bypass, status, latency_ms,
            uptime_pct, is_primary, notes, raw_link, last_latency_all, last_checked_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        payload!.nodes.forEach((node: ParsedNode, idx: number) => {
          const probe = probes[idx];
          insertNode.run(
            userId,
            id,
            node.group_name || String(sub.name),
            node.name,
            node.protocol,
            node.location,
            node.country_code,
            node.host,
            node.port,
            node.provider,
            node.dpi_resistance,
            node.whitelist_bypass ? 1 : 0,
            probe.status,
            probe.latency_ms,
            probe.status === 'online' ? 100 : probe.status === 'degraded' ? 82 : 0,
            0,
            '',
            node.raw_link,
            probe.latency_all,
            now,
            now
          );
        });

        db.prepare(
          `UPDATE vpn_subscriptions SET
             last_synced_at = ?, last_sync_status = 'ok', last_sync_message = ?,
             traffic_used_bytes = ?, traffic_total_bytes = ?, expires_on = ?,
             raw_snapshot = ?, format = ?
           WHERE id = ?`
        ).run(
          now,
          `Серверов: ${payload!.nodes.length}`,
          payload!.traffic_used_bytes,
          payload!.traffic_total_bytes,
          payload!.expires_on,
          payload!.raw_text.slice(0, 200_000),
          payload!.format,
          id
        );
      });
      tx();

      const profiles = db
        .prepare(`SELECT * FROM vpn_profiles WHERE user_id = ? ORDER BY is_primary DESC, id ASC`)
        .all(userId) as Array<Record<string, unknown>>;
      const subRow = db
        .prepare(`SELECT * FROM vpn_subscriptions WHERE id = ?`)
        .get(id) as Record<string, unknown>;

      res.json({
        subscription: serializeSubscription(subRow, payload.nodes.length),
        profiles: profiles.map(boolize),
        imported: payload.nodes.length,
      });
    }
  );

  // ---------- ПЕРЕИМЕНОВАТЬ / НАСТРОЙКИ ПОДПИСКИ ----------
  app.patch('/api/vpn-subscriptions/:id', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const existing = db
      .prepare(`SELECT * FROM vpn_subscriptions WHERE id = ? AND user_id = ?`)
      .get(id, userId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Подписка не найдена' });
      return;
    }
    const b = req.body || {};
    db.prepare(
      `UPDATE vpn_subscriptions SET name = ?, auto_update = ?, update_interval_hours = ?, provider = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      b.name !== undefined ? String(b.name).trim() : existing.name,
      b.auto_update !== undefined ? (b.auto_update ? 1 : 0) : existing.auto_update,
      b.update_interval_hours !== undefined
        ? Number(b.update_interval_hours)
        : existing.update_interval_hours,
      b.provider !== undefined ? String(b.provider).trim() : existing.provider,
      id,
      userId
    );
    const row = db
      .prepare(`SELECT * FROM vpn_subscriptions WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    const cnt = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM vpn_profiles WHERE subscription_id = ?`)
        .get(id) as { cnt: number }
    ).cnt;
    res.json({ subscription: serializeSubscription(row, cnt) });
  });

  // ---------- УДАЛИТЬ ПОДПИСКУ ----------
  app.delete('/api/vpn-subscriptions/:id', requireAuth, (req: AuthedRequest, res) => {
    const info = db
      .prepare(`DELETE FROM vpn_profiles WHERE subscription_id = ? AND user_id = ?`)
      .run(Number(req.params.id), req.user!.id);
    const del = db
      .prepare(`DELETE FROM vpn_subscriptions WHERE id = ? AND user_id = ?`)
      .run(Number(req.params.id), req.user!.id);
    if (del.changes === 0) {
      res.status(404).json({ error: 'Подписка не найдена' });
      return;
    }
    res.json({ ok: true, removed_nodes: info.changes });
  });

  // ---------- ИМПОРТ ОТДЕЛЬНЫХ ССЫЛОК / БАЗЫ64 / CLASH ----------
  app.post('/api/vpn-profiles/import', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const raw = String(req.body?.text || '').trim();
    const groupName = String(req.body?.group_name || 'Импорт вручную').trim();
    if (!raw) {
      res.status(400).json({ error: 'Вставьте ссылку vless://, vmess://, ss://, trojan:// или подписку' });
      return;
    }

    let nodes: ParsedNode[] = [];
    let format = 'plain';
    const asLink = raw.split(/\s+/).length === 1 ? parseShareLink(raw, groupName) : null;
    if (asLink) {
      nodes = [asLink];
    } else {
      const parsed = parseSubscriptionText(raw, groupName);
      nodes = parsed.nodes;
      format = parsed.format;
    }

    if (nodes.length === 0) {
      res.status(422).json({
        error:
          'Не удалось распознать серверы. Поддерживаются ссылки vless://, vmess://, trojan://, ss://, hysteria2://, а также base64-подписки и Clash YAML.',
      });
      return;
    }

    const now = new Date().toISOString();
    const probes = await mapLimit(nodes, 4, (n) => probeVpnEndpoint(n.host, n.port, 2));
    const insert = db.prepare(
      `INSERT INTO vpn_profiles (
        user_id, subscription_id, group_name, name, protocol, location, country_code,
        host, port, provider, dpi_resistance, whitelist_bypass, status, latency_ms,
        uptime_pct, is_primary, notes, raw_link, last_latency_all, last_checked_at, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    );

    const tx = db.transaction(() => {
      nodes.forEach((node, idx) => {
        const probe = probes[idx];
        insert.run(
          userId,
          node.group_name || groupName,
          node.name,
          node.protocol,
          node.location,
          node.country_code,
          node.host,
          node.port,
          node.provider,
          node.dpi_resistance,
          node.whitelist_bypass ? 1 : 0,
          probe.status,
          probe.latency_ms,
          probe.status === 'online' ? 100 : probe.status === 'degraded' ? 82 : 0,
          `Импортировано из ${format === 'base64' ? 'base64-подписки' : format === 'clash' ? 'Clash YAML' : 'ссылки'}`,
          node.raw_link,
          probe.latency_all,
          now,
          now
        );
      });
    });
    tx();

    const profiles = db
      .prepare(`SELECT * FROM vpn_profiles WHERE user_id = ? ORDER BY is_primary DESC, id ASC`)
      .all(userId) as Array<Record<string, unknown>>;

    res.status(201).json({
      imported: nodes.length,
      profiles: profiles.map(boolize),
      preview: nodes.map((n) => ({
        name: n.name,
        protocol: n.protocol,
        host: n.host,
        port: n.port,
        location: n.location,
        country_code: n.country_code,
      })),
    });
  });

  // ---------- QR-КОД ДЛЯ ПЕРЕНОСА ПРОФИЛЯ В ТЕЛЕФОН ----------
  app.get('/api/vpn-profiles/:id/qr', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const row = db
      .prepare(`SELECT * FROM vpn_profiles WHERE id = ? AND user_id = ?`)
      .get(id, userId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'VPN-профиль не найден' });
      return;
    }

    const rawLink = String(row.raw_link || '');
    const target = rawLink || `vpn://${row.host}:${row.port}`;
    try {
      await QRCode.toDataURL(target, { margin: 1, width: 480 });
      res.json({ ok: true, target });
    } catch {
      res.status(500).json({ error: 'Не удалось подготовить ссылку для QR-кода' });
    }
  });

  // ---------- ПОЛНЫЙ ПИНГ ВСЕХ УЗЛОВ С РЕАЛЬНЫМ TCP ----------
  app.post('/api/vpn-profiles/:id/ping', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = Number(req.params.id);
    const row = db
      .prepare(`SELECT * FROM vpn_profiles WHERE id = ? AND user_id = ?`)
      .get(id, userId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'VPN-профиль не найден' });
      return;
    }
    const probe = await probeVpnEndpoint(String(row.host), Number(row.port || 443), 4);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE vpn_profiles SET status = ?, latency_ms = ?, last_latency_all = ?, last_checked_at = ? WHERE id = ?`
    ).run(probe.status, probe.latency_ms, probe.latency_all, now, id);

    const updated = db.prepare(`SELECT * FROM vpn_profiles WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >;
    res.json({ profile: boolize(updated), samples: probe.samples });
  });
}
