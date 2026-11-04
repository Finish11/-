import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Мост к «нативной» сети. В APK (Capacitor) запросы идут через нативный HTTP-стек:
 * он не подчиняется CORS, поэтому можно скачать подписку с любого домена и постучать
 * по порту узла. В браузере (демо на GitHub Pages / dev-сервер) всё это недоступно —
 * там работают только симуляции.
 */

export const isNativeApp = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

export interface NativeHttpResult {
  status: number;
  text: string;
  headers: Record<string, string>;
  latencyMs: number;
}

/** GET через нативный HTTP (без CORS). Бросает понятную ошибку при таймауте/сети. */
export async function nativeGet(url: string, timeoutMs = 15000): Promise<NativeHttpResult> {
  const started = Date.now();
  try {
    const res = await CapacitorHttp.request({
      url,
      method: 'GET',
      responseType: 'text',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      headers: {
        // Панели часто отдают ссылки только «клиентским» User-Agent
        'User-Agent': 'Happ/3.6.0 (PulseNet; Android 14)',
        Accept: '*/*',
      },
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers || {})) {
      headers[k.toLowerCase()] = String(v);
    }
    return {
      status: res.status,
      text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
      headers,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      /timeout|timed out/i.test(message)
        ? 'Сервер подписки не ответил вовремя'
        : `Не удалось загрузить подписку: ${message}`
    );
  }
}

export type NodeStatus = 'online' | 'degraded' | 'blocked';

export interface NodeProbe {
  status: NodeStatus;
  latencyMs: number | null;
  reason: string;
}

const BLOCKED_MS = 900;
const SLOW_MS = 320;

/**
 * Проверка узла: пробуем установить TLS-соединение с host:port.
 * Отвечает любой HTTP-код — значит порт открыт и до узла есть маршрут.
 * Таймаут/DNS-ошибка → «не работает» (blocked).
 */
export async function probeNode(host: string, port: number): Promise<NodeProbe> {
  const started = Date.now();
  const target = `https://${host}:${port}/`;
  try {
    await CapacitorHttp.request({
      url: target,
      method: 'GET',
      responseType: 'text',
      connectTimeout: 6000,
      readTimeout: 6000,
    });
    const ms = Date.now() - started;
    return {
      status: ms > BLOCKED_MS ? 'blocked' : ms > SLOW_MS ? 'degraded' : 'online',
      latencyMs: ms,
      reason: ms > BLOCKED_MS ? `очень медленно: ${ms} мс` : '',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Второй заход по обычному HTTP — часть узлов не отдаёт TLS на этом порту.
    try {
      const startedHttp = Date.now();
      await CapacitorHttp.request({
        url: `http://${host}:${port}/`,
        method: 'GET',
        responseType: 'text',
        connectTimeout: 5000,
        readTimeout: 5000,
      });
      const ms = Date.now() - startedHttp;
      return {
        status: ms > BLOCKED_MS ? 'blocked' : ms > SLOW_MS ? 'degraded' : 'online',
        latencyMs: ms,
        reason: '',
      };
    } catch {
      const reason = /timeout|timed out/i.test(msg)
        ? 'таймаут соединения'
        : /domain|host|resolve|ENOTFOUND/i.test(msg)
        ? 'домен не резолвится (DNS)'
        : 'порт закрыт или узел недоступен';
      return { status: 'blocked', latencyMs: null, reason };
    }
  }
}

/** Параллельная обработка с ограничением: 79 узлов не должны забить WebView. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
