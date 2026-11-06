import type { Site } from '../types';

/**
 * Длинные проверки должны стартовать в первых свободных потоках.
 * Сортировка стабильна: при равном приоритете порядок каталога сохраняется.
 */
export function orderSitesForScan(sites: Site[]): Site[] {
  return sites
    .map((site, index) => ({ site, index, score: priority(site) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ site }) => site);
}

function priority(site: Site): number {
  let score = 0;
  // Прежний таймаут/отказ — самый сильный сигнал возможного длинного хвоста.
  if (site.last_checked_at && site.last_status === 'blocked') score += 1200;
  // Неизвестный, но уже проверявшийся адрес тоже запускаем заранее.
  if (site.last_checked_at && site.last_latency_ms == null) score += 700;
  const latency = site.last_latency_ms;
  if (latency != null && Number.isFinite(latency)) {
    if (latency >= 3500) score += 1000;
    else if (latency >= 1500) score += 650;
    else if (latency >= 700) score += 350;
    else if (latency >= 300) score += 150;
  }
  // Известные цели фильтрации чаще других доходят до таймаута/DPI.
  if (site.marker_role === 'dpi_target') score += 180;
  return score;
}
