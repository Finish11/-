import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTransport, runSpeedTest, type SpeedPhaseRequest, type SpeedTransport } from '../src/lib/speedRunner.ts';
import { CLOUDFLARE_SPEED, pickSpeedServer, type SpeedServer } from '../src/lib/speedEndpoints.ts';

/**
 * Оркестратор замера проверяется подставным транспортом: реальные сокеты не
 * нужны, а выбор точки, разогрев, остановка и учёт байтов проверяются точно.
 */
const OWN: SpeedServer = {
  id: 'own:test', label: 'Своя точка', source: 'own',
  ping: 'https://own.test/api/speed/ping',
  download: (bytes) => `https://own.test/api/speed/down?bytes=${bytes}`,
  upload: 'https://own.test/api/speed/up',
};

interface FakeOptions {
  latency?: Record<string, number>;
  errors?: Record<string, string>;
  /** Мбит/с, которые «держит» канал в фазе загрузки. */
  downMbps?: number;
  upMbps?: number;
  /** Сколько байт подтверждает сервер за фазу отдачи. */
  uploadConfirmed?: number;
  loadedLatency?: number;
  onPhase?: (request: SpeedPhaseRequest) => void;
}

function fakeTransport(options: FakeOptions = {}) {
  const phases: SpeedPhaseRequest[] = [];
  let latencyCalls = 0;
  const transport: SpeedTransport = {
    async latency(url, samples, signal) {
      latencyCalls += 1;
      const key = Object.keys(options.latency || {}).find((entry) => url.includes(entry));
      const errorKey = Object.keys(options.errors || {}).find((entry) => url.includes(entry));
      if (signal?.aborted) return { samples: [], error: 'остановлено' };
      // Под нагрузкой = когда основная фаза уже идёт, а не по номеру вызова.
      if (options.loadedLatency != null && phases.length > 0 && url.includes('own.test'))
        return { samples: Array.from({ length: samples }, () => options.loadedLatency!) };
      if (errorKey) return { samples: [], error: options.errors![errorKey] };
      if (!key) return { samples: [], error: 'нет ответа' };
      return { samples: Array.from({ length: samples }, () => options.latency![key]) };
    },
    async phase(request) {
      phases.push(request);
      options.onPhase?.(request);
      const mbps = request.direction === 'download' ? options.downMbps ?? 100 : options.upMbps ?? 20;
      const slices = [{ t: 0, bytes: 0, confirmed: 0 }];
      const steps = 20;
      const bytesPerSecond = mbps * 1_000_000 / 8;
      const total = Math.min(request.maxBytes, Math.round(bytesPerSecond * (request.durationMs / 1000)));
      // Быстрый канал выбирает бюджет байт раньше, чем истекает время фазы.
      const spanMs = Math.min(request.durationMs, (total / bytesPerSecond) * 1000);
      const wallStepMs = Math.min(spanMs, 240) / steps;
      for (let index = 1; index <= steps; index++) {
        if (request.signal?.aborted && index > steps / 2) break;
        if (wallStepMs > 0) await new Promise((resolve) => setTimeout(resolve, wallStepMs));
        const bytes = Math.round(total * (index / steps));
        const confirmed = request.direction === 'upload' ? options.uploadConfirmed ?? bytes : bytes;
        const slice = { t: (spanMs * index) / steps, bytes, confirmed: Math.min(confirmed, bytes) };
        slices.push(slice);
        request.onSample?.(slice);
      }
      const last = slices[slices.length - 1];
      return { slices, bytes: last.bytes, confirmed: last.confirmed, errors: [], route: 'vpn' };
    },
    abort() {},
  };
  return { transport, phases, latencyCalls: () => latencyCalls };
}

test('точка замера выбирается по задержке, а не по порядку в списке', () => {
  const probes = [
    { server: OWN, pingMs: 140, samples: [140] },
    { server: CLOUDFLARE_SPEED, pingMs: 20, samples: [20] },
  ];
  const choice = pickSpeedServer(probes);
  assert.equal(choice.server?.id, CLOUDFLARE_SPEED.id, 'своя точка в 7 раз медленнее — брать её нельзя');
  assert.match(choice.reason, /Ближайшая из 2/);
  assert.equal(choice.reachable, 2);
});

test('при близкой задержке своя точка важнее: у публичной чужие лимиты', () => {
  const choice = pickSpeedServer([
    { server: OWN, pingMs: 24, samples: [24] },
    { server: CLOUDFLARE_SPEED, pingMs: 20, samples: [20] },
  ]);
  assert.equal(choice.server?.id, OWN.id);
  assert.match(choice.reason, /без чужих лимитов/);
});

test('точка, ответившая 429, не участвует в выборе даже с измеренной задержкой', () => {
  const choice = pickSpeedServer([
    { server: CLOUDFLARE_SPEED, pingMs: 5, samples: [5], error: 'HTTP 429 Retry-After 3566' },
    { server: OWN, pingMs: 60, samples: [60] },
  ]);
  assert.equal(choice.server?.id, OWN.id);
  const none = pickSpeedServer([{ server: CLOUDFLARE_SPEED, pingMs: null, samples: [], error: 'HTTP 429' }]);
  assert.equal(none.server, null);
  assert.match(none.reason, /429/);
});

test('оркестратор опрашивает все точки и берёт быструю', async () => {
  const fake = fakeTransport({ latency: { 'own.test': 150, 'speed.cloudflare.com': 20 }, downMbps: 80, upMbps: 15 });
  const result = await runSpeedTest({ transport: fake.transport, webOrigin: 'https://own.test', lite: true });
  assert.equal(result.ok, true);
  assert.equal(result.server?.id, CLOUDFLARE_SPEED.id);
  assert.equal(result.pingMs, 20);
  assert.match(result.serverReason, /Ближайшая/);
  assert.equal(result.route, 'vpn', 'маршрут берётся из транспорта, а не угадывается');
});

test('недоступные точки дают внятную ошибку, а не нулевую скорость', async () => {
  const fake = fakeTransport({ errors: { 'own.test': 'timeout', 'speed.cloudflare.com': 'HTTP 429' } });
  const phases: string[] = [];
  const result = await runSpeedTest({
    transport: fake.transport, webOrigin: 'https://own.test',
    onProgress: (progress) => phases.push(progress.phase),
  });
  assert.equal(result.ok, false);
  assert.equal(result.download.mbps, 0);
  assert.match(result.error, /Нет доступного сервера замера/);
  assert.match(result.error, /429/);
  assert.equal(phases.at(-1), 'error');
  assert.equal(fake.phases.length, 0, 'фаза загрузки не запускается без сервера');
});

test('задержка под нагрузкой измеряется во время загрузки и попадает в результат', async () => {
  const fake = fakeTransport({
    latency: { 'own.test': 20 }, loadedLatency: 180, downMbps: 90, upMbps: 20,
  });
  const result = await runSpeedTest({ transport: fake.transport, server: OWN, downloadMs: 400, uploadMs: 200 });
  assert.equal(result.pingMs, 20);
  assert.equal(result.loadedPingMs, 180, 'очередь в буферах должна быть видна');
  assert.ok(fake.latencyCalls() >= 2, 'проба под нагрузкой действительно выполнялась');
});

test('остановка помечается честно и не запускает отдачу', async () => {
  const controller = new AbortController();
  const fake = fakeTransport({
    latency: { 'own.test': 15 }, downMbps: 100,
    onPhase: (request) => { if (request.runId.endsWith('-down')) controller.abort(); },
  });
  const result = await runSpeedTest({ transport: fake.transport, server: OWN, signal: controller.signal, downloadMs: 400, uploadMs: 400 });
  assert.equal(result.aborted, true);
  assert.equal(result.download.reliable, false);
  assert.match(result.download.reason, /остановлен вручную/);
  assert.ok(!fake.phases.some((phase) => phase.runId.endsWith('-up')), 'после остановки отдача не идёт');
});

test('отдача не обнуляется из-за редких подтверждений сервера', async () => {
  const fake = fakeTransport({ latency: { 'own.test': 12 }, downMbps: 5, upMbps: 5, uploadConfirmed: 0 });
  const result = await runSpeedTest({ transport: fake.transport, server: OWN, downloadMs: 3000, uploadMs: 3000 });
  assert.ok(result.upload.mbps > 4 && result.upload.mbps < 6, `ожидалось ~5 Мбит/с, получено ${result.upload.mbps}`);
});

test('быстрый разогрев добавляет соединения, медленный — нет', async () => {
  const fast = fakeTransport({ latency: { 'own.test': 10 }, downMbps: 600, upMbps: 100 });
  await runSpeedTest({ transport: fast.transport, server: OWN, downloadMs: 300, uploadMs: 200 });
  const slow = fakeTransport({ latency: { 'own.test': 10 }, downMbps: 4, upMbps: 1 });
  await runSpeedTest({ transport: slow.transport, server: OWN, downloadMs: 300, uploadMs: 200 });
  const connections = (phases: SpeedPhaseRequest[]) => phases.find((phase) => phase.runId.endsWith('-down'))!.connections;
  assert.ok(connections(fast.phases) > connections(slow.phases),
    `быстрый канал: ${connections(fast.phases)}, медленный: ${connections(slow.phases)}`);
  assert.ok(connections(fast.phases) <= 8, 'больше 8 соединений не открываем');
});

test('проба точки не висит вечно: у браузерного транспорта есть свой таймаут', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  })) as typeof fetch;
  try {
    const started = Date.now();
    const probe = await browserTransport().latency('https://slow.test/ping', 1, undefined, 500);
    assert.equal(probe.samples.length, 0);
    assert.match(probe.error || '', /таймаут/);
    assert.ok(Date.now() - started < 5000, 'две попытки по 500 мс, а не бесконечность');
  } finally { globalThis.fetch = original; }
});

test('внешняя отмена прерывает пробу сразу', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  })) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = browserTransport().latency('https://slow.test/ping', 5, controller.signal, 5000);
    setTimeout(() => controller.abort(), 60);
    const started = Date.now();
    await pending;
    assert.ok(Date.now() - started < 1000);
  } finally { globalThis.fetch = original; }
});

test('браузерная фаза: 403 одного адреса не обрывает замер, соединение берёт живой', async () => {
  const original = globalThis.fetch;
  const hits: string[] = [];
  // Первый адрес отвечает 403 (как протухший videoplayback), второй отдаёт данные.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    hits.push(url);
    if (url.includes('dead.test')) {
      return new Response('forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
    }
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8) { controller.close(); return; }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  }) as typeof fetch;
  try {
    const phase = await browserTransport().phase({
      runId: 'yt-browser', direction: 'download',
      urls: ['https://dead.test/videoplayback?itag=18', 'https://live.test/videoplayback?itag=18'],
      // Одно соединение: без ротации оно бы навсегда осталось на отказавшем адресе.
      connections: 1, durationMs: 700, chunkBytes: 65536, maxBytes: 4 * 1024 * 1024,
    });
    assert.ok(phase.confirmed > 0, 'живой адрес обязан дать байты, даже если первый отвечает 403');
    assert.ok(phase.errors.some((item) => item.includes('403')), 'отказ не скрывается из отчёта');
    assert.ok(new Set(hits.map((url) => url.split('/')[2])).size > 1, 'соединения попробовали оба адреса');
  } finally { globalThis.fetch = original; }
});
