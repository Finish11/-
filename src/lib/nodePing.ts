import {
  getNativeNetworkState,
  isNativeApp,
  mapLimit,
  probeNode,
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
}

const PORT_TIMEOUT = 4000;

export interface NodeMeasurement {
  id: number;
  status: NodeProbe['status'];
  latencyMs: number | null;
  reason: string;
  checkedAt: string;
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

function successResult(tcp: TcpResult, attempts: number, route: 'vpn' | 'direct' | 'unknown'): NodePingResult {
  const latencyMs = tcp.latencyMs as number;
  const subMillisecond = latencyMs < 1;
  const slow = latencyMs > 900;
  let reason = slow ? 'очень медленно' : '';
  if (route === 'vpn') {
    reason = subMillisecond
      ? 'TCP быстрее 1 мс через VPN: вероятен локальный ответ VPN-клиента, это не RTT до страны узла'
      : 'TCP через текущий VPN: это не чистый RTT до страны узла';
  } else if (subMillisecond) {
    reason = 'TCP-connect быстрее 1 мс; это не ICMP ping';
  }
  return {
    status: slow ? 'degraded' : 'online',
    latencyMs,
    latencyUs: tcp.latencyUs,
    reason,
    attempts,
    route,
  };
}

/** Для <1 мс берём медиану трёх ответов, а не один случайный мгновенный connect. */
async function verifySubMillisecond(first: TcpResult, host: string, port: number): Promise<{ tcp: TcpResult; attempts: number }> {
  const samples: TcpResult[] = [first];
  for (let index = 0; index < 2; index += 1) {
    const next = await tcpConnect(host, port);
    if (next.latencyMs != null) samples.push(next);
  }
  samples.sort((a, b) => (a.latencyMs || 0) - (b.latencyMs || 0));
  return { tcp: samples[Math.floor(samples.length / 2)], attempts: 3 };
}

export async function pingNode(
  host: string,
  port: number,
  knownRoute?: 'vpn' | 'direct' | 'unknown'
): Promise<NodePingResult> {
  if (!host) {
    return { status: 'blocked', latencyMs: null, reason: 'в ссылке нет адреса', attempts: 0 };
  }

  if (isNativeApp()) {
    const route = knownRoute || await currentRoute();
    let tcp = await tcpConnect(host, port);
    if (tcp.latencyMs != null) {
      let attempts = 1;
      if (tcp.latencyMs < 1) {
        const verified = await verifySubMillisecond(tcp, host, port);
        tcp = verified.tcp;
        attempts = verified.attempts;
      }
      return successResult(tcp, attempts, route);
    }
    // Сокет был, но подключиться не удалось — повторяем один раз.
    if (tcp.error && !/только в приложении|not implemented|not available/i.test(tcp.error)) {
      const again = await tcpConnect(host, port);
      if (again.latencyMs != null) return successResult(again, 2, route);
      return {
        status: 'blocked',
        latencyMs: null,
        reason: classifyConnectError(again.error || tcp.error),
        attempts: 2,
        route,
      };
    }
  }

  const probe = await probeNode(host, port);
  return {
    status: probe.status,
    latencyMs: probe.latencyMs,
    reason: probe.reason,
    attempts: 1,
    route: 'unknown',
  };
}

/** TCP-connect через нативный сокет: микросекунды сохраняются без округления до нуля. */
async function tcpConnect(host: string, port: number): Promise<TcpResult> {
  const res = await tcpPing(host, port, PORT_TIMEOUT);
  return res.ok && res.latency_ms != null
    ? { latencyMs: res.latency_ms, latencyUs: res.latency_us }
    : { latencyMs: null, error: res.error || 'нет соединения' };
}

function classifyConnectError(message: string): string {
  const m = message.toLowerCase();
  if (/timeout|timed out/.test(m)) return 'порт не ответил (таймаут)';
  if (/resolve|unknown host|nxdomain|not known/.test(m)) return 'домен не резолвится';
  if (/refused/.test(m)) return 'порт закрыт';
  if (/reset|closed|abort/.test(m)) return 'соединение сброшено — похоже на фильтрацию';
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
  return mapLimit(nodes, 12, async (node, index) => {
    const result = await pingNode(node.host, node.port, route);
    done += 1;
    onProgress(done, total, result, index);
    return result;
  });
}
