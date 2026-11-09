/**
 * Единая проверка замера перед записью в историю.
 *
 * Раньше Express и автономное демо проверяли по-разному: демо пропускало NaN в
 * задержке, сервер — произвольную строку в типе сети. Теперь оба вызывают этот
 * модуль, поэтому история одинаково защищена и в APK, и на сервере.
 */
export interface NormalizedSpeedRun {
  created_at: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number | null;
  jitter_ms: number | null;
  loaded_ping_ms: number | null;
  download_bytes: number;
  upload_bytes: number;
  server: string;
  network_kind: string;
  network_name: string;
  route: 'vpn' | 'direct' | 'unknown';
  vpn_package: string;
  vpn_app_name: string;
  exit_ip: string;
  profile_id: number | null;
  profile_name: string;
  reliable: boolean;
  note: string;
}

export type SpeedPayloadResult =
  | { ok: true; run: NormalizedSpeedRun }
  | { ok: false; error: string };

const NETWORK_KINDS = ['wifi', 'cellular', 'ethernet', 'unknown'];
const ROUTES = ['vpn', 'direct', 'unknown'];
/** Выше 100 Гбит/с — не канал пользователя, а испорченный замер. */
const MAX_MBPS = 100_000;
const MAX_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_LATENCY_MS = 60_000;

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : value == null ? '' : String(value).slice(0, limit);
}

/** Некорректная задержка не ломает замер: значение отбрасывается, а не выдумывается. */
function latency(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_LATENCY_MS) return null;
  return Math.round(parsed * 10) / 10;
}

function bytes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_BYTES, Math.round(parsed));
}

export function normalizeSpeedRunPayload(input: unknown, now: Date = new Date()): SpeedPayloadResult {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const down = Number(body.download_mbps);
  const up = Number(body.upload_mbps);
  if (!Number.isFinite(down) || down < 0 || down > MAX_MBPS || !Number.isFinite(up) || up < 0 || up > MAX_MBPS)
    return { ok: false, error: 'Некорректные значения скорости' };
  const rawProfile = body.profile_id;
  let profileId: number | null = null;
  if (rawProfile != null && rawProfile !== '') {
    const parsed = Number(rawProfile);
    if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, error: 'Некорректный идентификатор узла' };
    profileId = parsed;
  }
  const createdAt = typeof body.created_at === 'string' && body.created_at && !Number.isNaN(Date.parse(body.created_at))
    ? new Date(body.created_at).toISOString() : now.toISOString();
  const networkKind = text(body.network_kind, 20);
  const route = text(body.route, 20);
  return {
    ok: true,
    run: {
      created_at: createdAt,
      download_mbps: Math.round(down * 1000) / 1000,
      upload_mbps: Math.round(up * 1000) / 1000,
      ping_ms: latency(body.ping_ms),
      jitter_ms: latency(body.jitter_ms),
      loaded_ping_ms: latency(body.loaded_ping_ms),
      download_bytes: bytes(body.download_bytes),
      upload_bytes: bytes(body.upload_bytes),
      server: text(body.server, 200),
      network_kind: NETWORK_KINDS.includes(networkKind) ? networkKind : 'unknown',
      network_name: text(body.network_name, 80),
      route: (ROUTES.includes(route) ? route : 'unknown') as NormalizedSpeedRun['route'],
      vpn_package: text(body.vpn_package, 160),
      vpn_app_name: text(body.vpn_app_name, 160),
      exit_ip: text(body.exit_ip, 80),
      profile_id: profileId,
      profile_name: text(body.profile_name, 160),
      reliable: body.reliable !== false,
      note: text(body.note, 400),
    },
  };
}
