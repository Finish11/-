import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { ApkPlugin, NetworkProbePlugin } from './apkPlugin';

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
  /** VPN включён в системе (может быть у другого приложения). */
  systemVpn?: boolean;
  /** Трафик именно этого приложения идёт через VPN. */
  appUsesVpn?: boolean;
  /** VPN есть, но наше приложение идёт мимо него: per-app proxy в клиенте. */
  splitTunnel?: boolean;
  lockdown?: boolean;
  bypassAvailable?: boolean;
  /** false означает сбой bridge, а не доказанное отсутствие сети. */
  systemKnown?: boolean;
  kind: NativeConnectionKind;
  /** Только системный TRANSPORT_VPN — никакой эвристики по IP. */
  vpn: boolean;
  /** Имя мобильного оператора из Android, если выбрана сотовая сеть. */
  carrier?: string;
  /** Монотонный номер системного события для отбрасывания старых колбэков. */
  sequence?: number;
  vpnPackage?: string;
  vpnAppName?: string;
}

interface NetworkBridgePlugin {
  networkKind(): Promise<NativeNetworkState>;
  openInstalledApp(options: { packageName: string }): Promise<{ opened: boolean; installed: boolean; packageName?: string }>;
  addListener(
    eventName: 'networkChanged',
    listenerFunc: (state: NativeNetworkState) => void
  ): Promise<PluginListenerHandle>;
}

const NetworkBridge = ApkPlugin as unknown as NetworkBridgePlugin;

export async function getNativeNetworkState(): Promise<NativeNetworkState> {
  const state = await NetworkBridge.networkKind();
  return {
    connected: Boolean(state.connected),
    systemKnown: state.systemKnown !== false,
    kind: state.connected ? state.kind || 'unknown' : 'none',
    vpn: Boolean(state.connected && state.vpn),
    carrier: typeof state.carrier === 'string' ? state.carrier : '',
    sequence: typeof state.sequence === 'number' ? state.sequence : undefined,
    vpnPackage: typeof state.vpnPackage === 'string' ? state.vpnPackage : '',
    vpnAppName: typeof state.vpnAppName === 'string' ? state.vpnAppName : '',
    systemVpn: state.systemVpn === true || Boolean(state.connected && state.vpn),
    appUsesVpn: state.appUsesVpn ?? Boolean(state.connected && state.vpn),
    splitTunnel: state.splitTunnel === true,
    lockdown: state.lockdown === true,
    bypassAvailable: state.bypassAvailable !== false,
  };
}

/** Открывает первый найденный официальный пакет; установка/работа не выдумываются. */
export async function openInstalledApp(packageNames: string[]): Promise<{ opened: boolean; packageName?: string }> {
  if (!isNativeApp()) return { opened: false };
  for (const packageName of packageNames) {
    const result = await NetworkBridge.openInstalledApp({ packageName });
    if (result.opened) return { opened: true, packageName: result.packageName || packageName };
  }
  return { opened: false };
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
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      // Отмена не бросает исключение внутри воркера: иначе Promise.all
      // отклонился бы раньше остальных и оставил бы необработанные отказы.
      if (signal?.aborted) return;
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  if (signal?.aborted) {
    const error = new Error('Проверка остановлена');
    error.name = 'AbortError';
    throw error;
  }
  return results;
}


/** TCP-пинг до игрового сервера через нативный сокет (только в APK). */
export interface TcpPingResult {
  ok: boolean; latency_ms: number | null; latency_us?: number | null; dns_us?: number | null;
  route?: 'vpn' | 'direct' | 'unknown'; vpn_package?: string; error?: string;
  bypassed?: boolean; local_accept?: boolean; address?: string;
}
export async function tcpPing(
  host: string,
  port: number,
  timeout = 5000,
  bypassVpn = false
): Promise<TcpPingResult> {
  if (!isNativeApp()) return { ok: false, latency_ms: null, error: 'только в приложении' };
  try {
    const res = await (NetworkProbePlugin as unknown as {
      tcpProbe(o: { host: string; port: number; timeout?: number; bypassVpn?: boolean }): Promise<{
        ok: boolean;
        latency_ms?: number;
        latency_us?: number;
        dns_us?: number;
        route?: 'vpn' | 'direct' | 'unknown';
        vpn_package?: string;
        error?: string;
        bypassed?: boolean;
        local_accept?: boolean;
        address?: string;
      }>;
    }).tcpProbe({ host, port, timeout, bypassVpn });
    const micros = typeof res.latency_us === 'number' && Number.isFinite(res.latency_us)
      ? Math.max(0, res.latency_us)
      : null;
    const millis = micros != null
      ? micros / 1000
      : typeof res.latency_ms === 'number' && Number.isFinite(res.latency_ms)
      ? Math.max(0, res.latency_ms)
      : null;
    return { ok: Boolean(res.ok), latency_ms: millis, latency_us: micros,
      dns_us: typeof res.dns_us === 'number' ? res.dns_us : null,
      route: res.route, vpn_package: res.vpn_package, error: res.error,
      bypassed: res.bypassed === true, local_accept: res.local_accept === true, address: res.address };
  } catch (err) {
    return { ok: false, latency_ms: null, error: err instanceof Error ? err.message : 'ошибка' };
  }
}

export interface NativeHttpProbe {
  ok: boolean; status?: number; url?: string; content_type?: string; data_base64?: string;
  truncated?: boolean; latency_ms?: number; route?: 'vpn' | 'direct'; vpn_package?: string; error?: string;
}
export async function httpProbe(url: string, timeoutMs = 8000,
  plugin: { httpProbe(o: { url: string; timeoutMs: number; bypassVpn?: boolean }): Promise<unknown> } = NetworkProbePlugin as never,
  bypassVpn = false): Promise<NativeHttpProbe> {
  if (!isNativeApp()) return { ok: false, error: 'Нативная HTTP-проба доступна только в APK' };
  try { return await plugin.httpProbe({ url, timeoutMs, bypassVpn }) as NativeHttpProbe; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export interface VpnDiagnostics {
  ok: boolean;
  appUsesVpn: boolean;
  systemVpn: boolean;
  splitTunnel: boolean;
  vpnPackage: string;
  vpnAppName: string;
  alwaysOnApp: string;
  lockdown: boolean;
  bypassAvailable: boolean;
  physicalKind: NativeConnectionKind;
  activeKind: NativeConnectionKind;
  installedVpnApps: Array<{ package: string; name: string }>;
  error?: string;
}

/** Системные факты о VPN: какой клиент включён и проходит ли через него наше приложение. */
export async function getVpnDiagnostics(): Promise<VpnDiagnostics> {
  const empty: VpnDiagnostics = { ok: false, appUsesVpn: false, systemVpn: false, splitTunnel: false,
    vpnPackage: '', vpnAppName: '', alwaysOnApp: '', lockdown: false, bypassAvailable: false,
    physicalKind: 'unknown', activeKind: 'unknown', installedVpnApps: [] };
  if (!isNativeApp()) return empty;
  try {
    const res = await (NetworkProbePlugin as unknown as { vpnDiagnostics(): Promise<Partial<VpnDiagnostics>> }).vpnDiagnostics();
    return { ...empty, ...res, installedVpnApps: Array.isArray(res.installedVpnApps) ? res.installedVpnApps : [] };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface IpEchoResult { ok: boolean; ip?: string; source?: string; route?: 'vpn' | 'direct' | 'unknown'; latency_ms?: number; error?: string }

/** Внешний IP через нативный HTTP: работает и мимо VPN (для доказательства обхода туннеля). */
export async function ipEcho(bypassVpn = false, timeoutMs = 6000): Promise<IpEchoResult> {
  if (!isNativeApp()) return { ok: false, error: 'только в приложении' };
  try {
    return await (NetworkProbePlugin as unknown as {
      ipEcho(o: { bypassVpn?: boolean; timeoutMs?: number }): Promise<IpEchoResult>;
    }).ipEcho({ bypassVpn, timeoutMs });
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export interface RealDelayResult {
  ok: boolean; latency_ms?: number; min_ms?: number; max_ms?: number; samples?: number[];
  status?: number; route?: 'vpn' | 'direct' | 'unknown'; error?: string;
}

/** «Реальная задержка» через активное подключение — методика real delay в v2rayNG/NekoBox. */
export async function realDelayProbe(url?: string, timeoutMs = 8000, samples = 4): Promise<RealDelayResult> {
  if (!isNativeApp()) return { ok: false, error: 'только в приложении' };
  try {
    return await (NetworkProbePlugin as unknown as {
      realDelay(o: { url?: string; timeoutMs?: number; samples?: number }): Promise<RealDelayResult>;
    }).realDelay({ url, timeoutMs, samples });
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export interface SpeedSlice { t: number; bytes: number; confirmed: number }
export interface NativeSpeedPhase {
  ok: boolean; bytes: number; confirmed: number; elapsedMs: number; requests: number;
  connections: number; route?: 'vpn' | 'direct' | 'unknown'; slices: SpeedSlice[]; errors: string[];
}
export interface SpeedPhaseOptions {
  runId: string; direction: 'download' | 'upload'; urls: string[];
  connections?: number; durationMs?: number; chunkBytes?: number; maxBytes?: number; timeoutMs?: number;
  /**
   * Куда отдать итоговые байты фазы, если живых событий не было.
   * Второй аргумент — «это итог, а не срез по ходу».
   */
  onSample?: (slice: SpeedSlice, live?: boolean) => void;
}

export async function nativeSpeedPhase(options: SpeedPhaseOptions): Promise<NativeSpeedPhase> {
  const fallback: NativeSpeedPhase = { ok: false, bytes: 0, confirmed: 0, elapsedMs: 0, requests: 0,
    connections: options.connections ?? 4, slices: [], errors: [] };
  if (!isNativeApp()) return { ...fallback, errors: ['только в приложении'] };
  try {
    const res = await (NetworkProbePlugin as unknown as {
      speedPhase(o: SpeedPhaseOptions): Promise<Partial<NativeSpeedPhase>>;
    }).speedPhase(options);
    // Байты из результата тоже отдаём как срез: если Java не прислала события
    // (старая сборка или обрыв доставки), график всё равно получит числа.
    const totalBytes = typeof res.bytes === 'number' ? res.bytes : 0;
    const totalConfirmed = typeof res.confirmed === 'number' ? res.confirmed : 0;
    const elapsed = typeof res.elapsedMs === 'number' ? res.elapsedMs : 0;
    if (totalBytes > 0 && elapsed > 0) {
      options.onSample?.({ t: elapsed, bytes: totalBytes, confirmed: totalConfirmed }, false);
    }
    return { ...fallback, ...res, slices: Array.isArray(res.slices) ? res.slices : [], errors: Array.isArray(res.errors) ? res.errors : [] };
  } catch (error) { return { ...fallback, errors: [error instanceof Error ? error.message : String(error)] }; }
}

export async function abortNativeSpeed(runId: string): Promise<void> {
  if (!isNativeApp()) return;
  try { await (NetworkProbePlugin as unknown as { speedAbort(o: { runId: string }): Promise<unknown> }).speedAbort({ runId }); }
  catch { /* фаза уже завершилась */ }
}

export interface SpeedSampleEvent { runId: string; direction: 'download' | 'upload'; elapsedMs: number; bytes: number; confirmed: number }

export function onNativeSpeedSample(listener: (event: SpeedSampleEvent) => void): () => void {
  if (!isNativeApp()) return () => {};
  let disposed = false;
  let handle: PluginListenerHandle | undefined;
  void (NetworkProbePlugin as unknown as {
    addListener(name: 'speedSample', cb: (event: SpeedSampleEvent) => void): Promise<PluginListenerHandle>;
  }).addListener('speedSample', listener).then((value) => {
    if (disposed) void value.remove(); else handle = value;
  }).catch(() => { /* старый APK без событий: остаётся итоговый результат */ });
  return () => { disposed = true; if (handle) void handle.remove(); };
}
