import type { ScanSiteResult, Site } from '../types';
import { isNativeApp, mapLimit } from './nativeBridge';
import { probeControl, probeSiteResilient, type ProbeOptions } from './siteProbe';
import { siteResultFromProbe } from './siteMeasurement';
import { applyServiceAccessPolicy, type ServiceAccessContext } from './serviceAccess';
import { orderSitesForScan } from './scanScheduler';
import { remainingMs, SCAN_BUDGETS, type ScanBudget } from './scanBudget';

/**
 * Настоящий замер сайтов с телефона.
 *
 * Два правила, которые отличают его от прежней версии:
 * 1. Никаких «хоть какой-то ответ = успех»: заглушка провайдера и подмена TLS
 *    помечаются как перехват, а не как доступный сайт.
 * 2. Никаких пятиминутных ожиданий: все сайты уходят одним залпом, время
 *    ограничено и на сайт, и на всю проверку. Не успевшие сайты остаются
 *    непроверенными — выдуманный вердикт хуже отсутствия вердикта.
 */

export type RealScanOutcome = {
  results: ScanSiteResult[];
  /** Контрольная проба или сами сайты доказали, что выход в интернет есть. */
  controlOk: boolean;
  /** Данные грубые (браузер без доступа к содержимому). */
  approximate: boolean;
  /** Сколько сайтов не успели проверить. */
  incomplete: number;
  /** Проверка упёрлась в общий предел времени. */
  timedOut: boolean;
  elapsedMs: number;
};

export async function runRealSiteScan(
  sites: Site[],
  onProgress: (
    done: number,
    total: number,
    latest: ScanSiteResult,
    partial: ScanSiteResult[]
  ) => void,
  abortSignal?: AbortSignal,
  timeoutMs = 8000,
  serviceContext: ServiceAccessContext = { withVpn: false },
  nativeHttp?: ProbeOptions['nativeHttp'],
  budget: ScanBudget = SCAN_BUDGETS.fast
): Promise<RealScanOutcome> {
  const enabled = sites.filter((s) => Boolean(s.enabled));
  const total = enabled.length;
  const acc: ScanSiteResult[] = [];
  const startedAt = performance.now();
  const scanDeadline = startedAt + budget.totalMs;
  const perSiteTimeout = Math.min(timeoutMs, budget.perSiteMs);

  // Общий предел: что бы ни случилось, проверка закончится вовремя.
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), budget.totalMs);
  const onOuterAbort = () => deadlineController.abort();
  abortSignal?.addEventListener('abort', onOuterAbort);
  const signal = deadlineController.signal;

  // Контрольная проба идёт параллельно с сайтами и ничего не задерживает.
  const controlPromise = probeControl(Math.min(perSiteTimeout, budget.controlMs), nativeHttp).catch(() => false);

  const scheduled = orderSitesForScan(enabled);
  const bySite = new Map<number, ScanSiteResult>();
  /** Сайты, промолчавшие на быстром проходе: их переспросим, если есть время. */
  const silent: Site[] = [];
  let done = 0;

  const record = (site: Site, probe: Awaited<ReturnType<typeof probeSiteResilient>>, note?: string) => {
    let result = siteResultFromProbe(site, probe);
    const attempts = probe.attempts || 1;
    const marks = [attempts > 1 ? `попыток: ${attempts}` : '', note || ''].filter(Boolean).join(' · ');
    if (marks) result.note = `${result.note || ''} · ${marks}`.trim();
    result = applyServiceAccessPolicy(site, result, serviceContext);
    const previous = bySite.get(site.id);
    if (previous) acc[acc.indexOf(previous)] = result; else acc.push(result);
    bySite.set(site.id, result);
    // Прогресс не должен «отматываться» назад на втором проходе.
    if (!previous) done += 1;
    onProgress(done, total, result, [...acc]);
  };

  const pass = async (targets: Site[], perSiteMs: number, retry: boolean, tcpFallback: boolean, recheck: boolean) => {
    await mapLimit(targets, Math.max(1, Math.min(budget.concurrency, targets.length)), async (site) => {
      if (signal.aborted) return;
      const left = remainingMs(scanDeadline, performance.now());
      if (left == null) return;
      const probeUrl = site.probe_url || `https://${site.domain}/`;
      const probe = await probeSiteResilient(probeUrl, {
        // Потолок своего прохода, а не первого: иначе второй проход получил бы
        // тот же короткий таймаут и снова потерял медленный живой сайт.
        timeoutMs: Math.min(timeoutMs, perSiteMs, left),
        nativeHttp,
        retry,
        tcpFallback,
        deadlineAt: Math.min(scanDeadline, performance.now() + perSiteMs),
      }, signal);
      // Сайт, до которого не дошёл бюджет, не получает вердикт: ни «работает»,
      // ни «заблокирован». Он попадёт в счётчик непроверенных.
      if (probe.attempts === 0) return;
      const answered = probe.verdict === 'ok' || probe.verdict === 'slow';
      if (recheck) {
        // Молчание на коротком таймауте — ещё не приговор: сайт идёт во второй
        // проход, но пользователю уже показан факт первого замера. Отказ моста
        // или запрет системы переспрашивать бессмысленно — это не про сайт.
        if (!answered && probe.httpStatus == null && probe.verdict !== 'offline') silent.push(site);
        record(site, probe);
        return;
      }
      // Второй проход перезаписывает результат только когда услышал сайт:
      // ответ, капча или HTTP-код — новые факты. Повторное молчание оставляет
      // первый замер как есть.
      if (!answered && probe.httpStatus == null) return;
      record(site, probe, 'перепроверен с большим таймаутом');
    }, signal);
  };

  try {
    await pass(scheduled, budget.perSiteMs, budget.retry, budget.tcpFallback, budget.secondPass);
    // Короткий таймаут не должен превращать медленный сайт в заблокированный:
    // промолчавшие переспрашиваются в остатке того же общего бюджета.
    if (budget.secondPass && silent.length && !signal.aborted && remainingMs(scanDeadline, performance.now()) != null) {
      await pass(orderSitesForScan(silent), budget.secondPassPerSiteMs, true, budget.tcpFallback, false);
    }
  } catch (error) {
    // Отмена и выход времени — не ошибка: возвращаем то, что успели измерить.
    if ((error as Error)?.name !== 'AbortError') {
      clearTimeout(deadlineTimer);
      abortSignal?.removeEventListener('abort', onOuterAbort);
      throw error;
    }
  }

  clearTimeout(deadlineTimer);
  abortSignal?.removeEventListener('abort', onOuterAbort);
  const controlAnswered = await controlPromise;
  const timedOut = signal.aborted && !abortSignal?.aborted;
  const elapsedMs = Math.round(performance.now() - startedAt);

  // Приоритет влияет только на расписание запросов, а не на порядок отчёта.
  const originalOrder = new Map(enabled.map((site, index) => [site.id, index]));
  acc.sort((a, b) => (originalOrder.get(a.site_id || -1) ?? 0) - (originalOrder.get(b.site_id || -1) ?? 0));

  // Если хоть один сайт ответил — сеть жива, даже когда контрольные адреса
  // заблокированы (так бывает при белых списках).
  const anyAnswered = acc.some((r) => r.network_status === 'ok' || r.network_status === 'slow');
  const networkAlive = controlAnswered || anyAnswered;

  return {
    // Сеть мертва целиком — не обвиняем сайты и не сохраняем заглушки.
    results: networkAlive ? acc : [],
    controlOk: networkAlive,
    approximate: !isNativeApp(),
    incomplete: Math.max(0, total - acc.length),
    timedOut,
    elapsedMs,
  };
}
