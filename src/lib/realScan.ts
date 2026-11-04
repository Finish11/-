import type { ScanSiteResult, Site } from '../types';
import { mapLimit, measureUrl } from './nativeBridge';

/**
 * Настоящий замер: приложение само запрашивает probe_url каждого сайта
 * и считает время ответа. В APK запросы идут нативным HTTP-стеком, поэтому
 * не упираются в CORS. Пороговые значения — как в серверных пробах.
 */
const OK_MS = 1500;
const SLOW_MS = 4000;

export async function runRealSiteScan(
  sites: Site[],
  onProgress: (
    done: number,
    total: number,
    latest: ScanSiteResult,
    partial: ScanSiteResult[]
  ) => void,
  abortSignal?: AbortSignal,
  timeoutMs = 6000
): Promise<ScanSiteResult[]> {
  const enabled = sites.filter((s) => Boolean(s.enabled));
  const total = enabled.length;
  let done = 0;
  const acc: ScanSiteResult[] = [];

  const results = await mapLimit(enabled, 6, async (site) => {
    if (abortSignal?.aborted) {
      return {
        site_id: site.id,
        name: site.name,
        domain: site.domain,
        category: site.category,
        marker_role: site.marker_role,
        status: 'blocked' as const,
        latency_ms: null,
      };
    }

    const probeUrl = site.probe_url || `https://${site.domain}/favicon.ico`;
    const measured = await measureUrl(probeUrl, timeoutMs);
    const ms = measured.latencyMs;

    const status: ScanSiteResult['status'] =
      ms == null ? 'blocked' : ms <= OK_MS ? 'ok' : ms <= SLOW_MS ? 'slow' : 'blocked';

    const result: ScanSiteResult = {
      site_id: site.id,
      name: site.name,
      domain: site.domain,
      category: site.category,
      marker_role: site.marker_role,
      status,
      latency_ms: ms,
    };

    acc.push(result);
    done += 1;
    onProgress(done, total, result, [...acc]);
    return result;
  });

  return results;
}
