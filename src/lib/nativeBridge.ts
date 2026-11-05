import { registerPlugin } from '@capacitor/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

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

export type NativeConnectionKind = 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';

export interface NativeNetworkState {
  connected: boolean;
  /** false означает сбой bridge, а не доказанное отсутствие сети. */
  systemKnown?: boolean;
  kind: NativeConnectionKind;
  /** Только системный TRANSPORT_VPN — никакой эвристики по IP. */
  vpn: boolean;
  /** Имя мобильного оператора из Android, если выбрана сотовая сеть. */
  carrier?: string;
  /** Монотонный номер системного события для отбрасывания старых колбэков. */
  sequence?: number;
}

interface NetworkBridgePlugin {
  networkKind(): Promise<NativeNetworkState>;
  addListener(
    eventName: 'networkChanged',
    listenerFunc: (state: NativeNetworkState) => void
  ): Promise<PluginListenerHandle>;
}

const NetworkBridge = registerPlugin<NetworkBridgePlugin>('ApkUpdater');

export async function getNativeNetworkState(): Promise<NativeNetworkState> {
  const state = await NetworkBridge.networkKind();
  return {
    connected: Boolean(state.connected),
    systemKnown: state.systemKnown !== false,
    kind: state.connected ? state.kind || 'unknown' : 'none',
    vpn: Boolean(state.connected && state.vpn),
    carrier: typeof state.carrier === 'string' ? state.carrier : '',
    sequence: typeof state.sequence === 'number' ? state.sequence : undefined,
  };
}

/** Системные события default network. На обычном Network-плагин не полагаемся. */
export function onNativeNetworkChanged(
  listener: (state: NativeNetworkState) => void
): () => void {
  let disposed = false;
  let handle: PluginListenerHandle | undefined;
  void NetworkBridge.addListener('networkChanged', listener).then((value) => {
    if (disposed) void value.remove();
    else handle = value;
  }).catch(() => {
    // На старых APK события могут отсутствовать: polling остаётся запасным путём.
  });
  return () => {
    disposed = true;
    if (handle) void handle.remove();
  };
}

export interface NativeHttpResult {
  status: number;
  text: string;
  headers: Record<string, string>;
  latencyMs: number;
}

/** GET через нативный HTTP (без CORS). Бросает понятную ошибку при таймауте/сети. */
export async function nativeGet(
  url: string,
  timeoutMs = 15000,
  userAgent = 'Happ/3.6.0 (PulseNet; Android 14)',
  extraHeaders: Record<string, string> = {}
): Promise<NativeHttpResult> {
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
        'User-Agent': userAgent,
        Accept: '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        ...extraHeaders,
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
    throw new Error(humanizeNetworkError(err));
  }
}

/**
 * Загрузка текста с любого адреса. Порядок попыток подобран под реальные панели:
 * сначала нативный HTTP (в APK он не подчиняется CORS), затем обычный fetch
 * (часть панелей отдаёт Access-Control-Allow-Origin: *), потом XHR.
 * В ошибку собираем причины всех попыток — по ней видно, где именно затык.
 */
export async function fetchTextUniversal(url: string, timeoutMs = 20000): Promise<string> {
  const attempts: string[] = [];
  const cleanUrl = encodeURI(decodeURI(url.trim()));

  if (isNativeApp()) {
    try {
      const res = await nativeGet(cleanUrl, timeoutMs);
      if (res.status >= 200 && res.status < 300) return res.text;
      attempts.push(`нативный HTTP: сервер ответил ${res.status}`);
    } catch (err) {
      attempts.push(`нативный HTTP: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(cleanUrl, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (res.ok) return await res.text();
    attempts.push(`fetch: сервер ответил ${res.status}`);
  } catch (err) {
    attempts.push(
      `fetch: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  throw new Error(
    `Не удалось скачать подписку. ${attempts.join('; ')}. ` +
      'Если панель закрыта паролем или блокирует приложение, вставьте ссылки узлов вручную.'
  );
}

/**
 * Человеческое объяснение сетевой ошибки.
 * Важно различать DNS и TLS: при DNS-сбое проблема почти всегда в сети/операторе,
 * а не в самой панели — и тогда совет «включите VPN и повторите» реально помогает.
 */
export function humanizeNetworkError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/unable to resolve host|no address associated|econnrefused.*dns|nxdomain|enotfound|unknownhost/i.test(message)) {
    return `домен не резолвится (${shortCause(message)}). Обычно так бывает, когда адрес панели недоступен у вашего оператора: включите VPN и повторите.`;
  }
  if (/timeout|timed out/i.test(message)) {
    return 'сервер не ответил вовремя (таймаут). Попробуйте ещё раз или через VPN.';
  }
  if (/ssl|tls|certificate|handshake/i.test(message)) {
    return `сбой TLS-соединения (${shortCause(message)}). Возможно, соединение подменяет провайдер.`;
  }
  if (/cleartext|not permitted/i.test(message)) {
    return 'Android запретил незашифрованное соединение — нужен https:// в ссылке.';
  }
  return shortCause(message) || 'неизвестная сетевая ошибка';
}

function shortCause(message: string): string {
  return message.replace(/^.*?(?:Exception|Error):\s*/i, '').slice(0, 160).trim();
}

/** Замер одного сайта: время ответа на probe_url. Возвращает мс или null. */
export async function measureUrl(
  url: string,
  timeoutMs = 6000
): Promise<{ latencyMs: number | null; reason?: string }> {
  const started = Date.now();
  if (isNativeApp()) {
    try {
      await CapacitorHttp.request({
        url,
        method: 'GET',
        responseType: 'text',
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      return { latencyMs: Date.now() - started };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        latencyMs: null,
        reason: /timeout|timed out/i.test(msg) ? 'таймаут' : 'нет соединения',
      };
    }
  }

  // Браузер: только no-cors-пинг, содержимое недоступно
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    await fetch(url, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return { latencyMs: Date.now() - started };
  } catch {
    return { latencyMs: null, reason: 'нет соединения или CORS' };
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


/** TCP-пинг до игрового сервера через нативный сокет (только в APK). */
export async function tcpPing(
  host: string,
  port: number,
  timeout = 5000
): Promise<{ ok: boolean; latency_ms: number | null; error?: string }> {
  if (!isNativeApp()) return { ok: false, latency_ms: null, error: 'только в приложении' };
  try {
    const res = await registerPlugin<{
      tcpProbe(o: { host: string; port: number; timeout?: number }): Promise<{
        ok: boolean;
        latency_ms?: number;
        error?: string;
      }>;
    }>('ApkUpdater').tcpProbe({ host, port, timeout });
    return { ok: Boolean(res.ok), latency_ms: res.latency_ms ?? null, error: res.error };
  } catch (err) {
    return { ok: false, latency_ms: null, error: err instanceof Error ? err.message : 'ошибка' };
  }
}
