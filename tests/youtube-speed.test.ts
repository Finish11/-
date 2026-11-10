import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOUTUBE_QUALITIES, YOUTUBE_HEADROOM, requiredMbps, youtubeQualityVerdict, rateLabel,
  extractGoogleVideoUrl, extractGoogleVideoUrls, runYoutubeProbe, youtubeSourceLabel, YOUTUBE_CDN_URLS,
} from '../src/lib/youtubeSpeed.ts';
import { readFileSync } from 'node:fs';
import type { SpeedTransport, SpeedPhaseRequest, SpeedPhaseResult } from '../src/lib/speedRunner.ts';

test('2× требует вдвое больше канала, чем 1×', () => {
  const hd = YOUTUBE_QUALITIES.find((item) => item.id === '1080p')!;
  const once = requiredMbps(hd, 1);
  const twice = requiredMbps(hd, 2);
  assert.equal(Math.round((twice / once) * 100) / 100, 2);
  // Запас на служебный трафик обязателен: «впритык» — это буферизация.
  assert.ok(once > hd.mbps);
  assert.equal(once, Math.round(hd.mbps * YOUTUBE_HEADROOM * 100) / 100);
  assert.equal(requiredMbps(hd, 0), once, 'нулевая скорость не должна обнулять потребность');
  assert.equal(requiredMbps(hd, Number.NaN), once);
});

test('качество подбирается по скорости с учётом ускорения', () => {
  // 8 Мбит/с: на 1× хватает 1080p (6), на 2× — только 720p (те же 6).
  const normal = youtubeQualityVerdict(8, 1);
  const fast = youtubeQualityVerdict(8, 2);
  assert.equal(normal.best?.id, '1080p');
  assert.equal(fast.best?.id, '720p');
  assert.ok(fast.next);
  assert.ok(fast.neededForNext! > 8);
  assert.match(fast.label, /2×/);
  // Канал с большим запасом не помечается как «впритык».
  assert.equal(youtubeQualityVerdict(100, 2).tone, 'ok');
  assert.equal(youtubeQualityVerdict(100, 2).best?.id, '2160p');
});

test('медленный канал даёт честный отказ, а не круглый ноль', () => {
  const verdict = youtubeQualityVerdict(0.05, 2);
  assert.equal(verdict.best, null);
  assert.equal(verdict.tone, 'bad');
  assert.match(verdict.label, /Не хватит даже на 144p/);
  assert.match(verdict.detail, /замедление или блокировку/);
  assert.equal(youtubeQualityVerdict(null, 2).best, null);
  assert.equal(youtubeQualityVerdict(undefined, 1).best, null);
  assert.equal(youtubeQualityVerdict(Number.NaN, 2).tone, 'bad');
});

test('граница качества считается по потребности, а не по голому битрейту', () => {
  const hd = YOUTUBE_QUALITIES.find((item) => item.id === '1080p')!;
  const need = requiredMbps(hd, 2);
  assert.equal(youtubeQualityVerdict(need, 2).best?.id, '1080p');
  assert.equal(youtubeQualityVerdict(need - 0.01, 2).best?.id, '720p60');
  // Ровно на границе запас минимальный — это «впритык», а не уверенное «хватит».
  assert.equal(youtubeQualityVerdict(need, 2).tone, 'warn');
  assert.equal(rateLabel(1.25), '1,25×');
  assert.equal(rateLabel(2), '2×');
});

test('прямая ссылка на поток достаётся только без расшифровки подписи', () => {
  const plain = '{"streamingData":{"formats":[{"url":"https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&itag=18&mime=video%2Fmp4"}]}}';
  assert.match(extractGoogleVideoUrl(plain)!, /^https:\/\/rr3---sn-abc\.googlevideo\.com\/videoplayback\?/);
  const escaped = '{"url":"https://rr1.googlevideo.com/videoplayback?itag=18\\u0026mime=video%2Fmp4"}';
  assert.equal(extractGoogleVideoUrl(escaped)!.includes('\\u0026'), false);
  assert.match(extractGoogleVideoUrl(escaped)!, /itag=18&mime=/);
  // Подписанные ссылки не расшифровываем и не выдаём за готовые.
  assert.equal(extractGoogleVideoUrl('{"signatureCipher":"s=abc&url=https%3A%2F%2Frr1.googlevideo.com%2Fvideoplayback"}'), null);
  assert.equal(extractGoogleVideoUrl('<html>ничего нет</html>'), null);
  assert.equal(extractGoogleVideoUrl(''), null);
});

/** Транспорт-заглушка: считает байты детерминированно, без сети. */
function fakeTransport(options: {
  downBytes?: number; failFirst?: boolean; pingMs?: number; videoPingMs?: number;
}): SpeedTransport & { calls: SpeedPhaseRequest[] } {
  const calls: SpeedPhaseRequest[] = [];
  return {
    calls,
    async latency(url) {
      const value = url.includes('googlevideo') ? options.videoPingMs : options.pingMs;
      return value == null ? { samples: [], error: 'не ответил' } : { samples: [value, value + 2, value + 1] };
    },
    async phase(request): Promise<SpeedPhaseResult> {
      calls.push(request);
      const google = request.urls.some((url) => url.includes('googlevideo'));
      if (google && options.failFirst) return { slices: [], bytes: 0, confirmed: 0, errors: ['HTTP 403'] };
      const total = options.downBytes ?? 6_000_000;
      const slices = Array.from({ length: 10 }, (_, index) => ({
        t: (index + 1) * 500, bytes: Math.round((total * (index + 1)) / 10), confirmed: Math.round((total * (index + 1)) / 10),
      }));
      return { slices, bytes: total, confirmed: total, errors: [] };
    },
    abort() {},
  };
}

test('замер предпочитает видеоголовку и честно называет источник', async () => {
  const transport = fakeTransport({ pingMs: 40, videoPingMs: 55 });
  const result = await runYoutubeProbe({
    transport, fetchHtml: async () => '{"url":"https://rr1.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4"}',
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'googlevideo');
  assert.equal(result.pingMs, 41);
  assert.equal(result.videoPingMs, 56);
  assert.ok(result.mbps > 0);
  assert.match(result.note, /googlevideo/);
  assert.equal(transport.calls.length, 1, 'при удачной видеоголовке CDN не трогаем');
  assert.equal(youtubeSourceLabel(result.source!), 'видеоголовка googlevideo');
});

test('если поток не отдал байты — переход на CDN с пометкой, а не молча', async () => {
  // Пинги живые: страница ролика запрашивается, ссылка есть, но видеоголовка отдаёт 403.
  const transport = fakeTransport({ failFirst: true, pingMs: 40, videoPingMs: 50 });
  const result = await runYoutubeProbe({
    transport, fetchHtml: async () => '{"url":"https://rr1.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4"}',
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'ytimg');
  assert.match(result.note, /ориентировочная/);
  assert.ok(result.errors.some((item) => item.includes('403')));
  assert.deepEqual(transport.calls[1].urls, YOUTUBE_CDN_URLS);
});

test('полная недоступность YouTube не выдаётся за быстрый канал', async () => {
  const transport = fakeTransport({ downBytes: 0 });
  const result = await runYoutubeProbe({ transport, fetchHtml: async () => { throw new Error('таймаут'); } });
  assert.equal(result.ok, false);
  assert.equal(result.mbps, 0);
  assert.equal(result.source, null);
  // В Node нет Capacitor: приложение считает себя браузером и объясняет CORS.
  // В обоих случаях главное — цифра не выдумана и блокировка не названа скоростью.
  assert.match(result.note, /не отдал ни байта|CORS/);
  assert.ok(result.errors.some((item) => item.includes('Страница ролика не открылась')));
});

test('остановленный замер помечается и не продолжается', async () => {
  const controller = new AbortController();
  const transport = fakeTransport({ pingMs: 40, videoPingMs: 50 });
  const task = runYoutubeProbe({
    transport, signal: controller.signal,
    fetchHtml: async () => { controller.abort(); return ''; },
  });
  const result = await task;
  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(transport.calls.length, 0, 'после остановки байты не качаем');
});

test('экономный режим тратит меньше трафика и времени', async () => {
  const transport = fakeTransport({});
  await runYoutubeProbe({ transport, lite: true, fetchHtml: async () => '' });
  const lite = transport.calls[0];
  assert.ok(lite.durationMs <= 4000);
  assert.ok(lite.maxBytes <= 8 * 1024 * 1024);
  const full = fakeTransport({});
  await runYoutubeProbe({ transport: full, fetchHtml: async () => '' });
  assert.ok(full.calls[0].durationMs > lite.durationMs);
  assert.ok(full.calls[0].maxBytes > lite.maxBytes);
});

// --------------------------------------------------- отказоустойчивость замера

/** Транспорт, который ведёт себя как настоящий YouTube: часть адресов отказывает. */
function resilientTransport(options: {
  /** Адреса, отвечающие 403 — как протухшая ссылка videoplayback. */
  refuse?: (url: string) => boolean;
  /** Мбит/с, если адрес не отказал. */
  mbps?: number;
  pingError?: string;
}): SpeedTransport & { calls: SpeedPhaseRequest[] } {
  const calls: SpeedPhaseRequest[] = [];
  return {
    calls,
    async latency() {
      if (options.pingError) return { samples: [], error: options.pingError };
      return { samples: [30, 32, 31] };
    },
    async phase(request) {
      calls.push(request);
      const alive = request.urls.filter((url) => !(options.refuse?.(url) ?? false));
      if (!alive.length) return { slices: [], bytes: 0, confirmed: 0, errors: ['HTTP 403'] };
      const bytesPerSecond = ((options.mbps ?? 12) * 1_000_000) / 8;
      const span = Math.min(request.durationMs, 6000);
      const slices = Array.from({ length: 12 }, (_, index) => {
        const t = (span * (index + 1)) / 12;
        const total = Math.round((bytesPerSecond * t) / 1000);
        return { t, bytes: total, confirmed: total };
      });
      const last = slices[slices.length - 1];
      return { slices, bytes: last.bytes, confirmed: last.confirmed, errors: [] };
    },
    abort() {},
  };
}

test('403 у видеоголовки не обнуляет замер: цифра берётся с CDN', async () => {
  // Ровно тот случай из жалобы: YouTube через VPN работает, а замер показывал 0 бит.
  const transport = resilientTransport({ refuse: (url) => url.includes('googlevideo') });
  const result = await runYoutubeProbe({
    transport, fetchHtml: async () => '{"url":"https://rr1.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4"}',
  });
  assert.equal(result.ok, true, 'замер обязан дать цифру, а не ноль');
  assert.ok(result.mbps > 0);
  assert.equal(result.source, 'ytimg');
  assert.equal(result.verdict, 'ok');
  assert.ok(result.errors.some((item) => item.includes('403')));
});

test('замер не тянется бесконечно: у всей процедуры есть бюджет', async () => {
  // Транспорт, который «висит» дольше любого разумного времени.
  const hanging: SpeedTransport = {
    async latency() { return { samples: [], error: 'timeout: сервер не ответил' }; },
    async phase(request) { return { slices: [], bytes: 0, confirmed: 0, errors: ['timeout'] }; },
    abort() {},
  };
  const startedAt = Date.now();
  const result = await runYoutubeProbe({
    transport: hanging, deadlineMs: 8000, native: true,
    fetchHtml: async () => { throw new Error('timeout'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'blocked');
  assert.ok(Date.now() - startedAt < 9000, 'без сети замер обязан завершиться сам');
  assert.ok(result.elapsedMs >= 0);
});

test('«нет сети» отличается от «YouTube заблокирован»', async () => {
  const offline: SpeedTransport = {
    async latency() { return { samples: [], error: 'DNS: домен не резолвится (UnknownHostException)' }; },
    async phase() { return { slices: [], bytes: 0, confirmed: 0, errors: ['DNS: домен не резолвится'] }; },
    abort() {},
  };
  const result = await runYoutubeProbe({
    transport: offline, native: true, fetchHtml: async () => { throw new Error('DNS: домен не резолвится'); },
  });
  assert.equal(result.ok, false);
  assert.ok(['offline', 'blocked'].includes(result.verdict));
  assert.match(result.note, /не открывается|не отдал ни байта/);
});

test('очень медленный YouTube помечается отдельно от быстрого', async () => {
  const slow = resilientTransport({ mbps: 0.08 });
  const result = await runYoutubeProbe({ transport: slow, fetchHtml: async () => '' });
  assert.equal(result.ok, true);
  assert.equal(result.slow, true);
  assert.equal(result.verdict, 'slow');
  assert.match(result.note, /замедление/);
});

test('несколько прямых ссылок: в замер уходят первые две, лёгкий формат первым', () => {
  const html = '{"url":"https://rr1.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4"}'
    + '{"url":"https://rr1.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4"}';
  const links = extractGoogleVideoUrls(html);
  assert.equal(links.length, 2);
  assert.match(links[0], /itag=18/, 'лёгкий 360p первым: быстрее показывает реальную скорость');
  assert.equal(extractGoogleVideoUrl(html), links[0]);
});

test('нативный транспорт передаёт таймаут попытки в Java', async () => {
  const source = readFileSync('android/app/src/main/java/ru/pulsenet/app/NetworkProbePlugin.java', 'utf8');
  // Без своего таймаута зависший адрес держал фазу до конца бюджета.
  assert.match(source, /call\.getInt\("timeoutMs", 15000\)/);
  assert.match(source, /NetUtil\.open\(context, network, url, readTimeout/);
  // 403/410 одного адреса не может отменять фазу целиком.
  assert.match(source, /deadTargets\.add\(target\)/);
  assert.match(source, /pickTarget\(targets, deadTargets\)/);
});

test('без VPN не ждём страницу ролика: сначала короткая проверка CDN', async () => {
  let fetchedPages = 0;
  const phases: SpeedPhaseRequest[] = [];
  const dead: SpeedTransport = {
    async latency() { return { samples: [], error: 'timeout: сервер не ответил' }; },
    async phase(request) {
      phases.push(request);
      return { slices: [], bytes: 0, confirmed: 0, errors: ['HTTP 403'] };
    },
    abort() {},
  };
  const result = await runYoutubeProbe({
    transport: dead, native: true,
    fetchHtml: async () => { fetchedPages += 1; return ''; },
  });
  assert.equal(result.ok, false);
  assert.equal(fetchedPages, 0, 'страницу ролика не тянем, если служебные адреса молчат');
  // CDN обязан быть испробован до вердикта: иначе «не отдал ни байта» — враньё.
  assert.ok(phases[0]?.urls.every((url) => url.includes('ytimg')), `первая фаза — CDN, а не ${phases[0]?.urls[0]}`);
  assert.ok(result.errors.some((item) => item.includes('не запрашивали')));
  assert.equal(result.verdict, 'blocked');
});

test('зависший транспорт не держит экран: предохранитель заканчивает замер сам', async () => {
  // Худший случай: сокет открылся, но ответа нет и промис не завершается никогда.
  const never = <T,>() => new Promise<T>(() => {});
  const stuck: SpeedTransport = {
    latency: () => never(),
    phase: () => never(),
    abort() {},
  };
  const startedAt = Date.now();
  const result = await runYoutubeProbe({
    transport: stuck, native: true, deadlineMs: 8000,
    fetchHtml: () => never(),
  });
  const spent = Date.now() - startedAt;
  assert.ok(spent < 9000, `замер обязан завершиться сам, а не висеть (${spent} мс)`);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'offline');
  assert.match(result.note, /не ответил за 8 с/);
  assert.equal(result.aborted, false, 'это не остановка пользователем');
});
