import type { NormalizedSpeedRun } from './speedPayload';

/**
 * Очередь замеров на устройстве.
 *
 * Замер длится до 18 секунд и передаёт десятки мегабайт. Если история в этот
 * момент недоступна (сервер лёг, сеть сменилась при выключении VPN), результат
 * нельзя терять: он ждёт здесь и уходит при следующем открытии экрана.
 */
export const SPEED_PENDING_KEY = 'pulsenet.speed.pending';
export const SPEED_PENDING_LIMIT = 20;

function isRun(value: unknown): value is NormalizedSpeedRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  return typeof run.created_at === 'string' && Number.isFinite(Number(run.download_mbps))
    && Number.isFinite(Number(run.upload_mbps));
}

/** Читает очередь, спокойно переживая мусор и повреждённый JSON. */
export function readPendingSpeedRuns(raw: string | null | undefined): NormalizedSpeedRun[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRun).slice(0, SPEED_PENDING_LIMIT);
  } catch { return []; }
}

/** Добавляет замер, не плодя дубликаты при повторных попытках отправки. */
export function queuePendingSpeedRun(raw: string | null | undefined, run: NormalizedSpeedRun): NormalizedSpeedRun[] {
  const existing = readPendingSpeedRuns(raw).filter((item) =>
    !(item.created_at === run.created_at && (item.profile_id ?? null) === (run.profile_id ?? null)));
  return [run, ...existing].slice(0, SPEED_PENDING_LIMIT);
}
