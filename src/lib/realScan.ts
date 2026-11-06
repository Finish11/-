import type { ScanSiteResult, Site } from '../types';
import { isNativeApp, mapLimit } from './nativeBridge';
import { probeControl, probeSite, type ProbeVerdict } from './siteProbe';
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

const statusFromVerdict = (v: ProbeVerdict): ScanSiteResult['status'] =>
  v === 'ok' || v === 'slow' ? v : 'blocked';

export async function runRealSiteScan(
  sites: Site[],
  onProgress: (
    done: number,
    total: number,
    latest: ScanSiteResult,
    partial: ScanSiteResult[]
  ) => void,
  abortSignal?: AbortSignal,
  timeoutMs = 4500,
  serviceContext: ServiceAccessContext = { withVpn: false }
): Promise<RealScanOutcome> {
  const enabled = sites.filter((s) => Boolean(s.enabled));
  const total = enabled.length;
  let done = 0;
  const acc: ScanSiteResult[] = [];

  // Контрольная проба: без неё «всё недоступно» может означать просто «нет сети».
  // Контрольные адреса проверяются параллельно, а не по 5 секунд каждый.
  let controlOk = await probeControl(Math.min(timeoutMs, 3500));
  const recoveredProbes = new Map<number, Awaited<ReturnType<typeof probeSite>>>();

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
      probe: await probeSite(site.probe_url || `https://${site.domain}/favicon.ico`, { timeoutMs }),
    }));
    for (const { site, probe } of recovery) {
      if (probe.verdict !== 'blocked') {
        controlOk = true;
        recoveredProbes.set(site.id, probe);
      }
    }
  }

  // 32 запроса одновременно: на 75 сайтах не остаётся длинного «хвоста»
  // после первых быстрых ответов, но мобильная сеть не забивается 75 сокетами.
  const scheduled = orderSitesForScan(enabled);
  const results = await mapLimit(scheduled, Math.min(32, enabled.length), async (site) => {
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
      const probeUrl = site.probe_url || `https://${site.domain}/favicon.ico`;
      let probe = recoveredProbes.get(site.id) || await probeSite(probeUrl, { timeoutMs });

      // Один таймаут — не приговор: на мобильной сети пакет теряется просто так.
      // Повторяем только таймаут, коротким вторым запросом. DNS/сброс и
      // подмену не повторяем: это уже определённый ответ, а не случайная потеря.
      let retried = false;
      if (probe.verdict === 'blocked' && /таймаут/i.test(probe.reason || '')) {
        retried = true;
        const second = await probeSite(probeUrl, { timeoutMs: Math.min(timeoutMs, 2500) });
        // Оставляем лучший результат: со второго раза адрес мог ответить.
        if (second.verdict !== 'blocked') probe = second;
      }

      result = {
        site_id: site.id,
        name: site.name,
        domain: site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: statusFromVerdict(probe.verdict),
        latency_ms: probe.verdict === 'ok' || probe.verdict === 'slow' ? probe.latencyMs : null,
        proof: probe.proof,
        block_reason:
          probe.verdict === 'ok' || probe.verdict === 'slow'
            ? undefined
            : probe.verdict === 'intercepted'
            ? 'throttled'
            : 'network',
      };

      // Причина отказа видна в детальном списке — так понятно, что именно случилось.
      if (probe.reason && (probe.verdict !== 'ok' && probe.verdict !== 'slow' || probe.proof === 'endpoint' || probe.proof === 'opaque')) {
        (result as ScanSiteResult & { note?: string }).note = retried
          ? `${probe.reason} · проверено дважды`
          : probe.reason;
      }
      if (probe.verdict === 'intercepted') {
        (result as ScanSiteResult & { intercepted?: boolean }).intercepted = true;
      }
    }

    if (controlOk) result = applyServiceAccessPolicy(site, result, serviceContext);
    acc.push(result);
    done += 1;
    onProgress(done, total, result, [...acc]);
    return result;
  });

  // Приоритет влияет только на расписание запросов, а не на порядок отчёта.
  const originalOrder = new Map(enabled.map((site, index) => [site.id, index]));
  results.sort(
    (a, b) => (originalOrder.get(a.site_id || -1) ?? 0) - (originalOrder.get(b.site_id || -1) ?? 0)
  );

  // Если хоть один сайт ответил — сеть точно жива, даже когда контрольные
  // адреса заблокированы (так бывает при белых списках).
  const anyAnswered = results.some((r) => r.status !== 'blocked' || r.intercepted);
  const networkAlive = controlOk || anyAnswered;

  // В браузере мы видим только сам факт ответа (CORS не даёт прочитать страницу),
  // поэтому результат честно помечается как оценочный — но не выдуманный.
  return { results, controlOk: networkAlive, approximate: !isNativeApp() };
}
