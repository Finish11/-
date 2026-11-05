import { isNativeApp, mapLimit, probeNode, type NodeProbe } from './nativeBridge';

/**
 * «Проверить пинг» для всех узлов — без включения VPN.
 *
 * Что честно измеряется: доступен ли адрес и порт узла с вашей текущей сети,
 * и сколько длится TCP-подключение. Это доказывает, что сервер жив и что сеть
 * его не режет. Чего это НЕ доказывает: что через узел откроются заблокированные
 * сайты (для этого нужен реальный туннель в VPN-клиенте).
 *
 * Проба порта — в три шага, чтобы не путать «закрыто» и «нет ответа»:
 *   1. нативный TCP-connect по host:port (в APK — настоящий сокет, это и есть пинг);
 *   2. TLS-запрос через нативный HTTP (для старых сборок без сокета);
 *   3. при отказе — повтор один раз, чтобы отделить случайный сброс от блокировки.
 */

export interface NodePingResult {
  status: NodeProbe['status'];
  latencyMs: number | null;
  reason: string;
  /** Сколько попыток сделали */
  attempts: number;
}

const PORT_TIMEOUT = 4000;

export async function pingNode(host: string, port: number): Promise<NodePingResult> {
  if (!host) {
    return { status: 'blocked', latencyMs: null, reason: 'в ссылке нет адреса', attempts: 0 };
  }

  if (isNativeApp()) {
    // Настоящий TCP-connect: именно он даёт честный «пинг до узла».
    const tcp = await tcpConnect(host, port);
    if (tcp.latencyMs != null) {
      return {
        status: tcp.latencyMs > 900 ? 'degraded' : 'online',
        latencyMs: tcp.latencyMs,
        reason: tcp.latencyMs > 900 ? 'очень медленно' : '',
        attempts: 1,
      };
    }
    // Сокет недоступен (старая сборка) — падаем на нативный HTTP.
    if (tcp.error && !/только в приложении|not implemented|not available/i.test(tcp.error)) {
      // Сокет был, но подключиться не удалось — повторяем один раз.
      const again = await tcpConnect(host, port);
      if (again.latencyMs != null) {
        return {
          status: again.latencyMs > 900 ? 'degraded' : 'online',
          latencyMs: again.latencyMs,
          reason: again.latencyMs > 900 ? 'очень медленно' : '',
          attempts: 2,
        };
      }
      return {
        status: 'blocked',
        latencyMs: null,
        reason: classifyConnectError(again.error || tcp.error),
        attempts: 2,
      };
    }
  }

  const probe = await probeNode(host, port);
  return {
    status: probe.status,
    latencyMs: probe.latencyMs,
    reason: probe.reason,
    attempts: 1,
  };
}

/** TCP-connect через нативный сокет: возвращает мс или причину. */
async function tcpConnect(
  host: string,
  port: number
): Promise<{ latencyMs: number | null; error?: string }> {
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const plugin = registerPlugin<{
      tcpProbe(o: { host: string; port: number; timeout?: number }): Promise<{
        ok: boolean;
        latency_ms?: number;
        error?: string;
      }>;
    }>('ApkUpdater');
    const res = await plugin.tcpProbe({ host, port, timeout: PORT_TIMEOUT });
    return res.ok
      ? { latencyMs: res.latency_ms ?? null }
      : { latencyMs: null, error: res.error || 'нет соединения' };
  } catch (err) {
    return { latencyMs: null, error: err instanceof Error ? err.message : 'нет соединения' };
  }
}

function classifyConnectError(message: string): string {
  const m = message.toLowerCase();
  if (/timeout|timed out/.test(m)) return 'порт не ответил (таймаут)';
  if (/resolve|unknown host|nxdomain|not known/.test(m)) return 'домен не резолвится';
  if (/refused/.test(m)) return 'порт закрыт';
  if (/reset|closed|abort/.test(m)) return 'соединение сброшено — похоже на фильтрацию';
  return 'узел не отвечает';
}

/**
 * Проверка всех узлов: 12 одновременно, прогресс виден по ходу. Для 79 узлов
 * это заметно быстрее старых шести потоков, но не создаёт 79 сокетов сразу.
 */
export async function pingAllNodes<T extends { host: string; port: number }>(
  nodes: T[],
  onProgress: (done: number, total: number, result: NodePingResult, index: number) => void
): Promise<NodePingResult[]> {
  const total = nodes.length;
  let done = 0;
  return mapLimit(nodes, 12, async (node, index) => {
    const result = await pingNode(node.host, node.port);
    done += 1;
    onProgress(done, total, result, index);
    return result;
  });
}
