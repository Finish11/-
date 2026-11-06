import { isNativeApp } from './nativeBridge';
import { apiFetch } from './api';
import { probeSiteResilient } from './siteProbe';
import { siteResultFromProbe } from './siteMeasurement';

/**
 * Демо-сборка (один HTML-файл без backend) собирается с VITE_DEMO=1.
 * В ней «живые» замеры заменяются детерминированной имитацией по статусу ресурса,
 * чтобы предпросмотр работал без сети, но показывал реальную диагностику.
 */
export const IS_DEMO_BUILD =
  typeof import.meta !== 'undefined' &&
  Boolean((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DEMO);
import type {
  ScanSiteResult,
  SimulationMode,
  Site,
  VerdictType,
  SiteBlockReason,
} from '../types';

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
  if (IS_DEMO_BUILD && simMode === 'live' && !isNativeApp()) {
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

  // Единый HTTP-путь с APK; серверный релей не подменяет маршрут телефона.
  const probe = await probeSiteResilient(site.probe_url || `https://${site.domain}/`);
  return siteResultFromProbe(site, probe);
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
  proof?: ScanSiteResult['proof'];
  access_scope?: ScanSiteResult['access_scope'];
  source_url?: string;
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
  /** Классификация по измерениям: белый список / частные ограничения / глушение. */
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
 *  3) ВОЗМОЖНО ОГРАНИЧЕННЫЕ — сетевая фильтрация и правила сервиса различаются по каждому результату
 * Вердикт строится на 1+2: если нейтральные массово падают, а белый список жив → белые списки.
 */
export function diagnoseScan(
  results: ScanSiteResult[],
  sitesById: Map<number, Site>,
  opts: { withVpn: boolean }
): ScanDiagnosis {
  // Подменённый ответ никогда не считается доступностью — даже если в старой
  // сохранённой записи статус по ошибке остался ok/slow.
  const reachable = (r: { status: 'ok' | 'slow' | 'blocked'; intercepted?: boolean }) =>
    !r.intercepted && (r.status === 'ok' || r.status === 'slow');

  const items: Array<SiteDiagnosisItem & { base: 'ru_whitelist' | 'global_neutral' | 'dpi_target' }> =
    results.map((r) => {
      const site = r.site_id ? sitesById.get(r.site_id) : undefined;
      const base = site ? classifyBase(site) : (r.marker_role as 'ru_whitelist' | 'global_neutral' | 'dpi_target');
      let block_reason: SiteBlockReason | undefined;
      if (!reachable(r)) {
        if (r.intercepted || r.block_reason === 'throttled') {
          block_reason = 'throttled';
        } else if (r.block_reason && r.block_reason !== 'ok') {
          // Конкретная причина важнее групповой догадки: региональное правило
          // сервиса и неизвестный ответ нельзя молча превращать в «РКН».
          block_reason = r.block_reason;
        } else if (base === 'dpi_target' && site?.accessibility !== 'ok') {
          block_reason = 'unknown';
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
        status: r.intercepted ? 'blocked' : r.status,
        latency_ms: r.intercepted ? null : r.latency_ms,
        block_reason,
        note:
          r.note ||
          (base === 'ru_whitelist'
            ? 'Белый список РФ'
            : base === 'dpi_target'
            ? reachable(r)
              ? 'Ограничивается не везде — сейчас отвечает напрямую'
              : 'Сервис из группы возможных ограничений; причина не подтверждена'
            : 'Нейтральный сайт'),
        proof: r.proof,
        access_scope: r.access_scope,
        source_url: r.source_url,
        base,
      };
    });

  // Справочное региональное правило не является сетевым измерением и не должно
  // само по себе создавать паттерн DPI/белых списков. В подсветке оно остаётся.
  const networkItems = items.filter((item) => item.access_scope !== 'provider_region_ru');
  const ruItems = networkItems.filter((i) => i.base === 'ru_whitelist');
  const globalItems = networkItems.filter((i) => i.base === 'global_neutral');
  const dpiItems = networkItems.filter((i) => i.base === 'dpi_target');

  const pct = (arr: Array<{ status: 'ok' | 'slow' | 'blocked'; intercepted?: boolean }>) =>
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

  const reachableTotal = networkItems.filter((i) => reachable(i)).length;
  const interceptedTotal = results.filter((r) => r.intercepted).length;
  const referenceOnly = networkItems.length === 0 && items.length > 0;

  let scenario: ScanDiagnosis['scenario'] = 'open';
  if (referenceOnly || (networkItems.length > 0 && reachableTotal === 0)) scenario = 'partial';
  else if (opts.withVpn) scenario = 'open';
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
      ? 'БЕЛЫХ СПИСКОВ НЕТ • ЧАСТИЧНЫЕ ОГРАНИЧЕНИЯ'
      : scenario === 'partial'
      ? referenceOnly
        ? 'ТОЛЬКО СПРАВОЧНЫЕ ДАННЫЕ'
        : 'ЧАСТИЧНЫЕ ОГРАНИЧЕНИЯ'
      : opts.withVpn
      ? 'ДОСТУП ЧЕРЕЗ VPN'
      : 'ИНТЕРНЕТ СВОБОДЕН';

  const details =
    scenario === 'whitelist'
      ? `Открываются сервисы из официального перечня Минцифры (${ru_ok_pct}%), а нейтральный зарубежный интернет режется (доступно лишь ${global_ok_pct}% из ${globalItems.length} незаблокированных сайтов: Википедия, Google, GitHub, Cloudflare). Это режим белых списков.`
      : scenario === 'jamming'
      ? `Массово недоступны и российские (${ru_ok_pct}%), и зарубежные (${global_ok_pct}%) ресурсы. Похоже на шатдаун мобильного интернета или глушение LTE, а не на фильтрацию сайтов.`
      : scenario === 'dpi'
      ? `Нейтральный интернет открыт (${global_ok_pct}% из ${globalItems.length} незаблокированных сайтов), белые списки маловероятны. Часть сервисов из группы возможных ограничений не отвечает. Сетевая фильтрация — только одна из гипотез; региональные правила сервиса и неизвестные ответы разбираются отдельно по каждому адресу.`
      : scenario === 'partial'
      ? referenceOnly
        ? 'В этом наборе есть только справочные региональные правила сервисов. Для сетевого вердикта нужны измерения нейтральных и российских контрольных адресов.'
        : interceptedTotal > 0
        ? `На ${interceptedTotal} сайтах пришла заглушка или чужой TLS-сертификат: они не считаются работающими. Действительно открылись ${reachableTotal} из ${networkItems.length}.`
        : `Работает ${global_ok_pct}% незаблокированных сайтов и ${ru_ok_pct}% белого списка. Часть подсетей (Cloudflare, CDN) лежит — возможны региональные ограничения.`
      : opts.withVpn
      ? `Через VPN-туннель отвечают ${reachableTotal} из ${networkItems.length} веб-адресов, включая ${dpi_ok_pct}% группы возможных ограничений. Работа установленных приложений и аккаунтов этим не доказана.${interceptedTotal ? ` Нераспознанный ответ всё ещё заметен на ${interceptedTotal} сайтах.` : ''}`
      : `Открываются ${reachableTotal} из ${networkItems.length} сайтов, нейтральные ресурсы доступны на ${global_ok_pct}%. Признаков белых списков и глушения нет.`;

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
  const ok_sites = results.filter((r) => r.status === 'ok' && !r.intercepted).length;
  const slow_sites = results.filter((r) => r.status === 'slow' && !r.intercepted).length;
  const blocked_sites = results.filter((r) => r.status === 'blocked' || r.intercepted).length;
  const latencies = results
    .filter((r) => !r.intercepted)
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

  // Только формулировки: коды вердиктов и пороги не менялись.
  const verdict_title =
    d.scenario === 'whitelist'
      ? 'Включены белые списки'
      : d.scenario === 'jamming'
      ? 'Похоже на глушение сети'
      : d.scenario === 'dpi'
      ? 'Часть сервисов ограничена'
      : d.scenario === 'partial'
      ? 'Часть сайтов недоступна'
      : withVpn
      ? 'Веб-доступ через VPN'
      : 'Нейтральный интернет доступен';

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
