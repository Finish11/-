import test from 'node:test';
import assert from 'node:assert/strict';
import { SCAN_BUDGETS, remainingMs, scanBudgetFor, worstCaseSeconds } from '../src/lib/scanBudget.ts';
import { probeSiteResilient } from '../src/lib/siteProbe.ts';
import { runRealSiteScan } from '../src/lib/realScan.ts';
import type { Site } from '../src/types.ts';

const site = (id: number): Site => ({
  id, user_id: 1, name: `Сайт ${id}`, domain: `s${id}.example.com`, probe_url: `https://s${id}.example.com/`,
  category: 'other', marker_role: 'global_neutral', description: '', enabled: true,
  accessibility: 'ok', last_status: null, last_latency_ms: null, last_checked_at: null,
} as unknown as Site);

test('быстрый режим укладывается в секунды, а не в минуты', () => {
  const fast = SCAN_BUDGETS.fast;
  assert.ok(fast.concurrency >= 48, 'сайты должны уходить одним залпом');
  assert.equal(fast.retry, false, 'повторы — главная причина пятиминутного ожидания');
  assert.ok(worstCaseSeconds(fast, 75) <= 20, `оценка ${worstCaseSeconds(fast, 75)} с`);
  // Прежде худший путь был 28 с на сайт при 8 параллельных — почти пять минут.
  const oldWorst = Math.ceil(75 / 8) * 28;
  assert.ok(oldWorst > 250 && worstCaseSeconds(fast, 75) * 10 < oldWorst);
  assert.ok(worstCaseSeconds(SCAN_BUDGETS.thorough, 75) <= 90);
  assert.equal(scanBudgetFor('мусор').perSiteMs, fast.perSiteMs);
  assert.equal(scanBudgetFor(undefined), fast);
});

test('остаток бюджета считается честно и не даёт стартовать без времени', () => {
  assert.equal(remainingMs(10_000, 9_000), 1000);
  assert.equal(remainingMs(10_000, 9_900), null, 'меньше 250 мс — новый запрос не начинаем');
  assert.equal(remainingMs(10_000, 12_000), null);
});

test('без повторов сайт получает ровно один запрос', async () => {
  let calls = 0;
  const result = await probeSiteResilient('https://example.com/probe', {
    retry: false, timeoutMs: 300,
    nativeHttp: async () => { calls += 1; return { ok: false, status: null, error: 'timeout' } as never; },
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
});

test('повторы съедают остаток бюджета, а не начинают новый круг', async () => {
  const timeouts: number[] = [];
  await probeSiteResilient('https://example.com/probe', {
    retry: true, tcpFallback: false, timeoutMs: 5000, deadlineAt: performance.now() + 900,
    nativeHttp: async (_url, timeoutMs) => {
      timeouts.push(timeoutMs || 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { ok: false, status: null, error: 'timeout' } as never;
    },
  });
  assert.ok(timeouts.length >= 2, 'повтор был');
  assert.ok(timeouts.every((value) => value <= 900), `таймауты не должны превышать бюджет: ${timeouts.join(',')}`);
  assert.ok(timeouts[timeouts.length - 1] < timeouts[0], 'каждый следующий шаг получает меньше времени');
});

test('просроченный сайт не проверяется вовсе и не получает выдуманный вердикт', async () => {
  let calls = 0;
  const result = await probeSiteResilient('https://example.com/', {
    deadlineAt: performance.now() - 1000,
    nativeHttp: async () => { calls += 1; return { ok: true, status: 200 } as never; },
  });
  assert.equal(calls, 0);
  assert.equal(result.attempts, 0);
  assert.match(result.reason || '', /вышло время/);
});

test('вся проверка ограничена общим пределом и возвращает успевшее', async () => {
  const sites = Array.from({ length: 12 }, (_, index) => site(index + 1));
  let answered = 0;
  const outcome = await runRealSiteScan(sites, () => undefined, undefined, 8000, { withVpn: false },
    async (url) => {
      // Контрольные адреса молчат, сайты отвечают не все.
      if (/gstatic|cloudflare|ya\.ru|rbc\.ru/.test(url)) return { ok: false, status: null, error: 'timeout' } as never;
      answered += 1;
      if (answered > 4) { await new Promise((resolve) => setTimeout(resolve, 3000)); }
      return { ok: true, status: 204, latency_ms: 12, url, data_base64: '', content_type: 'text/plain' } as never;
    },
    { ...SCAN_BUDGETS.fast, concurrency: 2, totalMs: 700, perSiteMs: 500, controlMs: 200 });
  assert.ok(outcome.elapsedMs < 2500, `проверка тянулась ${outcome.elapsedMs} мс`);
  assert.ok(outcome.results.length > 0, 'успевшие сайты сохранены');
  assert.ok(outcome.incomplete > 0, 'сайты, до которых не дошла очередь, честно посчитаны непроверенными');
  assert.equal(outcome.incomplete + outcome.results.length, sites.length);
  assert.equal(outcome.controlOk, true, 'ответившие сайты доказывают, что сеть жива');
});

test('75 сайтов одним залпом: время задаёт общий предел, а не сумма ожиданий', async () => {
  const sites = Array.from({ length: 75 }, (_, index) => site(index + 1));
  let started = 0;
  const outcome = await runRealSiteScan(sites, () => undefined, undefined, 8000, { withVpn: false },
    async (url) => {
      if (/gstatic|cloudflare|ya\.ru|rbc\.ru/.test(url)) return { ok: false, status: null, error: 'timeout' } as never;
      started += 1;
      // Три сайта отвечают сразу, остальные «висят» как Netflix у пользователя.
      if (started > 3) { await new Promise((resolve) => setTimeout(resolve, 5000)); }
      return { ok: true, status: 204, latency_ms: 15, url, data_base64: '', content_type: 'text/plain' } as never;
    },
    { ...SCAN_BUDGETS.fast, totalMs: 1200, perSiteMs: 600, controlMs: 200 });
  // Раньше ожидание складывалось: волны × таймауты. Теперь — общий предел.
  assert.ok(outcome.elapsedMs < 2200, `проверка тянулась ${outcome.elapsedMs} мс`);
  assert.ok(started >= 48, `залп должен уйти сразу, ушло ${started}`);
  assert.equal(outcome.results.length + outcome.incomplete, sites.length);
  assert.ok(outcome.incomplete > 0, 'зависшие сайты честно остались непроверенными');
  // Молчание — это измеренный таймаут с пустой задержкой, а не выдуманная причина.
  for (const result of outcome.results) {
    if (result.status === 'blocked') {
      assert.equal(result.latency_ms, null);
      assert.match(result.network_note || '', /таймаут/);
    } else assert.notEqual(result.latency_ms, null);
  }
  assert.ok(outcome.results.some((r) => r.status === 'ok'), 'ответившие сайты отмечены работающими');
});

test('медленный, но живой сайт не получает «не отвечает» из-за короткого таймаута', async () => {
  const sites = [site(1), site(2)];
  const calls = new Map<string, number>();
  const outcome = await runRealSiteScan(sites, () => undefined, undefined, 8000, { withVpn: false },
    async (url, timeoutMs) => {
      if (/gstatic|cloudflare|ya\.ru|rbc\.ru/.test(url)) return { ok: true, status: 204 } as never;
      const attempt = (calls.get(url) || 0) + 1;
      calls.set(url, attempt);
      // Сайт отвечает за 700 мс: быстрый проход с таймаутом 300 мс его теряет.
      if ((timeoutMs || 0) < 700) return { ok: false, status: null, error: 'timeout' } as never;
      await new Promise((resolve) => setTimeout(resolve, 700));
      return { ok: true, status: 204, latency_ms: 700, url, data_base64: '', content_type: 'text/plain' } as never;
    },
    { ...SCAN_BUDGETS.fast, perSiteMs: 300, secondPassPerSiteMs: 2000, totalMs: 6000, controlMs: 300 });
  const slow = outcome.results.find((r) => r.domain === 's2.example.com') || outcome.results[0];
  assert.equal(outcome.results.length, 2, 'оба сайта в отчёте');
  assert.ok(outcome.results.every((r) => r.status !== 'blocked'),
    `живые сайты не должны остаться заблокированными: ${JSON.stringify(outcome.results.map((r) => [r.domain, r.status]))}`);
  assert.ok((calls.get('https://s1.example.com/') || 0) >= 2, 'промолчавший сайт переспрошен');
  assert.match(slow.note || '', /перепроверен/);
  assert.ok(outcome.elapsedMs < 5000, `проверка тянулась ${outcome.elapsedMs} мс`);
});

test('второй проход не выходит за общий предел и не размножает результаты', async () => {
  const sites = Array.from({ length: 30 }, (_, index) => site(index + 1));
  const outcome = await runRealSiteScan(sites, () => undefined, undefined, 8000, { withVpn: false },
    async (url) => {
      if (/gstatic|cloudflare|ya\.ru|rbc\.ru/.test(url)) return { ok: true, status: 204 } as never;
      // Все сайты молчат всегда: второй проход упирается в общий предел.
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return { ok: false, status: null, error: 'timeout' } as never;
    },
    { ...SCAN_BUDGETS.fast, perSiteMs: 400, secondPassPerSiteMs: 3000, totalMs: 1500, controlMs: 200 });
  assert.ok(outcome.elapsedMs < 2600, `проверка тянулась ${outcome.elapsedMs} мс`);
  assert.equal(new Set(outcome.results.map((r) => r.site_id)).size, outcome.results.length, 'без дублей');
  assert.equal(outcome.results.length + outcome.incomplete, sites.length);
});
