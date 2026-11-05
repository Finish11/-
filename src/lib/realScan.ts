import type { ScanSiteResult, Site } from '../types';
import { isNativeApp, mapLimit } from './nativeBridge';
import { probeControl, probeSite, type ProbeVerdict } from './siteProbe';

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
  timeoutMs = 4500
): Promise<RealScanOutcome> {
  const enabled = sites.filter((s) => Boolean(s.enabled));
  const total = enabled.length;
  let done = 0;
  const acc: ScanSiteResult[] = [];

  // Контрольная проба: без неё «всё недоступно» может означать просто «нет сети».
  // Контрольные адреса проверяются параллельно, а не по 5 секунд каждый.
  const controlOk = await probeControl(Math.min(timeoutMs, 3500));

  // 32 запроса одновременно: на 75 сайтах не остаётся длинного «хвоста»
  // после первых быстрых ответов, но мобильная сеть не забивается 75 сокетами.
  const results = await mapLimit(enabled, Math.min(32, enabled.length), async (site) => {
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
      let probe = await probeSite(probeUrl, { timeoutMs });

      // Один таймаут — не приговор: на мобильной сети пакет теряется просто так.
      // Повторяем только таймаут, коротким вторым запросом. DNS/сброс и
      // подмену не повторяем: это уже определённый ответ, а не случайная потеря.
      let retried = false;
      if (probe.verdict === 'blocked' && /таймаут/i.test(probe.reason || '')) {
        retried = true;
        const second = await probeSite(probeUrl, { timeoutMs: Math.min(timeoutMs, 2500) });
        // Оставляем лучший результат: если со второго раза открылось — значит работает.
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
        block_reason:
          probe.verdict === 'ok' || probe.verdict === 'slow'
            ? undefined
            : probe.verdict === 'intercepted'
            ? 'throttled'
            : 'network',
      };

      // Причина отказа видна в детальном списке — так понятно, что именно случилось.
      if (probe.verdict !== 'ok' && probe.verdict !== 'slow' && probe.reason) {
        (result as ScanSiteResult & { note?: string }).note = retried
          ? `${probe.reason} · проверено дважды`
          : probe.reason;
      }
      if (probe.verdict === 'intercepted') {
        (result as ScanSiteResult & { intercepted?: boolean }).intercepted = true;
      }
    }

    acc.push(result);
    done += 1;
    onProgress(done, total, result, [...acc]);
    return result;
  });

  // Если хоть один сайт ответил — сеть точно жива, даже когда контрольные
  // адреса заблокированы (так бывает при белых списках).
  const anyAnswered = results.some((r) => r.status !== 'blocked' || r.intercepted);
  const networkAlive = controlOk || anyAnswered;

  // В браузере мы видим только сам факт ответа (CORS не даёт прочитать страницу),
  // поэтому результат честно помечается как оценочный — но не выдуманный.
  return { results, controlOk: networkAlive, approximate: !isNativeApp() };
}
