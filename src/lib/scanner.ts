import { apiFetch } from './api';

/**
 * Демо-сборка (один HTML-файл без backend) собирается с VITE_DEMO=1.
 * В ней «живые» замеры заменяются детерминированной имитацией по статусу ресурса,
 * чтобы предпросмотр работал без сети, но показывал реальную диагностику.
 */
export const IS_DEMO_BUILD =
  typeof import.meta !== 'undefined' &&
  Boolean((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DEMO);
import type {
  ClientConnectionInfo,
  ScanSiteResult,
  SimulationMode,
  Site,
  VerdictType,
  SiteBlockReason,
} from '../types';

async function fetchCloudflareTrace(): Promise<Record<string, string>> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2400);
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return {};
    const text = await res.text();
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchIpWhoIs(): Promise<Record<string, unknown>> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('https://ipwho.is/', {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return {};
    const data = (await res.json()) as Record<string, unknown>;
    return data.success ? data : {};
  } catch {
    return {};
  }
}

export async function gatherWebRtcIps(): Promise<string[]> {
  if (typeof window === 'undefined' || !window.RTCPeerConnection) return [];
  return new Promise((resolve) => {
    const ips = new Set<string>();
    let pc: RTCPeerConnection | null = null;
    const finish = () => {
      try {
        pc?.close();
      } catch {
        // ignore
      }
      resolve(Array.from(ips));
    };

    const timer = setTimeout(finish, 1400);
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pc.createDataChannel('probe');
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer);
          finish();
          return;
        }
        const cand = e.candidate.candidate || '';
        const ipMatch = cand.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/);
        if (ipMatch && ipMatch[1] && !ipMatch[1].startsWith('0.')) {
          ips.add(ipMatch[1]);
        }
      };
      pc.createOffer()
        .then((offer) => pc?.setLocalDescription(offer))
        .catch(() => {
          clearTimeout(timer);
          finish();
        });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

export async function detectCurrentConnection(
  simMode: SimulationMode = 'live'
): Promise<ClientConnectionInfo> {
  if (IS_DEMO_BUILD && simMode === 'live') {
    simMode = 'sim_whitelist';
  }
  if (simMode === 'sim_vpn') {
    await new Promise((r) => setTimeout(r, 380));
    return {
      ip: '185.236.201.74',
      country_code: 'NL',
      country_name: 'Нидерланды',
      region: 'North Holland',
      city: 'Amsterdam',
      isp: 'Aeza International Ltd',
      org: 'Aeza VPN Edge',
      asn: 'AS210644',
      is_hosting: true,
      is_proxy: true,
      is_mobile: false,
      vpn_detected: true,
      vpn_confidence: 'high',
      vpn_reasons: [
        'Трафик идёт через зарубежный дата-центр (Aeza International, Амстердам)',
        'Несовпадение геолокации: системный часовой пояс РФ, а внешний IP в Нидерландах (NL)',
      ],
      webrtc_ips: ['185.236.201.74'],
    };
  }

  if (simMode === 'sim_whitelist' || simMode === 'sim_jamming' || simMode === 'sim_dpi') {
    await new Promise((r) => setTimeout(r, 320));
    return {
      ip: simMode === 'sim_whitelist' ? '213.87.136.92' : simMode === 'sim_jamming' ? '85.26.184.41' : '95.165.114.88',
      country_code: 'RU',
      country_name: 'Россия',
      region: simMode === 'sim_whitelist' ? 'Краснодарский край' : 'Москва',
      city: simMode === 'sim_whitelist' ? 'Краснодар' : 'Москва',
      isp: simMode === 'sim_whitelist' ? 'ПАО МТС (Мобильная сеть)' : simMode === 'sim_jamming' ? 'ПАО МегаФон (LTE)' : 'ПАО Ростелеком',
      org: '',
      asn: simMode === 'sim_whitelist' ? 'AS8359' : simMode === 'sim_jamming' ? 'AS31133' : 'AS12389',
      is_hosting: false,
      is_proxy: false,
      is_mobile: simMode !== 'sim_dpi',
      vpn_detected: false,
      vpn_confidence: 'none',
      vpn_reasons: [],
      webrtc_ips: [],
    };
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const language = navigator.language || 'ru-RU';

  const [cfTrace, ipWho, webRtcIps] = await Promise.all([
    fetchCloudflareTrace(),
    fetchIpWhoIs(),
    gatherWebRtcIps(),
  ]);

  const connObj = (ipWho.connection as Record<string, unknown> | undefined) || {};
  const clientIp = String(ipWho.ip || cfTrace.ip || '');
  const cfCountry = String(cfTrace.loc || ipWho.country_code || '');
  const cfWarp = String(cfTrace.warp || 'off');
  const clientIsp = String(connObj.isp || connObj.org || '');
  const clientAsn = connObj.asn ? `AS${connObj.asn}` : '';
  const clientCity = String(ipWho.city || '');

  try {
    const serverInspected = await apiFetch<ClientConnectionInfo>('/api/network/inspect', {
      method: 'POST',
      body: JSON.stringify({
        clientIp,
        timezone,
        language,
        cfCountry,
        cfWarp,
        clientIsp,
        clientAsn,
        clientCity,
      }),
    });

    // Check split-tunneling if Cloudflare saw a different country/IP than WebRTC
    const publicRtc = webRtcIps.filter(
      (ip) =>
        !ip.startsWith('10.') &&
        !ip.startsWith('192.168.') &&
        !/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
    );
    const splitTunnel =
      publicRtc.length > 0 &&
      serverInspected.ip !== '0.0.0.0' &&
      !publicRtc.includes(serverInspected.ip);

    if (splitTunnel) {
      serverInspected.vpn_detected = true;
      serverInspected.vpn_confidence = 'high';
      serverInspected.vpn_reasons = [
        ...serverInspected.vpn_reasons,
        `WebRTC показывает отличающийся внешний IP (${publicRtc[0]}) — вероятно включён Split-Tunnel VPN / прокси в браузере`,
      ];
    }

    return {
      ...serverInspected,
      split_tunnel: splitTunnel,
      webrtc_ips: webRtcIps,
    };
  } catch {
    const isForeign = Boolean(cfCountry && cfCountry !== 'RU');
    return {
      ip: clientIp || 'Не определён',
      country_code: cfCountry || 'RU',
      country_name: cfCountry === 'RU' ? 'Россия' : cfCountry || 'Неизвестно',
      region: '',
      city: clientCity,
      isp: clientIsp || 'Текущее подключение',
      org: '',
      asn: clientAsn,
      is_hosting: false,
      is_proxy: cfWarp === 'on',
      is_mobile: false,
      vpn_detected: isForeign || cfWarp === 'on',
      vpn_confidence: isForeign || cfWarp === 'on' ? 'medium' : 'none',
      vpn_reasons: isForeign
        ? [`Внешний IP относится к стране ${cfCountry}`]
        : cfWarp === 'on'
        ? ['Активен Cloudflare WARP']
        : [],
      webrtc_ips: webRtcIps,
    };
  }
}

/**
 * Замер через Image() — не ограничен CORS/preflight и отдаёт более честный
 * RTT, чем no-cors fetch (тот отдаёт ответ из кеша/из памяти почти мгновенно).
 */
function probeWithImage(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const started = performance.now();
    const img = new Image();
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (ok) resolve(Math.max(8, Math.round(performance.now() - started)));
      else reject(new Error('probe failed'));
    };
    const timer = window.setTimeout(() => done(false), timeoutMs);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}

/** Замер через fetch: ответ пришёл (даже opaque) — значит хост доступен. */
async function probeWithFetch(url: string, timeoutMs: number): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    // ВАЖНО: для cross-origin запросов в no-cors режиме браузер не отдаёт статус,
    // поэтому любой не-throw ответ = ресурс доступен.
    await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl.signal,
    });
    return Math.max(8, Math.round(performance.now() - started));
  } finally {
    clearTimeout(timer);
  }
}

async function measureProbe(probeUrl: string, timeoutMs: number): Promise<number> {
  const sep = probeUrl.includes('?') ? '&' : '?';
  const bust = `_pn=${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const target = `${probeUrl}${sep}${bust}`;
  // fetch(mode:'no-cors') годится и для HTML-страниц, и для картинок:
  // ответ (opaque) = домен жив. Image — фолбэк на случай, если браузер
  // режет fetch сторонним CSP/расширением, но разрешает <img>.
  try {
    return await probeWithFetch(target, timeoutMs);
  } catch {
    return await probeWithImage(target, Math.min(timeoutMs, 3500));
  }
}

/**
 * Каскад замеров: если прямой замер заблокирован, пробуем через серверный
 * релей (/api/net/probe) — он ходит из российского/облачного дата-центра и
 * позволяет понять, что дело именно в сети пользователя, а не в сайте.
 */
async function probeViaServerTargets(
  site: Site,
  timeoutMs: number
): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs + 2500);
    const res = await apiFetch<{ ok: boolean; latency_ms?: number | null }>(
      '/api/net/probe',
      {
        method: 'POST',
        body: JSON.stringify({ url: site.probe_url }),
        signal: ctrl.signal,
      }
    );
    clearTimeout(timer);
    if (res.ok && typeof res.latency_ms === 'number') return res.latency_ms;
    return null;
  } catch {
    return null;
  }
}

export async function probeSingleSite(
  site: Site,
  simMode: SimulationMode = 'live'
): Promise<ScanSiteResult> {
  if (IS_DEMO_BUILD && simMode === 'live') {
    // В автономной демо-сборке сети нет — имитируем режим белых списков
    simMode = 'sim_whitelist';
  }

  if (simMode !== 'live') {
    await new Promise((r) => setTimeout(r, 45 + Math.random() * 90));
    if (simMode === 'sim_whitelist') {
      if (site.marker_role === 'ru_whitelist' || site.category === 'ru_whitelist') {
        return {
          site_id: site.id,
          name: site.name,
          domain: site.domain,
          category: site.category,
          marker_role: site.marker_role,
          status: 'ok',
          latency_ms: Math.round(28 + Math.random() * 48),
        };
      }
      return {
        site_id: site.id,
        name: site.name,
        domain: site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: 'blocked',
        latency_ms: null,
      };
    }

    if (simMode === 'sim_jamming') {
      if (site.domain === 'ya.ru') {
        return {
          site_id: site.id,
          name: site.name,
          domain: site.domain,
          category: site.category,
          marker_role: site.marker_role,
          status: 'slow',
          latency_ms: 2690,
        };
      }
      return {
        site_id: site.id,
        name: site.name,
        domain: site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: 'blocked',
        latency_ms: null,
      };
    }

    if (simMode === 'sim_dpi') {
      // Домашний интернет без VPN: нейтральные и белый список открываются,
      // режутся только сервисы из реестра РКН.
      if (site.accessibility === 'blocked') {
        return {
          site_id: site.id,
          name: site.name,
          domain: site.domain,
          category: site.category,
          marker_role: site.marker_role,
          status: 'blocked',
          latency_ms: null,
        };
      }
      if (site.accessibility === 'restricted') {
        return {
          site_id: site.id,
          name: site.name,
          domain: site.domain,
          category: site.category,
          marker_role: site.marker_role,
          status: 'slow',
          latency_ms: 1250 + Math.round(Math.random() * 800),
        };
      }
      return {
        site_id: site.id,
        name: site.name,
        domain: site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: 'ok',
        latency_ms: Math.round(30 + Math.random() * 90),
      };
    }

    if (simMode === 'sim_vpn') {
      if (site.domain === 'gosuslugi.ru') {
        return {
          site_id: site.id,
          name: site.name,
          domain: site.domain,
          category: site.category,
          marker_role: site.marker_role,
          status: 'blocked',
          latency_ms: null,
        };
      }
      return {
        site_id: site.id,
        name: site.name,
        domain: site.name === 'СберБанк' ? site.domain : site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: site.domain === 'sberbank.ru' ? 'slow' : 'ok',
        latency_ms: site.domain === 'sberbank.ru' ? 1310 : Math.round(52 + Math.random() * 82),
      };
    }
  }

  // ЖИВОЙ ЗАМЕР ИЗ БРАУЗЕРА (Image + fetch, с серверным фолбэком)
  let latency: number | null = null;
  try {
    latency = await measureProbe(site.probe_url, 4300);
  } catch {
    // Из браузера не достучались. Серверный фолбэк нужен только для сайтов,
    // которые ОБЯЗАНЫ открываться (белый список и нейтральные): для них
    // отсутствие ответа — это сигнал фильтрации, а не блокировки РКН.
    if (site.accessibility !== 'blocked') {
      const viaServer = await probeViaServerTargets(site, 3200);
      if (viaServer !== null) {
        // Сервер видит сайт, а браузер нет → домен вырезается в сети пользователя
        latency = Math.min(viaServer + 900, 4200);
      }
    }
  }

  if (latency === null) {
    return {
      site_id: site.id,
      name: site.name,
      domain: site.domain,
      category: site.category,
      marker_role: site.marker_role,
      status: 'blocked',
      latency_ms: null,
    };
  }

  return {
    site_id: site.id,
    name: site.name,
    domain: site.domain,
    category: site.category,
    marker_role: site.marker_role,
    status: latency > 1450 ? 'slow' : 'ok',
    latency_ms: latency,
  };
}

export async function runMultiSiteScan(
  sites: Site[],
  simMode: SimulationMode,
  onProgress: (done: number, total: number, latest: ScanSiteResult, partial: ScanSiteResult[]) => void,
  abortSignal?: AbortSignal
): Promise<ScanSiteResult[]> {
  const enabledSites = sites.filter((s) => Boolean(s.enabled));
  const total = enabledSites.length;
  const results: ScanSiteResult[] = new Array(total);
  let cursor = 0;
  let completed = 0;
  const concurrency = simMode === 'live' ? 12 : 8;

  async function worker() {
    while (cursor < total) {
      if (abortSignal?.aborted) return;
      const index = cursor++;
      const site = enabledSites[index];
      const res = await probeSingleSite(site, simMode);
      results[index] = res;
      completed++;
      onProgress(completed, total, res, results.filter(Boolean));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  return results.filter(Boolean);
}

export interface SiteDiagnosisItem {
  name: string;
  domain: string;
  marker_role: string;
  status: 'ok' | 'slow' | 'blocked';
  latency_ms: number | null;
  block_reason?: SiteBlockReason;
  note: string;
}

export interface ScanDiagnosis {
  ru_ok_pct: number;
  global_ok_pct: number;
  blocked_ok_pct: number;
  dpi_ok_pct: number;
  ru_total: number;
  global_total: number;
  blocked_total: number;
  whitelist_pattern: boolean;
  dpi_pattern: boolean;
  jamming_pattern: boolean;
  open_pattern: boolean;
  /** Классификация: что реально происходит по трём канонам (белый список / РКН / глушение) */
  scenario: 'whitelist' | 'dpi' | 'jamming' | 'partial' | 'open';
  highlight_ok: SiteDiagnosisItem[];
  highlight_blocked: SiteDiagnosisItem[];
  headline: string;
  details: string;
}

function classifyBase(s: Site): 'ru_whitelist' | 'global_neutral' | 'dpi_target' {
  if (s.marker_role === 'ru_whitelist' || s.category === 'ru_whitelist') return 'ru_whitelist';
  // dpi_target по маркировке; но если ресурс официально не заблокирован — это нейтральный
  if (s.marker_role === 'dpi_target') return 'dpi_target';
  return 'global_neutral';
}

/**
 * Главный диагност. Разделяет три категории ресурсов:
 *  1) БЕЛЫЙ СПИСОК РФ — перечень Минцифры (работает даже при шатдауне)
 *  2) НЕЙТРАЛЬНЫЕ — глобальные сайты, которые НЕ заблокированы в РФ (должны открываться всегда)
 *  3) ЗАБЛОКИРОВАННЫЕ РКН — YouTube, Discord, Instagram и т.д. (без VPN не работают всегда)
 * Вердикт строится на 1+2: если нейтральные массово падают, а белый список жив → белые списки.
 */
export function diagnoseScan(
  results: ScanSiteResult[],
  sitesById: Map<number, Site>,
  opts: { withVpn: boolean }
): ScanDiagnosis {
  const reachable = (r: { status: 'ok' | 'slow' | 'blocked' }) =>
    r.status === 'ok' || r.status === 'slow';

  const items: Array<SiteDiagnosisItem & { base: 'ru_whitelist' | 'global_neutral' | 'dpi_target' }> =
    results.map((r) => {
      const site = r.site_id ? sitesById.get(r.site_id) : undefined;
      const base = site ? classifyBase(site) : (r.marker_role as 'ru_whitelist' | 'global_neutral' | 'dpi_target');
      let block_reason: SiteBlockReason | undefined;
      if (!reachable(r)) {
        if (base === 'dpi_target' && site?.accessibility !== 'ok') {
          block_reason = 'rkn';
        } else if (base === 'ru_whitelist') {
          block_reason = 'network';
        } else {
          block_reason = 'unknown';
        }
      } else if (r.status === 'slow') {
        block_reason = base === 'dpi_target' ? 'throttled' : 'ok';
      }
      return {
        name: r.name,
        domain: r.domain,
        marker_role: base,
        status: r.status,
        latency_ms: r.latency_ms,
        block_reason,
        note:
          base === 'ru_whitelist'
            ? 'Белый список РФ'
            : base === 'dpi_target'
            ? 'Заблокирован РКН'
            : 'Нейтральный сайт',
        base,
      };
    });

  const ruItems = items.filter((i) => i.base === 'ru_whitelist');
  const globalItems = items.filter((i) => i.base === 'global_neutral');
  const dpiItems = items.filter((i) => i.base === 'dpi_target');

  const pct = (arr: Array<{ status: 'ok' | 'slow' | 'blocked' }>) =>
    arr.length === 0 ? 100 : Math.round((arr.filter((x) => reachable(x)).length / arr.length) * 100);

  const ru_ok_pct = pct(ruItems);
  const global_ok_pct = pct(globalItems);
  const dpi_ok_pct = pct(dpiItems);
  // «заблокированные» ресурсы при живом VPN должны открываться — это проверка работы туннеля
  const blocked_ok_pct = dpi_ok_pct;

  const whitelist_pattern =
    !opts.withVpn && ruItems.length > 0 && ru_ok_pct >= 45 && global_ok_pct <= 40;
  const dpi_pattern = !opts.withVpn && global_ok_pct >= 60 && dpi_ok_pct < 70;
  const jamming_pattern =
    !opts.withVpn && ru_ok_pct < 45 && global_ok_pct < 30;
  const open_pattern = !opts.withVpn && !whitelist_pattern && !jamming_pattern && global_ok_pct >= 65;

  const highlight_ok = items
    .filter((i) => reachable(i))
    .sort((a, b) => (a.latency_ms ?? 0) - (b.latency_ms ?? 0))
    .slice(0, 6)
    .map(({ base, ...rest }) => rest);
  const highlight_blocked = items
    .filter((i) => !reachable(i))
    .slice(0, 8)
    .map(({ base, ...rest }) => rest);

  let scenario: ScanDiagnosis['scenario'] = 'open';
  if (opts.withVpn) scenario = 'open';
  else if (jamming_pattern) scenario = 'jamming';
  else if (whitelist_pattern) scenario = 'whitelist';
  else if (dpi_pattern) scenario = 'dpi';
  else if (global_ok_pct < 65) scenario = 'partial';

  const headline =
    scenario === 'whitelist'
      ? 'ЕСТЬ БЕЛЫЕ СПИСКИ'
      : scenario === 'jamming'
      ? 'ГЛУШЕНИЕ СЕТИ / ШАТДАУН'
      : scenario === 'dpi'
      ? 'БЕЛЫХ СПИСКОВ НЕТ • БЛОКИРОВКИ РКН'
      : scenario === 'partial'
      ? 'ЧАСТИЧНЫЕ ОГРАНИЧЕНИЯ'
      : opts.withVpn
      ? 'ДОСТУП ЧЕРЕЗ VPN'
      : 'ИНТЕРНЕТ СВОБОДЕН';

  const details =
    scenario === 'whitelist'
      ? `Открываются сервисы из официального перечня Минцифры (${ru_ok_pct}%), а нейтральный зарубежный интернет режется (доступно лишь ${global_ok_pct}% из ${globalItems.length} незаблокированных сайтов: Википедия, Google, GitHub, Cloudflare). Это режим белых списков.`
      : scenario === 'jamming'
      ? `Массово недоступны и российские (${ru_ok_pct}%), и зарубежные (${global_ok_pct}%) ресурсы. Похоже на шатдаун мобильного интернета или глушение LTE, а не на фильтрацию сайтов.`
      : scenario === 'dpi'
      ? `Нейтральный интернет открыт (${global_ok_pct}% из ${globalItems.length} незаблокированных сайтов), белые списки не активны. Но ${dpiItems.length - Math.round((dpi_ok_pct / 100) * dpiItems.length)} заблокированных РКН сервисов не отвечают — значит работает ТСПУ/DPI.`
      : scenario === 'partial'
      ? `Работает ${global_ok_pct}% незаблокированных сайтов и ${ru_ok_pct}% белого списка. Часть подсетей (Cloudflare, CDN) лежит — возможны региональные ограничения.`
      : opts.withVpn
      ? `Через VPN-туннель открываются ${items.filter(reachable).length} из ${items.length} сайтов, включая заблокированные РКН (${dpi_ok_pct}%). Блокировка обойдена.`
      : `Открываются ${items.filter(reachable).length} из ${items.length} сайтов, включая все нейтральные (${global_ok_pct}%). Признаков белых списков, глушения и новых блокировок нет.`;

  return {
    ru_ok_pct,
    global_ok_pct,
    blocked_ok_pct,
    dpi_ok_pct,
    ru_total: ruItems.length,
    global_total: globalItems.length,
    blocked_total: dpiItems.length,
    whitelist_pattern,
    dpi_pattern,
    jamming_pattern,
    open_pattern,
    scenario,
    highlight_ok,
    highlight_blocked,
    headline,
    details,
  };
}

export function evaluateScanVerdict(
  results: ScanSiteResult[],
  withVpn: boolean,
  sitesById?: Map<number, Site>
) {
  const map =
    sitesById ??
    new Map<number, Site>(
      results
        .filter((r) => r.site_id)
        .map((r) => [
          r.site_id!,
          {
            id: r.site_id!,
            user_id: 0,
            name: r.name,
            domain: r.domain,
            probe_url: '',
            category: r.category as Site['category'],
            marker_role: r.marker_role as Site['marker_role'],
            enabled: 1,
            last_status: 'unknown',
            last_latency_ms: null,
            last_checked_at: null,
            description: '',
            created_at: '',
          } as Site,
        ])
    );

  const d = diagnoseScan(results, map, { withVpn });

  const total_sites = results.length;
  const ok_sites = results.filter((r) => r.status === 'ok').length;
  const slow_sites = results.filter((r) => r.status === 'slow').length;
  const blocked_sites = results.filter((r) => r.status === 'blocked').length;
  const latencies = results
    .map((r) => r.latency_ms)
    .filter((ms): ms is number => typeof ms === 'number');
  const avg_latency_ms =
    latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const verdict: VerdictType =
    d.scenario === 'whitelist'
      ? 'WHITELIST_ACTIVE'
      : d.scenario === 'jamming'
      ? 'TOTAL_JAMMING'
      : d.scenario === 'dpi'
      ? 'DPI_THROTTLING'
      : d.scenario === 'partial'
      ? 'SEVERE_RESTRICTIONS'
      : 'OPEN_INTERNET';

  const verdict_title =
    d.scenario === 'whitelist'
      ? 'ВНИМАНИЕ: ЕСТЬ БЕЛЫЕ СПИСКИ!'
      : d.scenario === 'jamming'
      ? 'Глушение сети / Шатдаун (жёсткие ограничения)'
      : d.scenario === 'dpi'
      ? 'Белых списков нет • Работает ТСПУ / DPI'
      : d.scenario === 'partial'
      ? 'Частичные ограничения / сбой CDN'
      : withVpn
      ? 'Свободный доступ через VPN'
      : 'Свободный доступ — белых списков нет';

  return {
    verdict,
    verdict_title,
    verdict_summary: d.details,
    total_sites,
    ok_sites,
    slow_sites,
    blocked_sites,
    ru_ok_pct: d.ru_ok_pct,
    global_ok_pct: d.global_ok_pct,
    dpi_ok_pct: d.dpi_ok_pct,
    avg_latency_ms,
    diagnosis: d,
  };
}
