import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateSpeed, bytesToMbps, compareConfigs, formatBytes, formatSpeed, guessSpeedCap, jitterMs,
  latencyStats, planChunkBytes, planConnections, sliceRates, speedGaugeFraction, speedUsageVerdict,
  summarizeByConfig, type SpeedRun, type SpeedSlice,
} from '../src/lib/speedTest.ts';
import { availableSpeedServers, CLOUDFLARE_SPEED, speedEndpointError } from '../src/lib/speedEndpoints.ts';

/** Ровный канал 100 Мбит/с: 100 мс шаг, 1.25 МБ за шаг. */
function steady(mbps: number, ms: number, step = 100): SpeedSlice[] {
  const slices: SpeedSlice[] = [{ t: 0, bytes: 0, confirmed: 0 }];
  const perStep = (mbps * 1_000_000 / 8) * (step / 1000);
  for (let t = step; t <= ms; t += step) {
    const bytes = Math.round(perStep * (t / step));
    slices.push({ t, bytes, confirmed: bytes });
  }
  return slices;
}

test('байты и время переводятся в Мбит/с, а не в мегабайты', () => {
  assert.equal(bytesToMbps(12_500_000, 1000), 100);
  assert.equal(bytesToMbps(0, 1000), 0);
  assert.equal(bytesToMbps(1000, 0), 0);
});

test('мгновенные скорости считаются по приросту счётчика и игнорируют сброс', () => {
  const rates = sliceRates([
    { t: 0, bytes: 0, confirmed: 0 }, { t: 100, bytes: 1_250_000, confirmed: 1_250_000 },
    { t: 200, bytes: 2_500_000, confirmed: 2_500_000 }, { t: 300, bytes: 0, confirmed: 0 },
    { t: 400, bytes: 1_250_000, confirmed: 1_250_000 },
  ]);
  assert.equal(rates.length, 3);
  assert.ok(rates.every((rate) => Math.abs(rate.mbps - 100) < 0.001));
});

test('разгон TCP не занижает результат: медленные первые срезы отбрасываются', () => {
  // Первые 1.5 секунды канал разгоняется и даёт лишь 10 Мбит/с, дальше 100.
  const withRamp: SpeedSlice[] = [{ t: 0, bytes: 0, confirmed: 0 }];
  let total = 0;
  for (let t = 100; t <= 10000; t += 100) {
    total += ((t <= 1500 ? 10 : 100) * 1_000_000 / 8) * 0.1;
    withRamp.push({ t, bytes: Math.round(total), confirmed: Math.round(total) });
  }
  const result = aggregateSpeed(withRamp);
  assert.equal(result.reliable, true);
  assert.ok(result.mbps > 80, `ожидалась скорость около 100, получено ${result.mbps}`);
  assert.ok(result.averageMbps < result.mbps, 'среднее за всю фазу ниже итога — разгон исключён');
});

test('методика Ookla: 20 срезов, минус 10% быстрых и 30% медленных', () => {
  const slices = steady(100, 10000);
  const result = aggregateSpeed(slices);
  assert.match(result.reason, /20 срезов/);
  assert.match(result.reason, /6 медленных и 2 быстрых/);
  assert.ok(Math.abs(result.mbps - 100) < 1);
});

test('слишком короткий или пустой замер помечается ненадёжным, а не красивым числом', () => {
  assert.equal(aggregateSpeed([]).reliable, false);
  const tiny = aggregateSpeed([{ t: 0, bytes: 0, confirmed: 0 }, { t: 300, bytes: 1000, confirmed: 1000 }]);
  assert.equal(tiny.reliable, false);
  assert.match(tiny.reason, /мало данных|слишком короткий|Мало интервалов/);
});

test('джиттер и задержка считаются по соседним замерам', () => {
  assert.equal(jitterMs([10, 20, 30]), 10);
  assert.equal(jitterMs([10]), null);
  const stats = latencyStats([40, 20, 100, 30]);
  assert.equal(stats.pingMs, 35);
  assert.equal(stats.minMs, 20);
  assert.ok(stats.jitterMs! > 0);
});

test('число соединений и размер куска растут с оценкой канала', () => {
  assert.equal(planConnections(5), 2);
  assert.equal(planConnections(50), 4);
  assert.equal(planConnections(500), 8);
  assert.ok(planChunkBytes(500) > planChunkBytes(5));
  assert.ok(planChunkBytes(5) >= 1024 * 1024);
});

test('ограничение канала видно по плато у круглого значения', () => {
  const flat = aggregateSpeed(steady(100, 10000));
  const guess = guessSpeedCap(flat);
  assert.equal(guess.capped, true);
  assert.equal(guess.nearMbps, 100);
  const noisy = aggregateSpeed(steady(97, 10000).map((slice, index) => ({
    ...slice, confirmed: Math.round(slice.confirmed * (index % 2 ? 1.6 : 0.5)), bytes: Math.round(slice.bytes * (index % 2 ? 1.6 : 0.5)),
  })));
  assert.equal(guessSpeedCap(noisy).capped, false);
  assert.equal(guessSpeedCap(aggregateSpeed([])).capped, false);
});

const run = (patch: Partial<SpeedRun>): SpeedRun => ({
  id: 1, created_at: '2026-11-07T10:00:00.000Z', download_mbps: 100, upload_mbps: 50, ping_ms: 20, jitter_ms: 3,
  download_bytes: 1_000_000, upload_bytes: 500_000, server: 'test', network_kind: 'wifi', route: 'vpn', ...patch,
});

test('сравнение конфигов показывает, какой конфиг режет скорость', () => {
  const runs = [
    run({ id: 1, route: 'direct', profile_id: null, download_mbps: 100, upload_mbps: 50 }),
    run({ id: 2, profile_id: 7, profile_name: 'Быстрый NL', download_mbps: 95, created_at: '2026-11-07T11:00:00.000Z' }),
    run({ id: 3, profile_id: 8, profile_name: 'Медленный DE', download_mbps: 20, created_at: '2026-11-07T12:00:00.000Z' }),
    run({ id: 4, profile_id: 8, profile_name: 'Медленный DE', download_mbps: 30, created_at: '2026-11-07T12:30:00.000Z' }),
  ];
  const summaries = summarizeByConfig(runs);
  assert.equal(summaries[0].label, 'Без VPN (прямой)');
  const slow = summaries.find((item) => item.profileId === 8)!;
  assert.equal(slow.medianDownload, 25);
  assert.equal(slow.bestDownload, 30);
  assert.equal(slow.runs, 2);
  const comparison = compareConfigs(runs, 'wifi');
  assert.equal(comparison.baseline?.key, 'direct');
  assert.match(comparison.verdicts.find((item) => item.key === 'profile:7')!.text, /Почти без потерь/);
  const slowVerdict = comparison.verdicts.find((item) => item.key === 'profile:8')!;
  assert.equal(slowVerdict.tone, 'bad');
  assert.match(slowVerdict.text, /Сильно ограничивает/);
});

test('без прямого замера вывод о потере скорости не делается', () => {
  const comparison = compareConfigs([run({ id: 1, profile_id: 3, profile_name: 'NL' })], 'wifi');
  assert.equal(comparison.baseline, null);
  assert.match(comparison.verdicts[0].text, /сравнить потери нельзя/);
});

test('сравнение не смешивает Wi-Fi и мобильную сеть', () => {
  const runs = [
    run({ id: 1, route: 'direct', profile_id: null, download_mbps: 200, network_kind: 'wifi' }),
    run({ id: 2, profile_id: 5, download_mbps: 30, network_kind: 'cellular' }),
  ];
  const comparison = compareConfigs(runs, 'cellular');
  assert.equal(comparison.ranked.length, 1);
  assert.equal(comparison.baseline, null);
});

test('шкала стрелки логарифмическая и монотонная', () => {
  assert.equal(speedGaugeFraction(0), 0);
  assert.equal(speedGaugeFraction(null), 0);
  assert.equal(speedGaugeFraction(1000), 1);
  assert.equal(speedGaugeFraction(5000), 1);
  const values = [1, 5, 10, 50, 100, 500].map(speedGaugeFraction);
  assert.deepEqual([...values].sort((a, b) => a - b), values);
  assert.ok(speedGaugeFraction(10) > 0.3 && speedGaugeFraction(10) < 0.4);
});

test('форматирование и вывод о применимости скорости', () => {
  assert.equal(formatSpeed(94.34), '94,3');
  assert.equal(formatSpeed(237.6), '238');
  assert.equal(formatSpeed(0.512), '0,51');
  assert.equal(formatSpeed(null), '—');
  assert.equal(formatBytes(1024 * 1024), '1,0 МБ');
  assert.match(speedUsageVerdict(120, 40, 20), /4K/);
  assert.match(speedUsageVerdict(1, 0.2, 300), /Скорости мало/);
});

test('выбор сервера: свой раньше публичного, ошибки объясняются', () => {
  const servers = availableSpeedServers({ communityEndpoint: 'https://api.example', webOrigin: 'https://app.example' });
  assert.ok(servers.length >= 2);
  assert.equal(servers[servers.length - 1].id, CLOUDFLARE_SPEED.id);
  const community = servers.find((server) => server.source === 'community')!;
  assert.equal(community.ping, 'https://api.example/api/speed/ping');
  assert.equal(community.download(1000), 'https://api.example/api/speed/down?bytes=1000');
  assert.match(speedEndpointError(['HTTP 429 Retry-After 3566'], CLOUDFLARE_SPEED), /ограничил частоту/);
  assert.match(speedEndpointError(['HTTP 404'], community), /нет точек замера/);
});
