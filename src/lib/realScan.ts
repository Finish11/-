import type { ScanSiteResult, Site } from '../types';
import { isNativeApp, mapLimit } from './nativeBridge';
import { probeControl, probeSiteResilient, type ProbeOptions } from './siteProbe';
import { siteResultFromProbe } from './siteMeasurement';
import { applyServiceAccessPolicy, type ServiceAccessContext } from './serviceAccess';
import { orderSitesForScan } from './scanScheduler';

/**
 * Настоящий замер сайтов с телефона.
 *
 * Ключевое отличие от прежней версии: мы больше не считаем успехом «хоть
 * какой-то ответ». У заблокированного сайта провайдер часто отвечает сам
 * (заглушка, подмена TLS, сброс) — такой результат помечается как
 * «перехвачено», а не «доступен».
 *
 * Перед замером выполняется контрольная проба нейтрального хоста: если сеть
 * мертва целиком, все сайты получают «сеть недоступна» и вердикт не врёт.
 */

export type RealScanOutcome = {
  results: ScanSiteResult[];
  /** Контрольная проба: есть ли вообще выход в интернет */
  controlOk: boolean;
  /** Данные грубые (браузер без доступа к содержимому) */
  approximate: boolean;
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
  nativeHttp?: ProbeOptions['nativeHttp']
): Promise<RealScanOutcome> {
  const enabled = sites.filter((s) => Boolean(s.enabled));
  const total = enabled.length;
  let done = 0;
  const acc: ScanSiteResult[] = [];

  // Контрольная проба: без неё «всё недоступно» может означать просто «нет сети».
  // Контрольные адреса проверяются параллельно, а не по 5 секунд каждый.
  let controlOk = await probeControl(Math.min(timeoutMs, 5000), nativeHttp);
  const recoveredProbes = new Map<number, Awaited<ReturnType<typeof probeSiteResilient>>>();

  if (!controlOk && !abortSignal?.aborted && enabled.length > 0) {
    // Четыре контрольных адреса тоже могут быть заблокированы, хотя остальная
    // сеть работает. Прежде чем объявить интернет мёртвым, проверяем по два
    // представителя каждой группы. Успешные пробы попадут в общий результат.
    const representatives = [
      'ru_whitelist',
      'global_neutral',
      'dpi_target',
    ].flatMap((role) => enabled.filter((site) => site.marker_role === role).slice(0, 2));
    const fallbackSites = representatives.length > 0 ? representatives : enabled.slice(0, 6);
    const recovery = await mapLimit(fallbackSites, 6, async (site) => ({
      site,
      probe: await probeSiteResilient(site.probe_url || `https://${site.domain}/`, { timeoutMs, nativeHttp }, abortSignal),
    }));
    for (const { site, probe } of recovery) {
      if (probe.networkStatus === 'ok' || probe.networkStatus === 'slow') {
        controlOk = true;
        recoveredProbes.set(site.id, probe);
      }
    }
  }

  // 32 запроса одновременно: на 75 сайтах не остаётся длинного «хвоста»
  // после первых быстрых ответов, но мобильная сеть не забивается 75 сокетами.
  const scheduled = orderSitesForScan(enabled);
  const results = await mapLimit(scheduled, Math.min(8, enabled.length), async (site) => {
    if (abortSignal?.aborted) {
      const aborted: ScanSiteResult = {
        site_id: site.id,
        name: site.name,
        domain: site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: 'blocked',
        latency_ms: null,
      };
      return aborted;
    }

    let result: ScanSiteResult;

    if (!controlOk) {
      // Сети нет вообще — не обвиняем сайты и не выдумываем причины.
      result = {
        site_id: site.id,
        name: site.name,
        domain: site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: 'blocked',
        latency_ms: null,
        block_reason: 'network',
      };
    } else {
      const probeUrl = site.probe_url || `https://${site.domain}/`;
      const probe = recoveredProbes.get(site.id) || await probeSiteResilient(probeUrl, { timeoutMs, nativeHttp }, abortSignal);
      result = siteResultFromProbe(site, probe);
      if ((probe.attempts || 1) > 1) result.note = `${result.note || ''} · попыток: ${probe.attempts}`.trim();
      if (abortSignal?.aborted) return result;
    }

    if (controlOk) result = applyServiceAccessPolicy(site, result, serviceContext);
    acc.push(result);
    done += 1;
    onProgress(done, total, result, [...acc]);
    return result;
  });

  // Отмена/общий сбой сети — не замеры сайтов: не сохраняем blocked-заглушки.
  const measuredResults = abortSignal?.aborted || !controlOk ? [] : results;
  // Приоритет влияет только на расписание запросов, а не на порядок отчёта.
  const originalOrder = new Map(enabled.map((site, index) => [site.id, index]));
  measuredResults.sort(
    (a, b) => (originalOrder.get(a.site_id || -1) ?? 0) - (originalOrder.get(b.site_id || -1) ?? 0)
  );

  // Если хоть один сайт ответил — сеть точно жива, даже когда контрольные
  // адреса заблокированы (так бывает при белых списках).
  const anyAnswered = results.some((r) => r.network_status === 'ok' || r.network_status === 'slow');
  const networkAlive = controlOk || anyAnswered;

  // В браузере мы видим только сам факт ответа (CORS не даёт прочитать страницу),
  // поэтому результат честно помечается как оценочный — но не выдуманный.
  return { results: measuredResults, controlOk: networkAlive, approximate: !isNativeApp() };
}
