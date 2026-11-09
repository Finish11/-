import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOUTUBE_QUALITIES, YOUTUBE_HEADROOM, requiredMbps, youtubeQualityVerdict, rateLabel,
  extractGoogleVideoUrl, runYoutubeProbe, youtubeSourceLabel, YOUTUBE_CDN_URLS,
} from '../src/lib/youtubeSpeed.ts';
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
  const transport = fakeTransport({ failFirst: true });
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
  const transport = fakeTransport({});
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
