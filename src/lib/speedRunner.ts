import { abortNativeSpeed, isNativeApp, nativeSpeedPhase, onNativeSpeedSample, realDelayProbe } from './nativeBridge';
import { availableSpeedServers, pickSpeedServer, speedEndpointError, type SpeedServer, type SpeedServerOptions, type SpeedServerProbe } from './speedEndpoints';
import {
  aggregateSpeed, bytesToMbps, latencyStats, planChunkBytes, planConnections,
  SPEED_BYTE_BUDGET, type SpeedAggregate, type SpeedSlice,
} from './speedTest';

/**
 * Оркестратор замера: пинг → разогрев → загрузка → отдача.
 * Транспорт разный (нативные сокеты в APK, fetch/XHR в браузере), но сэмплы и
 * итоговый расчёт одни и те же — поэтому цифры сравнимы между платформами.
 */
export type SpeedPhaseName = 'select' | 'ping' | 'warmup' | 'download' | 'upload' | 'done' | 'error';

export interface SpeedProgress {
  phase: SpeedPhaseName;
  /** Мгновенная скорость текущей фазы. */
  mbps: number;
  /** 0..1 по всей процедуре. */
  progress: number;
  message: string;
  server?: SpeedServer;
}

export interface SpeedPhaseRequest {
  runId: string;
  direction: 'download' | 'upload';
  urls: string[];
  connections: number;
  durationMs: number;
  chunkBytes: number;
  maxBytes: number;
  onSample?: (slice: SpeedSlice) => void;
  signal?: AbortSignal;
}

export interface SpeedPhaseResult {
  slices: SpeedSlice[];
  bytes: number;
  confirmed: number;
  errors: string[];
  route?: 'vpn' | 'direct' | 'unknown';
}

export interface SpeedTransport {
  latency(url: string, samples: number, signal?: AbortSignal, timeoutMs?: number): Promise<{ samples: number[]; error?: string }>;
  phase(request: SpeedPhaseRequest): Promise<SpeedPhaseResult>;
  abort(runId: string): void;
}

const PHASE_WEIGHT: Record<SpeedPhaseName, number> = { select: 0.05, ping: 0.1, warmup: 0.1, download: 0.45, upload: 0.3, done: 1, error: 1 };

// ------------------------------------------------------------------ native

export function nativeTransport(): SpeedTransport {
  return {
    async latency(url, samples, _signal, timeoutMs) {
      const result = await realDelayProbe(url, timeoutMs ?? 8000, Math.max(2, Math.min(7, samples)));
      if (!result.ok) return { samples: [], error: result.error || 'сервер не ответил' };
      return { samples: Array.isArray(result.samples) && result.samples.length ? result.samples : [result.latency_ms ?? 0] };
    },
    async phase(request) {
      const unsubscribe = request.onSample
        ? onNativeSpeedSample((event) => {
          if (event.runId !== request.runId) return;
          request.onSample!({ t: event.elapsedMs, bytes: event.bytes, confirmed: event.confirmed });
        })
        : () => {};
      const onAbort = () => { void abortNativeSpeed(request.runId); };
      request.signal?.addEventListener('abort', onAbort);
      try {
        const result = await nativeSpeedPhase({
          runId: request.runId, direction: request.direction, urls: request.urls,
          connections: request.connections, durationMs: request.durationMs,
          chunkBytes: request.chunkBytes, maxBytes: request.maxBytes,
        });
        return { slices: result.slices, bytes: result.bytes, confirmed: result.confirmed, errors: result.errors, route: result.route };
      } finally {
        unsubscribe();
        request.signal?.removeEventListener('abort', onAbort);
      }
    },
    abort(runId) { void abortNativeSpeed(runId); },
  };
}

// ----------------------------------------------------------------- browser

/** Браузерный транспорт: потоковое чтение fetch и XHR для отдачи с прогрессом. */
export function browserTransport(): SpeedTransport {
  const controllers = new Map<string, Set<AbortController>>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  const stop = (runId: string) => {
    for (const controller of controllers.get(runId) || []) controller.abort();
    controllers.delete(runId);
    const timer = timers.get(runId);
    if (timer) clearInterval(timer);
    timers.delete(runId);
  };

  return {
    async latency(url, samples, signal, timeoutMs) {
      const values: number[] = [];
      let error = '';
      let limited = '';
      for (let attempt = 0; attempt < samples + 1; attempt++) {
        if (signal?.aborted) break;
        const started = performance.now();
        // Без своего таймаута зависший сервер вешал весь замер на этапе выбора.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs ?? 5000));
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort);
        try {
          const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}pulse=${Date.now()}_${attempt}`, { cache: 'no-store', signal: controller.signal });
          await response.arrayBuffer();
          if (!response.ok) {
            error = `HTTP ${response.status}`;
            const retry = response.headers.get('Retry-After');
            if (response.status === 429) limited = `HTTP 429${retry ? ` Retry-After ${retry}` : ''}`;
            continue;
          }
          if (attempt > 0) values.push(performance.now() - started);
        } catch (err) {
          if (signal?.aborted) break;
          error = (err as Error)?.name === 'AbortError' ? `таймаут ${Math.round((timeoutMs ?? 5000) / 1000)} с`
            : err instanceof Error ? err.message : String(err);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      }
      return { samples: values, error: limited || (values.length ? undefined : error || 'сервер не ответил') };
    },
    async phase(request) {
      const set = new Set<AbortController>();
      controllers.set(request.runId, set);
      const started = performance.now();
      let bytes = 0;
      let confirmed = 0;
      const slices: SpeedSlice[] = [{ t: 0, bytes: 0, confirmed: 0 }];
      const errors: string[] = [];
      const sample = () => {
        const t = performance.now() - started;
        const slice = { t, bytes, confirmed };
        slices.push(slice);
        request.onSample?.(slice);
      };
      timers.set(request.runId, setInterval(sample, 100));
      const onAbort = () => stop(request.runId);
      request.signal?.addEventListener('abort', onAbort);
      const timeLeft = () => performance.now() - started < request.durationMs && bytes < request.maxBytes;

      const worker = async (index: number) => {
        const url = request.urls[index % request.urls.length];
        while (timeLeft() && !request.signal?.aborted) {
          const controller = new AbortController();
          set.add(controller);
          const target = `${url}${url.includes('?') ? '&' : '?'}pulse=${Date.now()}_${index}`;
          try {
            if (request.direction === 'download') {
              const response = await fetch(target, { cache: 'no-store', signal: controller.signal });
              if (!response.ok) {
                const retry = response.headers.get('Retry-After');
                errors.push(`HTTP ${response.status}${retry ? ` Retry-After ${retry}` : ''}`);
                break;
              }
              const reader = response.body?.getReader();
              if (!reader) { errors.push('Браузер не отдал поток ответа'); break; }
              while (timeLeft()) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                confirmed += value.byteLength;
              }
              try { await reader.cancel(); } catch { /* поток уже закрыт */ }
            } else {
              const payload = new Uint8Array(request.chunkBytes);
              // Несжимаемые данные: иначе замер измерит компрессию, а не канал.
              for (let offset = 0; offset < payload.length; offset += 4096) payload[offset] = (offset * 31 + index) & 0xff;
              await new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', target, true);
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.timeout = 20000;
                let counted = 0;
                xhr.upload.onprogress = (event) => {
                  const delta = event.loaded - counted;
                  counted = event.loaded;
                  if (delta > 0) bytes += delta;
                };
                xhr.onload = () => {
                  if (xhr.status >= 200 && xhr.status < 300) {
                    // Некоторые WebView не присылают upload.onprogress. Ответ 2xx на
                    // POST фиксированной длины означает, что тело получено целиком.
                    if (counted === 0) { counted = request.chunkBytes; bytes += counted; }
                    confirmed += counted;
                    resolve();
                  }
                  else { errors.push(`HTTP ${xhr.status}${xhr.getResponseHeader('Retry-After') ? ` Retry-After ${xhr.getResponseHeader('Retry-After')}` : ''}`); reject(new Error(`HTTP ${xhr.status}`)); }
                };
                xhr.onerror = () => { errors.push('Соединение прервано'); reject(new Error('upload failed')); };
                xhr.ontimeout = () => { errors.push('timeout при отдаче'); reject(new Error('timeout')); };
                controller.signal.addEventListener('abort', () => xhr.abort());
                xhr.send(payload);
              });
            }
          } catch (err) {
            if ((err as Error)?.name === 'AbortError') break;
            if (!errors.length) errors.push(err instanceof Error ? err.message : String(err));
            break;
          } finally { set.delete(controller); }
        }
      };
      try {
        await Promise.all(Array.from({ length: request.connections }, (_, index) => worker(index)));
      } finally {
        sample();
        stop(request.runId);
        request.signal?.removeEventListener('abort', onAbort);
      }
      return { slices, bytes, confirmed, errors, route: 'unknown' };
    },
    abort(runId) { stop(runId); },
  };
}

export function defaultTransport(): SpeedTransport {
  return isNativeApp() ? nativeTransport() : browserTransport();
}

// ------------------------------------------------------------- orchestration

export interface SpeedTestOptions extends SpeedServerOptions {
  server?: SpeedServer;
  transport?: SpeedTransport;
  signal?: AbortSignal;
  onProgress?: (progress: SpeedProgress) => void;
  downloadMs?: number;
  uploadMs?: number;
  pingSamples?: number;
  /** Экономный режим: короче фазы и меньше трафика на мобильном тарифе. */
  lite?: boolean;
}

export const SPEED_TRAFFIC = {
  full: { downloadMs: 10000, uploadMs: 8000, download: SPEED_BYTE_BUDGET.download, upload: SPEED_BYTE_BUDGET.upload },
  lite: { downloadMs: 5000, uploadMs: 4000, download: 25 * 1024 * 1024, upload: 8 * 1024 * 1024 },
};

export interface SpeedTestResult {
  ok: boolean;
  server: SpeedServer | null;
  download: SpeedAggregate;
  upload: SpeedAggregate;
  pingMs: number | null;
  jitterMs: number | null;
  pingSamples: number[];
  /** Медиана задержки во время загрузки (bufferbloat), null — не измерена. */
  loadedPingMs: number | null;
  /** Пользователь нажал «Остановить»: цифры есть, но замер неполный. */
  aborted: boolean;
  /** Почему выбрана эта точка замера. */
  serverReason: string;
  route: 'vpn' | 'direct' | 'unknown';
  error: string;
  finishedAt: string;
}

/** Пауза, которая не переживает отмену и не держит таймер после неё. */
function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });
}

const EMPTY_AGGREGATE: SpeedAggregate = { mbps: 0, averageMbps: 0, peakMbps: 0, bytes: 0, durationMs: 0,
  usedIntervals: 0, totalIntervals: 0, reliable: false, reason: 'Замер не выполнялся' };

export async function runSpeedTest(options: SpeedTestOptions = {}): Promise<SpeedTestResult> {
  const transport = options.transport ?? defaultTransport();
  const runId = `speed-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const report = (phase: SpeedPhaseName, mbps: number, message: string, server?: SpeedServer, within = 1) => {
    const base = phase === 'select' ? 0 : phase === 'ping' ? 0.05 : phase === 'warmup' ? 0.15 : phase === 'download' ? 0.25 : phase === 'upload' ? 0.7 : 0.98;
    options.onProgress?.({ phase, mbps, progress: Math.min(1, base + PHASE_WEIGHT[phase] * within), message, server });
  };
  const result: SpeedTestResult = { ok: false, server: null, download: EMPTY_AGGREGATE, upload: EMPTY_AGGREGATE,
    pingMs: null, jitterMs: null, pingSamples: [], loadedPingMs: null, aborted: false, serverReason: '',
    route: 'unknown', error: '', finishedAt: new Date().toISOString() };

  const budget = options.lite ? SPEED_TRAFFIC.lite : SPEED_TRAFFIC.full;
  const downloadMs = options.downloadMs ?? budget.downloadMs;
  const uploadMs = options.uploadMs ?? budget.uploadMs;
  const candidates = options.server ? [options.server] : availableSpeedServers(options);
  report('select', 0, candidates.length > 1 ? `Сравниваем задержку до ${candidates.length} точек…` : 'Проверяем точку замера…');
  // Параллельно и с таймаутом: медленная точка не задерживает выбор, а выбор
  // идёт по задержке, а не по порядку в списке.
  const probes: SpeedServerProbe[] = await Promise.all(candidates.map(async (candidate) => {
    const probe = await transport.latency(candidate.ping, options.pingSamples ?? 5, options.signal, 4000);
    const stats = latencyStats(probe.samples);
    return { server: candidate, pingMs: stats.pingMs, samples: probe.samples, error: probe.error };
  }));
  const choice = pickSpeedServer(probes);
  const server = choice.server;
  if (!server) {
    result.aborted = Boolean(options.signal?.aborted);
    result.error = result.aborted ? 'Замер остановлен' : `Нет доступного сервера замера. ${choice.reason}`;
    report('error', 0, result.error);
    return result;
  }
  const pingSamples = choice.samples;
  result.server = server;
  result.serverReason = choice.reason;
  const stats = latencyStats(pingSamples);
  result.pingMs = stats.pingMs;
  result.jitterMs = stats.jitterMs;
  result.pingSamples = pingSamples;
  report('ping', 0, `${server.label} · ${choice.reason}`, server);
  let loadedCleanup: (() => void) | null = null;

  try {
    // Разогрев: небольшая загрузка даёт оценку канала для числа соединений и размера куска.
    report('warmup', 0, 'Разогреваем соединение…', server);
    const warmup = await transport.phase({
      runId: `${runId}-warmup`, direction: 'download', urls: [server.download(1_000_000)],
      connections: 2, durationMs: 2500, chunkBytes: 1_000_000, maxBytes: 3_000_000, signal: options.signal,
    });
    const warmSlice = warmup.slices[warmup.slices.length - 1];
    const estimate = warmSlice ? bytesToMbps(warmSlice.confirmed, warmSlice.t) : 0;
    const connections = planConnections(estimate);
    const chunkBytes = planChunkBytes(estimate);

    // Задержка под нагрузкой: маленькие запросы идут параллельно основной фазе и
    // показывают очередь в буферах. В браузере пробуем во время отдачи: там
    // всего 2–4 соединения, и проба не стоит в очереди за шестью загрузками
    // (лимит пула на хост иначе выдал бы её ожидание за лаг канала). В APK
    // сокеты свои, поэтому мерим прямо во время загрузки.
    let loadedPingMs: number | null = null;
    const loadedController = new AbortController();
    const onOuterAbort = () => loadedController.abort();
    options.signal?.addEventListener('abort', onOuterAbort);
    let loadedTask: Promise<void> = Promise.resolve();
    const startLoadedProbe = (delayMs: number) => {
      loadedTask = (async () => {
        await waitMs(delayMs, loadedController.signal);
        if (loadedController.signal.aborted) return;
        const probe = await transport.latency(server!.ping, options.lite ? 2 : 3, loadedController.signal, 2500);
        loadedPingMs = latencyStats(probe.samples).pingMs;
      })().catch(() => {});
    };
    loadedCleanup = () => { loadedController.abort(); options.signal?.removeEventListener('abort', onOuterAbort); };
    const finishLoadedProbe = async () => {
      // Проба крошечная (нулевое тело): даём ей до 900 мс доехать, иначе на
      // быстром канале фаза кончается раньше ответа и цифра пропадает.
      await Promise.race([loadedTask, waitMs(900, options.signal)]);
      loadedController.abort();
      options.signal?.removeEventListener('abort', onOuterAbort);
      result.loadedPingMs = loadedPingMs;
    };
    const native = isNativeApp();
    if (native) startLoadedProbe(Math.min(1200, Math.round(downloadMs * 0.2)));

    report('download', 0, `Загрузка · ${connections} соединений`, server, 0);
    const download = await transport.phase({
      runId: `${runId}-down`, direction: 'download',
      urls: Array.from({ length: connections }, () => server!.download(chunkBytes)),
      connections, durationMs: downloadMs, chunkBytes,
      maxBytes: budget.download, signal: options.signal,
      onSample: (slice) => report('download', bytesToMbps(slice.confirmed, slice.t), 'Загрузка…', server, Math.min(1, slice.t / downloadMs)),
    });
    result.download = aggregateSpeed(download.slices);
    result.route = download.route ?? 'unknown';
    result.aborted = Boolean(options.signal?.aborted);
    if (!download.confirmed) {
      await finishLoadedProbe();
      result.error = speedEndpointError(download.errors, server);
      report('error', 0, result.error, server);
      return result;
    }

    if (!options.signal?.aborted) {
      const uploadConnections = Math.max(2, Math.min(4, connections));
      // Без задержки: на быстром канале бюджет байт выбирается за доли секунды,
      // и отложенная проба не успела бы пройти. Первый запрос пробы и так
      // отбрасывается как разогрев, поэтому измеряется уже нагруженный канал.
      if (!native) startLoadedProbe(0);
      report('upload', 0, `Отдача · ${uploadConnections} соединений`, server, 0);
      // Мелкие куски: подтверждение сервера приходит чаще, итог ближе к реальности.
      const uploadChunk = Math.max(262_144, Math.min(512 * 1024, Math.round(chunkBytes / 4)));
      const upload = await transport.phase({
        runId: `${runId}-up`, direction: 'upload', urls: Array.from({ length: uploadConnections }, () => server!.upload),
        connections: uploadConnections, durationMs: uploadMs, chunkBytes: uploadChunk,
        maxBytes: budget.upload, signal: options.signal,
        onSample: (slice) => report('upload', bytesToMbps(slice.bytes, slice.t), 'Отдача…', server, Math.min(1, slice.t / uploadMs)),
      });
      result.upload = aggregateSpeed(upload.slices, { field: 'bytes' });
      if (!upload.confirmed && upload.errors.length) result.error = speedEndpointError(upload.errors, server);
    }
    await finishLoadedProbe();
    result.ok = result.download.bytes > 0;
    result.aborted = Boolean(options.signal?.aborted);
    if (result.aborted) result.download = { ...result.download, reliable: false,
      reason: 'Замер остановлен вручную — цифра приблизительная' };
    result.finishedAt = new Date().toISOString();
    report('done', result.download.mbps, result.error || (result.aborted ? 'Замер остановлен' : 'Замер завершён'), server);
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    report('error', 0, result.error, server);
    return result;
  } finally {
    loadedCleanup?.();
    transport.abort(`${runId}-down`);
    transport.abort(`${runId}-up`);
    transport.abort(`${runId}-warmup`);
  }
}
