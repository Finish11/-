import net from 'node:net';
import dns from 'node:dns/promises';
import type { Request } from 'express';

export interface ClientConnectionInfo {
  ip: string;
  country_code: string;
  country_name: string;
  region: string;
  city: string;
  isp: string;
  org: string;
  asn: string;
  is_hosting: boolean;
  is_proxy: boolean;
  is_mobile: boolean;
  vpn_detected: boolean;
  vpn_confidence: 'high' | 'medium' | 'none';
  vpn_reasons: string[];
}

const KNOWN_VPN_KEYWORDS = [
  'hetzner', 'digitalocean', 'choopa', 'vultr', 'linode', 'akamai', 'ovh',
  'm247', 'datacamp', 'cdn77', 'cloudflare', 'warp', 'aeza', 'pq.hosting',
  'stark industries', 'hostkey', 'contabo', 'leaseweb', 'scaleway', 'gcore',
  'mullvad', 'proton', 'privax', 'nord', 'expressvpn', 'surfshark', 'melbicom',
  'worldstream', 'serverius', 'timeweb', 'firstvds', 'selectel', 'hostroyale',
  'kamatera', 'upcloud', 'oracle cloud', 'amazon', 'google cloud', 'microsoft corporation'
];

const RU_TIMEZONES = new Set([
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Kirov',
  'Europe/Volgograd',
  'Europe/Astrakhan',
  'Europe/Saratov',
  'Europe/Ulyanovsk',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Barnaul',
  'Asia/Tomsk',
  'Asia/Novokuznetsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Chita',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Sakhalin',
  'Asia/Kamchatka',
]);

const COUNTRY_NAMES_RU: Record<string, string> = {
  RU: 'Россия',
  NL: 'Нидерланды',
  DE: 'Германия',
  FI: 'Финляндия',
  US: 'США',
  GB: 'Великобритания',
  FR: 'Франция',
  SE: 'Швеция',
  LV: 'Латвия',
  LT: 'Литва',
  EE: 'Эстония',
  PL: 'Польша',
  TR: 'Турция',
  KZ: 'Казахстан',
  AM: 'Армения',
  GE: 'Грузия',
  CH: 'Швейцария',
  AT: 'Австрия',
  CZ: 'Чехия',
  SG: 'Сингапур',
  JP: 'Япония',
  AE: 'ОАЭ',
};

export function extractClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0].trim();
    if (first && !isPrivateIp(first)) return first;
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim() && !isPrivateIp(realIp.trim())) {
    return realIp.trim();
  }
  const remote = req.socket.remoteAddress || '';
  const cleaned = remote.replace(/^::ffff:/, '');
  return isPrivateIp(cleaned) ? '' : cleaned;
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  return false;
}

export async function inspectClientConnection(
  req: Request,
  clientHints?: {
    clientIp?: string;
    timezone?: string;
    language?: string;
    cfCountry?: string;
    cfWarp?: string;
    clientIsp?: string;
    clientAsn?: string;
    clientCity?: string;
  }
): Promise<ClientConnectionInfo> {
  const ipToCheck = (clientHints?.clientIp && !isPrivateIp(clientHints.clientIp))
    ? clientHints.clientIp
    : extractClientIp(req);

  let country_code = clientHints?.cfCountry || 'RU';
  let country_name = COUNTRY_NAMES_RU[country_code] || country_code;
  let region = '';
  let city = clientHints?.clientCity || '';
  let isp = clientHints?.clientIsp || 'Определение провайдера...';
  let org = '';
  let asn = clientHints?.clientAsn || '';
  let is_hosting = false;
  let is_proxy = false;
  let is_mobile = false;
  let resolvedIp = ipToCheck || '0.0.0.0';

  if (ipToCheck) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2800);
      const url = `http://ip-api.com/json/${encodeURIComponent(ipToCheck)}?fields=status,country,countryCode,regionName,city,isp,org,as,mobile,proxy,hosting,query&lang=ru`;
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        if (data.status === 'success') {
          resolvedIp = String(data.query || ipToCheck);
          country_code = String(data.countryCode || country_code);
          country_name = COUNTRY_NAMES_RU[country_code] || String(data.country || country_code);
          region = String(data.regionName || '');
          city = String(data.city || city);
          isp = String(data.isp || isp);
          org = String(data.org || '');
          asn = String(data.as || asn).split(' ')[0] || '';
          is_hosting = Boolean(data.hosting);
          is_proxy = Boolean(data.proxy);
          is_mobile = Boolean(data.mobile);
        }
      }
    } catch {
      // Fallback to client hints if ip-api is unreachable
    }
  }

  const reasons: string[] = [];
  const lowerIspOrg = `${isp} ${org} ${asn}`.toLowerCase();
  const matchedKeyword = KNOWN_VPN_KEYWORDS.find((kw) => lowerIspOrg.includes(kw));

  if (clientHints?.cfWarp === 'on' || clientHints?.cfWarp === 'plus') {
    reasons.push('Активен туннель Cloudflare WARP');
  }
  if (is_proxy) {
    reasons.push('IP-адрес отмечен в базах как VPN / прокси-узел');
  }
  if (is_hosting) {
    reasons.push(`Трафик идёт через серверный дата-центр (${isp || org})`);
  }
  if (matchedKeyword && !reasons.some((r) => r.includes('дата-центр'))) {
    reasons.push(`Обнаружен хостинг/VPN провайдер: ${isp || org}`);
  }

  const tz = clientHints?.timezone || '';
  const isRuTimezone = RU_TIMEZONES.has(tz);
  if (isRuTimezone && country_code && country_code !== 'RU') {
    reasons.push(
      `Несовпадение геолокации: часовой пояс РФ (${tz}), а внешний IP в стране ${country_name} (${country_code})`
    );
  }

  let vpn_confidence: 'high' | 'medium' | 'none' = 'none';
  if (
    is_proxy ||
    is_hosting ||
    clientHints?.cfWarp === 'on' ||
    clientHints?.cfWarp === 'plus' ||
    (isRuTimezone && country_code !== 'RU')
  ) {
    vpn_confidence = reasons.length >= 2 || is_hosting || is_proxy ? 'high' : 'medium';
  } else if (matchedKeyword) {
    vpn_confidence = 'medium';
  }

  return {
    ip: resolvedIp,
    country_code,
    country_name,
    region,
    city,
    isp,
    org,
    asn,
    is_hosting,
    is_proxy,
    is_mobile,
    vpn_detected: vpn_confidence !== 'none',
    vpn_confidence,
    vpn_reasons: reasons,
  };
}

const DEMO_HOST_BEHAVIOR: Record<string, { status: 'online' | 'degraded' | 'blocked'; basePing: number }> = {
  'nl-edge-01.aeza-node.net': { status: 'online', basePing: 62 },
  'ru-bridge-msk.yc-relay.ru': { status: 'online', basePing: 46 },
  'fi-awg.hetzner-gw.org': { status: 'online', basePing: 55 },
  'de-quic-04.fastnode.eu': { status: 'degraded', basePing: 184 },
  '185.212.141.90': { status: 'blocked', basePing: 0 },
};

export interface VpnProbeResult {
  status: 'online' | 'degraded' | 'blocked';
  /** Средний RTT по успешным TCP-хендшейкам */
  latency_ms: number | null;
  /** Все замеры по 3 попыткам (как в реальных клиентах: Happ, Streisand, v2rayN) */
  samples: Array<number | null>;
  /** Максимальный RTT — грубый индикатор шейпинга */
  latency_all: number | null;
  /** Сколько TCP-соединений из 3 установилось */
  success_rate: number;
  error?: string;
}

const dnsCache = new Map<string, { at: number; address: string | null }>();

/** Кэшируем DNS на 10 минут: без этого 8 узлов × 3 попытки дают ложные +200 мс. */
async function resolveCached(host: string): Promise<string | null> {
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < 600_000) return cached.address;
  let address: string | null = null;
  try {
    const info = await dns.lookup(host);
    address = info.address;
  } catch {
    address = null;
  }
  dnsCache.set(host, { at: Date.now(), address });
  return address;
}

/** Ограничитель параллелизма, чтобы замеры не мешали друг другу. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function tcpHandshake(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (ms: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(Math.max(1, Math.round(performance.now() - start))));
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
    try {
      socket.connect(port || 443, host);
    } catch {
      finish(null);
    }
  });
}

/**
 * Пинг VPN-узла как в настоящих клиентах: 3 TCP-хендшейка,
 * среднее по успешным + доля успешных подключений.
 */
export async function probeVpnEndpoint(
  host: string,
  port: number,
  attempts = 3
): Promise<VpnProbeResult> {
  const cleanHost = host.trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const demo = DEMO_HOST_BEHAVIOR[cleanHost];
  if (demo) {
    await new Promise((r) => setTimeout(r, 240));
    if (demo.status === 'blocked') {
      return {
        status: 'blocked',
        latency_ms: null,
        samples: [null, null, null],
        latency_all: null,
        success_rate: 0,
        error: 'TCP handshake timeout (ТСПУ / блокировка протокола)',
      };
    }
    const samples = Array.from({ length: attempts }, () =>
      Math.max(12, demo.basePing + Math.floor(Math.random() * 18) - 8)
    );
    const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    return {
      status: demo.status === 'degraded' || avg > 600 ? 'degraded' : 'online',
      latency_ms: avg,
      samples,
      latency_all: Math.max(...samples),
      success_rate: 1,
    };
  }

  const address = await resolveCached(cleanHost);
  if (!address) {
    return {
      status: 'blocked',
      latency_ms: null,
      samples: Array.from({ length: attempts }, () => null),
      latency_all: null,
      success_rate: 0,
      error: 'DNS не разрешается (домен недоступен или заблокирован на уровне резолвера)',
    };
  }

  const samples: Array<number | null> = [];
  for (let i = 0; i < attempts; i += 1) {
    samples.push(await tcpHandshake(address, port || 443, 3200));
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 60));
  }
  const okSamples = samples.filter((s): s is number => typeof s === 'number');
  const success_rate = okSamples.length / samples.length;

  if (okSamples.length === 0) {
    return {
      status: 'blocked',
      latency_ms: null,
      samples,
      latency_all: null,
      success_rate: 0,
      error: 'TCP-соединение не установлено (таймаут/отказ)',
    };
  }

  const avg = Math.round(okSamples.reduce((a, b) => a + b, 0) / okSamples.length);
  const worst = Math.max(...okSamples);

  if (success_rate < 0.5 || avg > 900) {
    return {
      status: 'blocked',
      latency_ms: null,
      samples,
      latency_all: worst,
      success_rate,
      error: 'Нестабильное TCP-соединение — вероятен шейпинг или блокировка порта',
    };
  }

  const status: VpnProbeResult['status'] =
    avg > 320 || worst > avg * 2.5 ? 'degraded' : 'online';

  return {
    status,
    latency_ms: avg,
    samples,
    latency_all: worst,
    success_rate,
  };
}

const siteProbeCache = new Map<string, { at: number; result: { ok: boolean; http_status: number | null; latency_ms: number | null; reason: string } }>();

/**
 * Серверный замер сайта (HEAD/GET с таймаутом). Кэшируем на 45 секунд,
 * чтобы полный скан из 75 сайтов не задолбал внешние ресурсы.
 */
export async function tcpSiteProbe(
  url: string
): Promise<{ ok: boolean; http_status: number | null; latency_ms: number | null; reason: string }> {
  const cached = siteProbeCache.get(url);
  if (cached && Date.now() - cached.at < 45_000) return cached.result;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const started = performance.now();
  let result: { ok: boolean; http_status: number | null; latency_ms: number | null; reason: string };
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseNet/1.0; +https://pulsenet.local)' },
    });
    const latency_ms = Math.max(1, Math.round(performance.now() - started));
    result = {
      ok: res.status < 400,
      http_status: res.status,
      latency_ms,
      reason: res.status < 400 ? 'ok' : `http_${res.status}`,
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    result = { ok: false, http_status: null, latency_ms: null, reason };
  } finally {
    clearTimeout(timer);
  }

  siteProbeCache.set(url, { at: Date.now(), result });
  return result;
}
