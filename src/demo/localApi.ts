/**
 * Локальный «сервер» для демо-сборки в одном HTML-файле.
 * Перехватывает fetch() к /api/* и обслуживает данные из bundle-data.json,
 * чтобы приложение полностью работало без backend и без сети.
 */
import seed from './bundle-data.json';
import { parseSubscriptionText, type ParsedNode } from '../lib/subscriptionParser';
import { isNativeApp, mapLimit, probeNode } from '../lib/nativeBridge';
import { importRealSubscription } from './realSubscription';
import { encodeBase64 } from '../lib/base64';

type Row = Record<string, any>;

interface DemoState {
  user: Row;
  sites: Row[];
  scans: Row[];
  profiles: Row[];
  incidents: Row[];
  subscriptions: Row[];
}

const state: DemoState = {
  user: (seed as any).user,
  sites: JSON.parse(JSON.stringify((seed as any).sites)),
  scans: JSON.parse(JSON.stringify((seed as any).scans)),
  profiles: JSON.parse(JSON.stringify((seed as any).profiles)),
  incidents: JSON.parse(JSON.stringify((seed as any).incidents)),
  subscriptions: JSON.parse(JSON.stringify((seed as any).subscriptions)),
};

const TOKEN = 'demo-local-token';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function bootstrap() {
  return {
    user: state.user,
    token: TOKEN,
    sites: state.sites,
    scans: state.scans,
    profiles: state.profiles,
    incidents: state.incidents,
    subscriptions: state.subscriptions,
  };
}

let nextId = 100000;
const genId = () => nextId++;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ParsedNode (общий парсер) → запись профиля в локальном сторе. */
function nodeToRow(node: ParsedNode, subscriptionId: number | null, groupName: string): Row {
  const now = new Date().toISOString();
  return {
    id: genId(),
    user_id: state.user.id,
    subscription_id: subscriptionId,
    group_name: groupName,
    name: node.name,
    protocol: node.protocol,
    location: node.location,
    country_code: node.country_code,
    host: node.host,
    port: node.port,
    provider: node.provider,
    dpi_resistance: node.dpi_resistance,
    whitelist_bypass: node.whitelist_bypass,
    status: 'unknown',
    latency_ms: null,
    uptime_pct: 100,
    is_primary: false,
    notes: '',
    raw_link: node.raw_link,
    last_checked_at: null,
    created_at: now,
  };
}

async function handle(path: string, method: string, body: any): Promise<Response> {
  const [rawPath, rawQuery = ''] = path.split('?');
  const clean = rawPath.replace(/^\/api/, '');
  const parts = clean.split('/').filter(Boolean); // ['sites', '12']

  // ---------- AUTH ----------
  if (clean === '/auth/me' || clean === '/auth/login' || clean === '/auth/register' || clean === '/auth/demo') {
    await sleep(200);
    if (clean === '/auth/login' || clean === '/auth/register') {
      if (body?.email) state.user = { ...state.user, email: String(body.email) };
      if (body?.name) state.user = { ...state.user, name: String(body.name) };
      if (body?.region) state.user = { ...state.user, region: String(body.region) };
      if (body?.carrier) state.user = { ...state.user, carrier: String(body.carrier) };
    }
    return json(bootstrap());
  }

  if (clean === '/auth/logout') return json({ ok: true });

  if (clean === '/auth/profile') {
    state.user = {
      ...state.user,
      ...(body?.name ? { name: String(body.name) } : {}),
      ...(body?.region ? { region: String(body.region) } : {}),
      ...(body?.carrier ? { carrier: String(body.carrier) } : {}),
    };
    return json({ user: state.user });
  }

  // ---------- ДЕМО-ПОДПИСКА (тот же формат, что отдаёт сервер) ----------
  if (clean === '/sample-subscription') {
    const nodes = [
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@aeza.net:443?security=reality&sni=www.microsoft.com&fp=chrome&type=tcp&flow=xtls-rprx-vision#%F0%9F%87%B3%F0%9F%87%B1%20Амстердам%20•%20Reality',
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@upcloud.com:443?security=reality&sni=cloudflare.com&fp=chrome&type=tcp#%F0%9F%87%AB%F0%9F%87%AE%20Хельсинки%20•%20Reality',
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@hetzner.com:8443?security=tls&sni=hetzner.com&type=grpc#%F0%9F%87%A9%F0%9F%87%AA%20Франкфурт%20•%20gRPC',
      'vless://8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc@selectel.ru:443?security=reality&sni=gosuslugi.ru&fp=chrome&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20RU-каскад%20(Анти-белый%20список)',
      'trojan://demo-pass-2026@bahnhof.net:443?security=tls&sni=bahnhof.net#%F0%9F%87%B8%F0%9F%87%AA%20Стокгольм%20•%20Trojan',
      'hysteria2://demo-pass-2026@leaseweb.com:443?sni=leaseweb.com#%F0%9F%87%B3%F0%9F%87%B1%20Амстердам%20•%20Hysteria2',
      'ss://YWVzLTI1Ni1nY206ZGVtby1wYXNzLTIwMjY@ovhcloud.com:8388#%F0%9F%87%B5%F0%9F%87%B1%20Варшава%20•%20Shadowsocks',
      'vmess://' +
        encodeBase64(
          JSON.stringify({
            v: '2',
            ps: 'TR Стамбул • VMess',
            add: 'digitalocean.com',
            port: '443',
            id: '8f3c1a92-1111-4a2b-9c3d-77aa10bb22cc',
            net: 'ws',
            tls: 'tls',
          })
        ),
    ];
    const body = encodeBase64(nodes.join('\n'));
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'profile-title': 'base64:' + encodeBase64('Демо-подписка ПульсСети'),
        'subscription-userinfo':
          'upload=734003200; download=2415919104; total=53687091200; expire=1798761600',
      },
    });
  }

  // ---------- NETWORK INSPECT (офлайн-эвристика) ----------
  if (clean === '/network/inspect') {
    await sleep(350);
    const tz = body?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const isRuTz = String(tz).startsWith('Europe/') || String(tz).startsWith('Asia/');
    return json({
      ip: body?.clientIp || '213.87.132.48',
      country_code: body?.cfCountry || (isRuTz ? 'RU' : 'NL'),
      country_name: body?.cfCountry === 'RU' || isRuTz ? 'Россия' : 'Нидерланды',
      region: 'Москва',
      city: body?.clientCity || 'Москва',
      isp: body?.clientIsp || 'ПАО МТС (Мобильная сеть)',
      org: '',
      asn: body?.clientAsn || 'AS8359',
      is_hosting: false,
      is_proxy: false,
      is_mobile: true,
      vpn_detected: false,
      vpn_confidence: 'none',
      vpn_reasons: [],
      webrtc_ips: [],
    });
  }

  // ---------- СЕРВЕРНЫЙ РЕЛЕЙ ЗАМЕРОВ ----------
  if (clean === '/net/probe') {
    await sleep(400);
    return json({ ok: true, http_status: 200, latency_ms: 480, reason: 'demo' });
  }

  // ---------- SITES ----------
  if (parts[0] === 'sites') {
    if (parts.length === 1 && method === 'GET') return json({ sites: state.sites });

    if (parts.length === 1 && method === 'POST') {
      const site = {
        id: genId(),
        user_id: state.user.id,
        name: body?.name || 'Новый сайт',
        domain: body?.domain || 'example.com',
        probe_url: body?.probe_url || `https://${body?.domain || 'example.com'}/favicon.ico`,
        category: body?.category || 'custom',
        marker_role: body?.marker_role || 'global_neutral',
        accessibility: 'ok',
        blocked_since: null,
        enabled: 1,
        last_status: 'unknown',
        last_latency_ms: null,
        last_checked_at: null,
        description: body?.description || '',
        created_at: new Date().toISOString(),
      };
      state.sites = [site, ...state.sites];
      await sleep(180);
      return json({ site }, 201);
    }

    if (parts[0] === 'sites' && parts[1] === 'reset') {
      state.sites = JSON.parse(JSON.stringify((seed as any).sites));
      await sleep(300);
      return json({ sites: state.sites });
    }

    const id = Number(parts[1]);
    if (parts.length === 2 && method === 'PATCH') {
      state.sites = state.sites.map((s) => (s.id === id ? { ...s, ...body } : s));
      await sleep(140);
      return json({ site: state.sites.find((s) => s.id === id) });
    }
    if (parts.length === 2 && method === 'DELETE') {
      state.sites = state.sites.filter((s) => s.id !== id);
      await sleep(140);
      return json({ ok: true });
    }
  }

  // ---------- SCANS ----------
  if (parts[0] === 'scans') {
    if (parts.length === 1 && method === 'GET') return json({ scans: state.scans });
    if (parts.length === 1 && method === 'POST') {
      const scan = {
        ...body,
        id: genId(),
        user_id: state.user.id,
        vpn_detected: Boolean(body?.vpn_detected),
        pinned: false,
        created_at: new Date().toISOString(),
      };
      state.scans = [scan, ...state.scans].slice(0, 100);
      state.sites = state.sites.map((s) => {
        const hit = (body?.results || []).find((r: any) => r.site_id === s.id);
        return hit
          ? { ...s, last_status: hit.status, last_latency_ms: hit.latency_ms, last_checked_at: scan.created_at }
          : s;
      });
      await sleep(260);
      return json({ scan }, 201);
    }
    const id = Number(parts[1]);
    if (method === 'PATCH') {
      state.scans = state.scans.map((s) => (s.id === id ? { ...s, ...body } : s));
      await sleep(120);
      return json({ scan: state.scans.find((s) => s.id === id) });
    }
    if (method === 'DELETE') {
      state.scans = state.scans.filter((s) => s.id !== id);
      await sleep(120);
      return json({ ok: true });
    }
  }

  // ---------- VPN PROFILES ----------
  if (parts[0] === 'vpn-profiles') {
    if (parts.length === 1 && method === 'GET') return json({ profiles: state.profiles });

    if (parts[1] === 'import' && method === 'POST') {
      await sleep(320);
      const text = String(body?.text || '');
      const parsed = parseSubscriptionText(text, 'Импорт вручную');
      const imported = parsed.nodes.map((n) => nodeToRow(n, null, 'Импорт вручную'));
      state.profiles = [...imported, ...state.profiles];
      return json({
        imported: imported.length,
        profiles: state.profiles,
        preview: imported.slice(0, 40).map((p) => ({
          name: p.name,
          protocol: p.protocol,
          host: p.host,
          port: p.port,
          location: p.location,
          country_code: p.country_code,
        })),
      }, 201);
    }

    if (parts[1] === 'check-all' && method === 'POST') {
      if (isNativeApp()) {
        // Реальная проверка: TLS-хендшейк до host:port каждого узла, 8 параллельно.
        const checked = await mapLimit(state.profiles, 8, async (p) => {
          const probe = await probeNode(String(p.host), Number(p.port || 443));
          return {
            ...p,
            status: probe.status,
            latency_ms: probe.latencyMs,
            notes: probe.reason || '',
            last_checked_at: new Date().toISOString(),
          };
        });
        state.profiles = checked;
        return json({ profiles: state.profiles });
      }
      await sleep(900);
      state.profiles = state.profiles.map((p) => ({
        ...p,
        status: p.status === 'blocked' ? 'blocked' : 'online',
        latency_ms: p.latency_ms ?? 60,
        last_checked_at: new Date().toISOString(),
      }));
      return json({ profiles: state.profiles });
    }

    if (parts.length === 1 && method === 'POST') {
      await sleep(400);
      const profile = {
        id: genId(),
        user_id: state.user.id,
        subscription_id: null,
        group_name: '',
        name: body?.name || 'Новый узел',
        protocol: body?.protocol || 'VLESS + Reality',
        location: body?.location || 'Амстердам, Нидерланды',
        country_code: body?.country_code || 'NL',
        host: body?.host || 'example.com',
        port: Number(body?.port || 443),
        provider: body?.provider || '',
        dpi_resistance: body?.dpi_resistance || 'high',
        whitelist_bypass: Boolean(body?.whitelist_bypass),
        status: 'online',
        latency_ms: 55,
        uptime_pct: 100,
        is_primary: Boolean(body?.is_primary),
        notes: body?.notes || '',
        raw_link: '',
        last_checked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      if (profile.is_primary) {
        state.profiles = state.profiles.map((p) => ({ ...p, is_primary: false }));
      }
      state.profiles = [profile, ...state.profiles];
      return json({ profile }, 201);
    }

    const id = Number(parts[1]);
    if (parts[2] === 'check' && method === 'POST') {
      if (isNativeApp()) {
        const target = state.profiles.find((x) => x.id === id);
        if (target) {
          const probe = await probeNode(String(target.host), Number(target.port || 443));
          state.profiles = state.profiles.map((p) =>
            p.id === id
              ? {
                  ...p,
                  status: probe.status,
                  latency_ms: probe.latencyMs,
                  notes: probe.reason || '',
                  last_checked_at: new Date().toISOString(),
                }
              : p
          );
        }
        return json({ profile: state.profiles.find((p) => p.id === id) });
      }
      await sleep(420);
      state.profiles = state.profiles.map((p) =>
        p.id === id
          ? { ...p, status: 'online', latency_ms: 50 + Math.round(Math.random() * 120), last_checked_at: new Date().toISOString() }
          : p
      );
      return json({ profile: state.profiles.find((p) => p.id === id) });
    }
    if (parts[2] === 'ping' && method === 'POST') {
      if (isNativeApp()) {
        const target = state.profiles.find((x) => x.id === id);
        if (!target) return json({ error: 'Узел не найден' }, 404);
        const samples: number[] = [];
        let last = await probeNode(String(target.host), Number(target.port || 443));
        if (last.latencyMs != null) samples.push(last.latencyMs);
        for (let i = 0; i < 2; i++) {
          const again = await probeNode(String(target.host), Number(target.port || 443));
          if (again.latencyMs != null) samples.push(again.latencyMs);
          last = again;
        }
        state.profiles = state.profiles.map((p) =>
          p.id === id
            ? {
                ...p,
                status: last.status,
                latency_ms: samples.length
                  ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
                  : null,
                last_latency_all: samples.length ? Math.max(...samples) : null,
                notes: last.reason || '',
                last_checked_at: new Date().toISOString(),
              }
            : p
        );
        return json({ profile: state.profiles.find((p) => p.id === id), samples });
      }
      await sleep(520);
      const samples = [40, 52, 47].map((v) => v + Math.round(Math.random() * 30));
      state.profiles = state.profiles.map((p) =>
        p.id === id ? { ...p, status: 'online', latency_ms: samples[0], last_latency_all: Math.max(...samples) } : p
      );
      return json({ profile: state.profiles.find((p) => p.id === id), samples });
    }
    if (parts[2] === 'qr') {
      const p = state.profiles.find((x) => x.id === id);
      await sleep(150);
      return json({ ok: true, target: p?.raw_link || `vpn://${p?.host}:${p?.port}` });
    }
    if (parts.length === 2 && method === 'PATCH') {
      if (body?.is_primary) {
        state.profiles = state.profiles.map((p) => ({ ...p, is_primary: p.id === id }));
      }
      state.profiles = state.profiles.map((p) => (p.id === id ? { ...p, ...body } : p));
      await sleep(150);
      return json({ profile: state.profiles.find((p) => p.id === id) });
    }
    if (parts.length === 2 && method === 'DELETE') {
      state.profiles = state.profiles.filter((p) => p.id !== id);
      await sleep(150);
      return json({ ok: true });
    }
  }

  // ---------- VPN SUBSCRIPTIONS ----------
  if (parts[0] === 'vpn-subscriptions') {
    if (parts.length === 1 && method === 'GET') return json({ subscriptions: state.subscriptions });

    if (parts.length === 1 && method === 'POST') {
      const url = String(body?.url || '').trim();

      // В APK запрос к серверу подписки идёт нативным HTTP (без CORS) и парсится
      // общим модулем — так импортируются все узлы, а не только демо-набор.
      // В APK — только настоящие данные: любые демо-узлы здесь были бы обманом.
      // В браузере тоже пробуем настоящий импорт (CORS обычно не мешает), а запасной
      // демо-набор показываем лишь когда ссылка недоступна из предпросмотра.
      if (/^https?:\/\//i.test(url)) {
        try {
          const real = await importRealSubscription(url);
          const subId = genId();
          const name = String(body?.name || real.title || 'Моя подписка').trim();
          const sub = {
            id: subId,
            user_id: state.user.id,
            name,
            url,
            format: real.format,
            provider: '',
            auto_update: body?.auto_update !== false,
            update_interval_hours: Number(body?.update_interval_hours || 12),
            last_synced_at: new Date().toISOString(),
            last_sync_status: 'ok',
            last_sync_message: `Импортировано серверов: ${real.nodes.length}`,
            traffic_used_bytes: real.trafficUsed,
            traffic_total_bytes: real.trafficTotal,
            expires_on: real.expiresOn,
            node_count: real.nodes.length,
            created_at: new Date().toISOString(),
          };
          const nodes = real.nodes.map((n) => nodeToRow(n, subId, name));
          state.subscriptions = [sub, ...state.subscriptions];
          state.profiles = [...nodes, ...state.profiles];
          return json({
            subscription: sub,
            profiles: state.profiles,
            imported: nodes.length,
            online: 0,
          }, 201);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Не удалось загрузить подписку';
          if (isNativeApp()) return json({ error: message }, 502);
          // Браузерный предпросмотр: честно помечаем подписку как демонстрационную.
          const subId = genId();
          const demo = demoNodesFallback(body, state, subId, message);
          state.subscriptions = [demo.sub, ...state.subscriptions];
          state.profiles = [...demo.nodes, ...state.profiles];
          return json(
            {
              subscription: demo.sub,
              profiles: state.profiles,
              imported: demo.nodes.length,
              online: demo.nodes.filter((n) => n.status === 'online').length,
            },
            201
          );
        }
      }

      await sleep(1100);
      const demoNodes = [
        { name: '🇳🇱 Амстердам • Reality', proto: 'VLESS + Reality', loc: 'Нидерланды', cc: 'NL', host: 'aeza.net', port: 443, dpi: 'high' },
        { name: '🇫🇮 Хельсинки • Reality', proto: 'VLESS + Reality', loc: 'Финляндия', cc: 'FI', host: 'upcloud.com', port: 443, dpi: 'high' },
        { name: '🇩🇪 Франкфурт • gRPC', proto: 'VLESS', loc: 'Германия', cc: 'DE', host: 'hetzner.com', port: 8443, dpi: 'high' },
        { name: '🇷🇺 RU-каскад (Анти-белый список)', proto: 'VLESS + Reality', loc: 'Россия', cc: 'RU', host: 'selectel.ru', port: 443, dpi: 'high' },
        { name: '🇸🇪 Стокгольм • Trojan', proto: 'Trojan-gRPC', loc: 'Швеция', cc: 'SE', host: 'bahnhof.net', port: 443, dpi: 'high' },
        { name: '🇳🇱 Амстердам • Hysteria2', proto: 'Hysteria2', loc: 'Нидерланды', cc: 'NL', host: 'leaseweb.com', port: 443, dpi: 'high' },
        { name: '🇵🇱 Варшава • Shadowsocks', proto: 'Shadowsocks-2022', loc: 'Польша', cc: 'PL', host: 'ovhcloud.com', port: 8388, dpi: 'medium' },
        { name: '🇹🇷 Стамбул • VMess', proto: 'VMess', loc: 'Турция', cc: 'TR', host: 'digitalocean.com', port: 443, dpi: 'medium' },
      ];
      const subId = genId();
      const sub = {
        id: subId,
        user_id: state.user.id,
        name: body?.name || 'Демо-подписка',
        url: body?.url || 'https://example.com/sub',
        format: 'base64',
        provider: '',
        auto_update: true,
        update_interval_hours: Number(body?.update_interval_hours || 12),
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'ok',
        last_sync_message: `Импортировано серверов: ${demoNodes.length}`,
        traffic_used_bytes: 3149922304,
        traffic_total_bytes: 53687091200,
        expires_on: new Date(Date.now() + 90 * 864e5).toISOString(),
        node_count: demoNodes.length,
        created_at: new Date().toISOString(),
      };
      const nodes = demoNodes.map((n, i) => ({
        id: genId(),
        user_id: state.user.id,
        subscription_id: subId,
        group_name: sub.name,
        name: n.name,
        protocol: n.proto,
        location: n.loc,
        country_code: n.cc,
        host: n.host,
        port: n.port,
        provider: '',
        dpi_resistance: n.dpi,
        whitelist_bypass: n.cc === 'RU',
        status: i < 6 ? 'online' : 'degraded',
        latency_ms: 45 + i * 17,
        uptime_pct: 99,
        is_primary: false,
        notes: '',
        raw_link: `vless://demo@${n.host}:${n.port}#${encodeURIComponent(n.name)}`,
        last_checked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }));
      state.subscriptions = [sub, ...state.subscriptions];
      state.profiles = [...nodes, ...state.profiles];
      return json({
        subscription: sub,
        profiles: state.profiles,
        imported: demoNodes.length,
        online: nodes.filter((n) => n.status === 'online').length,
      }, 201);
    }

    const id = Number(parts[1]);
    if (parts[2] === 'sync' && method === 'POST') {
      const target = state.subscriptions.find((s) => s.id === id);

      if (isNativeApp() && target && /^https?:\/\//i.test(String(target.url))) {
        try {
          const real = await importRealSubscription(String(target.url));
          state.profiles = state.profiles.filter((p) => p.subscription_id !== id);
          const nodes = real.nodes.map((n) => nodeToRow(n, id, String(target.name)));
          state.profiles = [...nodes, ...state.profiles];
          state.subscriptions = state.subscriptions.map((s) =>
            s.id === id
              ? {
                  ...s,
                  format: real.format,
                  last_synced_at: new Date().toISOString(),
                  last_sync_status: 'ok',
                  last_sync_message: `Импортировано серверов: ${nodes.length}`,
                  traffic_used_bytes: real.trafficUsed || s.traffic_used_bytes,
                  traffic_total_bytes: real.trafficTotal || s.traffic_total_bytes,
                  expires_on: real.expiresOn || s.expires_on,
                  node_count: nodes.length,
                }
              : s
          );
          return json({
            subscription: state.subscriptions.find((s) => s.id === id),
            profiles: state.profiles,
            imported: nodes.length,
          });
        } catch (err) {
          state.subscriptions = state.subscriptions.map((s) =>
            s.id === id
              ? {
                  ...s,
                  last_sync_status: 'error',
                  last_sync_message:
                    err instanceof Error ? err.message : 'Не удалось обновить подписку',
                }
              : s
          );
          return json(
            { error: err instanceof Error ? err.message : 'Не удалось обновить подписку' },
            502
          );
        }
      }

      await sleep(900);
      state.subscriptions = state.subscriptions.map((s) =>
        s.id === id ? { ...s, last_synced_at: new Date().toISOString(), last_sync_status: 'ok', last_sync_message: 'Серверов: ' + s.node_count } : s
      );
      return json({
        subscription: state.subscriptions.find((s) => s.id === id),
        profiles: state.profiles,
        imported: state.subscriptions.find((s) => s.id === id)?.node_count || 0,
      });
    }
    if (parts.length === 2 && method === 'PATCH') {
      state.subscriptions = state.subscriptions.map((s) => (s.id === id ? { ...s, ...body } : s));
      await sleep(140);
      return json({ subscription: state.subscriptions.find((s) => s.id === id) });
    }
    if (parts.length === 2 && method === 'DELETE') {
      const removed = state.profiles.filter((p) => p.subscription_id === id).length;
      state.profiles = state.profiles.filter((p) => p.subscription_id !== id);
      state.subscriptions = state.subscriptions.filter((s) => s.id !== id);
      await sleep(160);
      return json({ ok: true, removed_nodes: removed });
    }
  }

  // ---------- INCIDENTS ----------
  if (parts[0] === 'incidents') {
    if (parts.length === 1 && method === 'GET') return json({ incidents: state.incidents });

    if (parts.length === 1 && method === 'POST') {
      const incident = {
        id: genId(),
        user_id: state.user.id,
        author_name: state.user.name,
        region: body?.region || state.user.region,
        carrier: body?.carrier || state.user.carrier,
        incident_type: body?.incident_type || 'whitelist',
        severity: body?.severity || 'high',
        status: 'active',
        title: body?.title || 'Новый сбой',
        description: body?.description || '',
        upvotes: 1,
        ru_sites_ok: Boolean(body?.ru_sites_ok),
        foreign_sites_ok: Boolean(body?.foreign_sites_ok),
        user_upvoted: true,
        is_owner: true,
        created_at: new Date().toISOString(),
      };
      state.incidents = [incident, ...state.incidents];
      await sleep(200);
      return json({ incident }, 201);
    }

    const id = Number(parts[1]);
    if (parts[2] === 'upvote' && method === 'POST') {
      state.incidents = state.incidents.map((i) =>
        i.id === id
          ? {
              ...i,
              upvotes: i.user_upvoted ? Math.max(0, i.upvotes - 1) : i.upvotes + 1,
              user_upvoted: !i.user_upvoted,
            }
          : i
      );
      await sleep(120);
      return json({ incident: state.incidents.find((i) => i.id === id) });
    }
    if (parts.length === 2 && method === 'PATCH') {
      state.incidents = state.incidents.map((i) => (i.id === id ? { ...i, ...body } : i));
      await sleep(140);
      return json({ incident: state.incidents.find((i) => i.id === id) });
    }
    if (parts.length === 2 && method === 'DELETE') {
      state.incidents = state.incidents.filter((i) => i.id !== id);
      await sleep(140);
      return json({ ok: true });
    }
  }

  return json({ error: `Демо-режим: эндпоинт ${clean} не реализован` }, 404);
}

const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`)) {
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    const method = (init?.method || 'GET').toUpperCase();
    let body: any = null;
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    return handle(path, method, body);
  }
  return realFetch(input, init);
};


/**
 * Демо-набор узлов для браузерного предпросмотра.
 * Используется только когда в APK-подобном окружении нет сети — сам APK этот путь
 * не проходит: там ошибка показывается пользователю как есть.
 */
function demoNodesFallback(
  body: Row | undefined,
  state: DemoState,
  subId: number,
  reason: string
): { sub: Row; nodes: Row[] } {
  const specs = [
    ['Амстердам • Reality', 'VLESS + Reality', 'Нидерланды', 'NL', 'aeza.net', 443],
    ['Хельсинки • Reality', 'VLESS + Reality', 'Финляндия', 'FI', 'upcloud.com', 443],
    ['Франкфурт • gRPC', 'VLESS', 'Германия', 'DE', 'hetzner.com', 8443],
    ['RU-каскад', 'VLESS + Reality', 'Россия', 'RU', 'selectel.ru', 443],
    ['Стокгольм • Trojan', 'Trojan-gRPC', 'Швеция', 'SE', 'bahnhof.net', 443],
    ['Варшава • Shadowsocks', 'Shadowsocks-2022', 'Польша', 'PL', 'ovhcloud.com', 8388],
  ] as const;
  const sub: Row = {
    id: subId,
    user_id: state.user.id,
    name: body?.name || 'Демо-подписка',
    url: body?.url || 'https://example.com/sub',
    format: 'base64',
    provider: '',
    auto_update: body?.auto_update !== false,
    update_interval_hours: Number(body?.update_interval_hours || 12),
    last_synced_at: new Date().toISOString(),
    last_sync_status: 'ok',
    last_sync_message: `Демо-узлы: сеть недоступна (${reason.slice(0, 60)})`,
    traffic_used_bytes: 3149922304,
    traffic_total_bytes: 53687091200,
    expires_on: new Date(Date.now() + 60 * 864e5).toISOString(),
    node_count: specs.length,
    created_at: new Date().toISOString(),
  };
  const nodes: Row[] = specs.map(([name, proto, loc, cc, host, port], i) => ({
    id: genId(),
    user_id: state.user.id,
    subscription_id: subId,
    group_name: sub.name,
    name,
    protocol: proto,
    location: loc,
    country_code: cc,
    host,
    port,
    provider: '',
    dpi_resistance: 'high',
    whitelist_bypass: cc === 'RU',
    status: i < 4 ? 'online' : 'degraded',
    latency_ms: 48 + i * 19,
    uptime_pct: 99,
    is_primary: false,
    notes: '',
    raw_link: `vless://demo@${host}:${port}#${encodeURIComponent(name)}`,
    last_checked_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  }));
  return { sub, nodes };
}
