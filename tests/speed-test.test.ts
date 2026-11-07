import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateSpeed, bytesToMbps, compareConfigs, formatBytes, formatSpeed, guessSpeedCap, jitterMs,
  latencyStats, planChunkBytes, planConnections, sliceRates, speedGaugeFraction, speedUsageVerdict,
  summarizeByConfig, type SpeedRun, type SpeedSlice, speedTraceGeometry, configLabel, networkKindLabel, bufferbloatVerdict,
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

test('экономный режим тратит заметно меньше трафика и времени', async () => {
  const { SPEED_TRAFFIC } = await import('../src/lib/speedRunner.ts');
  assert.ok(SPEED_TRAFFIC.lite.download < SPEED_TRAFFIC.full.download / 3);
  assert.ok(SPEED_TRAFFIC.lite.upload < SPEED_TRAFFIC.full.upload / 3);
  assert.ok(SPEED_TRAFFIC.lite.downloadMs < SPEED_TRAFFIC.full.downloadMs);
  assert.ok(SPEED_TRAFFIC.lite.download >= 20 * 1024 * 1024, 'слишком маленький объём даст ненадёжный результат');
});

test('отдача считается по записанным байтам: крупные куски не обнуляют результат', async () => {
  // Медленный канал 5 Мбит/с и крупный кусок 2 МБ: сервер подтверждает раз в
  // 3.3 секунды, за фазу успевают пройти всего два подтверждения.
  const slices: SpeedSlice[] = [{ t: 0, bytes: 0, confirmed: 0 }];
  for (let t = 100; t <= 8000; t += 100) {
    const written = Math.round((5 * 1_000_000 / 8) * (t / 1000));
    slices.push({ t, bytes: written, confirmed: Math.floor(t / 3300) * 2_097_152 });
  }
  const byConfirmed = aggregateSpeed(slices);
  const byWritten = aggregateSpeed(slices, { field: 'bytes' });
  assert.ok(byWritten.mbps > 4.5 && byWritten.mbps < 5.5, `ожидалось ~5 Мбит/с, получено ${byWritten.mbps}`);
  // Крупные редкие подтверждения отбрасываются как «быстрые срезы», и скорость
  // превращается в ноль. Поэтому отдача считается по записанным байтам.
  assert.ok(byConfirmed.mbps < 1, `ожидался провал методики на подтверждениях, получено ${byConfirmed.mbps}`);
});

test('живой график: шкала по максимуму, фазы отдельными путями', () => {
  const empty = speedTraceGeometry([], 260, 44);
  assert.equal(empty.download, '');
  assert.equal(empty.upload, '');

  const geometry = speedTraceGeometry([
    { mbps: 0, phase: 'download' },
    { mbps: 50, phase: 'download' },
    { mbps: 100, phase: 'download' },
    { mbps: 25, phase: 'upload' },
  ], 300, 44);
  assert.equal(geometry.max, 100);
  assert.ok(geometry.download.startsWith('M 0.0 42.0'), geometry.download);
  assert.ok(geometry.download.endsWith('L 200.0 2.0'), geometry.download);
  assert.ok(geometry.upload.startsWith('M 300.0 '), geometry.upload);
  assert.ok(!geometry.upload.includes('L 0.0'), 'отдача не рисуется в начале оси времени');
});

test('живой график переживает нули, отрицательные и мусорные значения', () => {
  const geometry = speedTraceGeometry([
    { mbps: 0, phase: 'download' },
    { mbps: -5, phase: 'download' },
    { mbps: Number.NaN, phase: 'download' },
    { mbps: 0, phase: 'upload' },
  ], 100, 20);
  assert.equal(geometry.max, 1, 'нулевой канал не делит на ноль');
  assert.ok(geometry.download.includes('18.0'), geometry.download);
  const single = speedTraceGeometry([{ mbps: 10, phase: 'upload' }, { mbps: Number.NaN, phase: 'upload' }], 100, 20);
  assert.equal(single.upload, '', 'одной валидной точки мало для линии');
});

test('имя группы замера не выдумывает выход без данных', () => {
  const base = { profile_name: '', exit_ip: '', vpn_app_name: '', route: 'unknown' } as SpeedRun;
  assert.equal(configLabel(base), 'Маршрут неизвестен');
  assert.equal(configLabel({ ...base, route: 'direct' }), 'Без VPN (прямой)');
  assert.equal(configLabel({ ...base, exit_ip: '203.0.113.7' }), 'Выход 203.0.113.7');
  assert.equal(configLabel({ ...base, exit_ip: '203.0.113.7', vpn_app_name: 'v2rayNG' }), 'v2rayNG · 203.0.113.7');
  assert.equal(configLabel({ ...base, profile_name: 'NL-AMS' }), 'NL-AMS');
  assert.equal(networkKindLabel('cellular'), 'мобильная сеть');
  assert.equal(networkKindLabel(undefined), 'неизвестная сеть');
});

test('прямой замер на другой сети не выдаётся за точку отсчёта', () => {
  const directWifi = { id: 1, profile_id: null, route: 'direct', network_kind: 'wifi',
    download_mbps: 200, upload_mbps: 100, ping_ms: 10, created_at: '2026-11-08T10:00:00.000Z' } as SpeedRun;
  const vpnCell = { id: 2, profile_id: 5, profile_name: 'NL-AMS', route: 'vpn', network_kind: 'cellular',
    download_mbps: 40, upload_mbps: 20, ping_ms: 40, created_at: '2026-11-08T11:00:00.000Z' } as SpeedRun;
  const comparison = compareConfigs([directWifi, vpnCell], 'cellular');
  assert.equal(comparison.baseline, null, 'Wi-Fi нельзя брать за базу для мобильной сети');
  assert.equal(comparison.baselineOtherNetwork?.networkKind, 'wifi');
  assert.ok(!comparison.verdicts.some((entry) => /% от прямого/.test(entry.text)), 'потери не выдумываются');
  // На той же сети база появляется, и вывод о потерях становится законным.
  const same = compareConfigs([{ ...directWifi, network_kind: 'cellular' }, vpnCell], 'cellular');
  assert.ok(same.baseline);
  assert.equal(same.baselineOtherNetwork, null);
  assert.match(same.verdicts.find((entry) => entry.key === 'profile:5')?.text || '', /Сильно ограничивает: 20%/);
});

test('отзывчивость под нагрузкой считается по росту задержки, а не по абсолюту', () => {
  assert.equal(bufferbloatVerdict(20, 25).grade, 'ok');
  assert.equal(bufferbloatVerdict(20, 25).deltaMs, 5);
  assert.equal(bufferbloatVerdict(120, 150).grade, 'ok', 'высокий базовый ping сам по себе не bufferbloat');
  assert.equal(bufferbloatVerdict(20, 80).grade, 'warn');
  assert.equal(bufferbloatVerdict(20, 400).grade, 'bad');
  assert.match(bufferbloatVerdict(20, 400).text, /380 мс/);
  assert.equal(bufferbloatVerdict(20, null).grade, 'unknown');
  assert.equal(bufferbloatVerdict(null, 100).grade, 'unknown');
  assert.equal(bufferbloatVerdict(20, 10).deltaMs, 0, 'отрицательная разница не показывается как рост');
});

test('сравнение конфигов показывает задержку под нагрузкой', () => {
  const runs = [
    { id: 1, profile_id: 3, profile_name: 'Быстрый, но лагает', route: 'vpn', network_kind: 'wifi', download_mbps: 90,
      upload_mbps: 30, ping_ms: 20, loaded_ping_ms: 320, created_at: '2026-11-08T10:00:00.000Z' },
    { id: 2, profile_id: 3, profile_name: 'Быстрый, но лагает', route: 'vpn', network_kind: 'wifi', download_mbps: 110,
      upload_mbps: 30, ping_ms: 24, loaded_ping_ms: 280, created_at: '2026-11-08T11:00:00.000Z' },
    { id: 3, profile_id: 4, profile_name: 'Старый замер', route: 'vpn', network_kind: 'wifi', download_mbps: 50,
      upload_mbps: 10, ping_ms: 30, created_at: '2026-11-08T09:00:00.000Z' },
  ] as SpeedRun[];
  const summaries = summarizeByConfig(runs);
  assert.equal(summaries.find((item) => item.key === 'profile:3')?.medianLoadedPing, 300);
  assert.equal(summaries.find((item) => item.key === 'profile:4')?.medianLoadedPing, null, 'нет данных — нет выдумки');
});
