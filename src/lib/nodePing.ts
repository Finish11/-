import {
  getNativeNetworkState,
  getVpnDiagnostics,
  isNativeApp,
  mapLimit,
  probeNode,
  realDelayProbe,
  tcpPing,
  type NodeProbe,
} from './nativeBridge';

/**
 * «Проверить пинг» для узлов — без включения их как системного VPN.
 *
 * Измеряется доступность host:port и TCP-connect с ТЕКУЩЕЙ сети. Если сторонний
 * VPN уже включён, его клиент может обработать соединение локально: результат
 * нельзя называть чистым RTT до страны узла или скоростью туннеля.
 */

export interface NodePingResult {
  status: NodeProbe['status'];
  latencyMs: number | null;
  latencyUs?: number | null;
  reason: string;
  attempts: number;
  route?: 'vpn' | 'direct' | 'unknown';
  trusted: boolean;
  vpnPackage?: string;
  /** Замер выполнен мимо включённого VPN — число снова означает RTT до сервера. */
  bypassed?: boolean;
}

const PORT_TIMEOUT = 4000;

export interface NodeMeasurement {
  id: number;
  status: NodeProbe['status'];
  latencyMs: number | null;
  reason: string;
  checkedAt: string;
  route?: NodePingResult['route'];
  trusted?: boolean;
  bypassed?: boolean;
}

/** Применяет только известные id и валидные результаты, не затрагивая остальные узлы. */
export function applyNodeMeasurements<
  T extends {
    id: number;
    status: NodeProbe['status'] | 'unknown';
    latency_ms: number | null;
    notes: string;
    last_checked_at: string | null;
  }
>(profiles: T[], measurements: NodeMeasurement[]): T[] {
  const byId = new Map<number, NodeMeasurement>();
  for (const measurement of measurements) {
    if (!Number.isInteger(measurement.id)) continue;
    if (!['online', 'degraded', 'blocked'].includes(measurement.status)) continue;
    byId.set(measurement.id, measurement);
  }
  return profiles.map((profile) => {
    const measurement = byId.get(profile.id);
    if (!measurement) return profile;
    return {
      ...profile,
      status: measurement.status,
      latency_ms:
        typeof measurement.latencyMs === 'number' &&
        Number.isFinite(measurement.latencyMs) &&
        measurement.latencyMs >= 0
          ? measurement.latencyMs
          : null,
      notes: typeof measurement.reason === 'string' ? measurement.reason : '',
      last_checked_at: measurement.checkedAt,
      latency_kind: 'tcp_connect', latency_route: measurement.route || 'unknown', latency_trusted: measurement.trusted === true,
      latency_bypassed: measurement.bypassed === true,
    };
  });
}

type TcpResult = { latencyMs: number | null; latencyUs?: number | null; error?: string };

export function formatTcpLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return '<1 мс';
  return `${Math.round(ms)} мс`;
}

async function currentRoute(): Promise<'vpn' | 'direct' | 'unknown'> {
  if (!isNativeApp()) return 'unknown';
  try {
    const state = await getNativeNetworkState();
    if (state.systemKnown === false) return 'unknown';
    return state.vpn ? 'vpn' : 'direct';
  } catch {
    return 'unknown';
  }
}

function successResult(latencyMs: number, attempts: number, route: NodePingResult['route'], vpnPackage?: string, bypassed = false): NodePingResult {
  const trusted = route === 'direct' && latencyMs >= 1;
  const reason = route === 'vpn' ? 'TCP-connect через VPN принимает локальный VPN-клиент: цифры в единицы миллисекунд появляются у любого сервера. Это не задержка до узла — выключите VPN или разрешите приложению прямой доступ.'
    : route === 'unknown' ? 'Системный маршрут не подтверждён; число нельзя использовать как чистый RTT.'
    : latencyMs < 1 ? 'Подозрительно быстрый локальный TCP-ответ; не международный RTT.'
    : bypassed ? `Медиана ${attempts} TCP-connect через физическую сеть в обход включённого VPN. Это доступность узла, а не скорость туннеля.`
    : `Медиана ${attempts} TCP-connect с текущего устройства. DNS исключён; VPN-протокол и приложения не проверены.`;
  return { status: latencyMs > 900 ? 'degraded' : 'online', latencyMs, latencyUs: latencyMs * 1000, reason, attempts, route, trusted, vpnPackage, bypassed };
}
export function medianSamples(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a,b) => a-b);
  if (!valid.length) return null; const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}
export async function pingNode(host: string, port: number, knownRoute?: NodePingResult['route']): Promise<NodePingResult> {
  if (!host) return { status: 'blocked', latencyMs: null, reason: 'в ссылке нет адреса', attempts: 0, trusted: false };
  if (isNativeApp()) {
    const startRoute = knownRoute || await currentRoute();
    // Внутри TUN любое TCP-соединение принимает сам VPN-клиент, поэтому у всех
    // узлов получались одинаковые «миллисекунды». Меряем через физическую сеть —
    // так же, как tcping в v2rayNG работает до подключения туннеля.
    const bypass = startRoute === 'vpn';
    const samples: number[] = []; let route = startRoute; let vpnPackage: string | undefined;
    let lastError = ''; let bypassed = false; let localAccept = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await tcpPing(host, port, PORT_TIMEOUT, bypass);
      if (!bypass && res.route && knownRoute && res.route !== knownRoute) return { status: 'blocked', latencyMs: null, attempts: attempt + 1,
        trusted: false, reason: 'Сеть изменилась во время проверки. Повторите на стабильном маршруте.' };
      route = res.route || route; vpnPackage = res.vpn_package || vpnPackage;
      bypassed = bypassed || res.bypassed === true; localAccept = localAccept || res.local_accept === true;
      if (res.ok && !res.local_accept && res.latency_ms != null && Number.isFinite(res.latency_ms)) samples.push(res.latency_ms);
      else lastError = res.error || 'нет соединения';
    }
    const median = medianSamples(samples);
    if (median != null && samples.length >= 2) return successResult(median, samples.length, bypassed ? 'direct' : route, vpnPackage, bypassed);
    if (bypass && /permission denied|lockdown|物理|физическая/i.test(lastError))
      return { status: 'blocked', latencyMs: null, attempts: 3, route: 'unknown', trusted: false, vpnPackage,
        reason: 'Система не даёт приложению выйти напрямую мимо VPN (постоянный VPN или раздельный туннель). Выключите VPN в клиенте и повторите — иначе цифры были бы выдуманными.' };
    if (localAccept) return { status: 'online', latencyMs: null, attempts: 3, route: 'vpn', trusted: false, vpnPackage,
      reason: 'Порт отвечает, но соединение принимает локальный VPN-клиент: задержку до сервера так измерить нельзя. Проверьте узел с выключенным VPN или смотрите «Реальную задержку» активного подключения.' };
    return { status: 'blocked', latencyMs: null, reason: classifyConnectError(lastError), attempts: 3, route, trusted: false, vpnPackage };
  }
  const probe = await probeNode(host, port);
  return { ...probe, attempts: 1, route: 'unknown', trusted: false, reason: 'Проба из браузера/сервера, не с телефона. Не RTT через ваш VPN.' };
}


function classifyConnectError(message: string): string {
  const m = message.toLowerCase();
  if (/timeout|timed out/.test(m)) return 'порт не ответил (таймаут)';
  if (/resolve|unknown host|nxdomain|not known/.test(m)) return 'домен не резолвится';
  if (/refused/.test(m)) return 'порт закрыт';
  if (/reset|closed|abort/.test(m)) return 'соединение сброшено; причина не установлена';
  return 'узел не отвечает';
}

/** Проверка всех узлов: системный маршрут определяется один раз на партию. */
export async function pingAllNodes<T extends { host: string; port: number }>(
  nodes: T[],
  onProgress: (done: number, total: number, result: NodePingResult, index: number) => void
): Promise<NodePingResult[]> {
  const total = nodes.length;
  const route = await currentRoute();
  let done = 0;
  return mapLimit(nodes, 4, async (node, index) => {
    const result = await pingNode(node.host, node.port, route);
    done += 1;
    onProgress(done, total, result, index);
    return result;
  });
}

export function tcpLatencyIsComparable(profile: { latency_ms: number | null; latency_kind?: string; latency_route?: string; latency_trusted?: boolean }): boolean {
  return profile.latency_ms != null && Number.isFinite(profile.latency_ms) && profile.latency_ms >= 1 && profile.latency_kind === 'tcp_connect'
    && profile.latency_route === 'direct' && profile.latency_trusted === true;
}
export function nodeLatencyLabel(profile: Parameters<typeof tcpLatencyIsComparable>[0]): string {
  if (profile.latency_ms == null) return 'нет TCP-замера';
  if (profile.latency_kind !== 'tcp_connect') return 'старая проба · повторите';
  if (!tcpLatencyIsComparable(profile)) return profile.latency_route === 'vpn' ? 'TCP через VPN · не RTT' : 'TCP · маршрут не подтверждён';
  return `TCP ${formatTcpLatency(profile.latency_ms)}`;
}

export interface RealDelayMeasurement {
  ok: boolean;
  latencyMs: number | null;
  minMs?: number | null;
  maxMs?: number | null;
  samples: number[];
  route: 'vpn' | 'direct' | 'unknown';
  checkedAt: string;
  reason: string;
}

export const REAL_DELAY_TARGETS = [
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
];

/**
 * «Реальная задержка» активного подключения: HTTP 204 сквозь туннель, медиана
 * прогретых запросов. Так измеряют real delay v2rayNG, NekoBox и Hiddify —
 * в отличие от TCP-connect, это проверяет весь путь, включая выход сервера.
 */
export async function measureRealDelay(target?: string): Promise<RealDelayMeasurement> {
  const checkedAt = new Date().toISOString();
  const targets = target ? [target] : REAL_DELAY_TARGETS;
  let lastError = '';
  for (const url of targets) {
    const result = await realDelayProbe(url, 8000, 4);
    const route = result.route || 'unknown';
    if (result.ok && typeof result.latency_ms === 'number' && Number.isFinite(result.latency_ms)) {
      return { ok: true, latencyMs: result.latency_ms, minMs: result.min_ms ?? null, maxMs: result.max_ms ?? null,
        samples: Array.isArray(result.samples) ? result.samples : [], route, checkedAt,
        reason: route === 'vpn' ? 'HTTP 204 через активный VPN: проверен весь путь, включая выход сервера.'
          : 'HTTP 204 напрямую: это задержка вашего интернета без VPN.' };
    }
    lastError = result.error || 'цель не ответила';
  }
  return { ok: false, latencyMs: null, samples: [], route: await currentRoute(), checkedAt,
    reason: `Реальная задержка не измерена: ${lastError}` };
}

/** Метка для карточки узла: реальная задержка важнее TCP, если она свежая. */
export function nodeRealDelayLabel(profile: { real_delay_ms?: number | null; real_delay_at?: string | null; real_delay_route?: string }, now = Date.now()): string {
  if (profile.real_delay_ms == null || !profile.real_delay_at) return '';
  const age = now - Date.parse(profile.real_delay_at);
  if (!Number.isFinite(age) || age > 30 * 60_000) return 'реальная задержка устарела';
  return `реальная ${formatTcpLatency(profile.real_delay_ms)}${profile.real_delay_route === 'vpn' ? ' через VPN' : ' напрямую'}`;
}
