/** Общий контракт Express/SQLite и Worker/D1. Никаких платформенных импортов. */
export const COMMUNITY_SERVICE = 'pulsenet-community';
export const COMMUNITY_VERSION = 1;
export const INCIDENT_TYPES = ['whitelist', 'mobile_shutdown', 'dpi_wave', 'vpn_block', 'cdn_block'] as const;
export const SEVERITIES = ['critical', 'high', 'moderate'] as const;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Старые APK использовали inc_<32 hex>; новые — UUID v4. Оба формата идемпотентны. */
export const CLIENT_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|inc_[0-9a-f]{32})$/i;
export const DEVICE_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
export const DEVICE_SECRET_RE = /^[0-9a-f]{64}$/;
export class ContractError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface IncidentInput {
  client_id: string; region: string; carrier: string; incident_type: typeof INCIDENT_TYPES[number];
  severity: typeof SEVERITIES[number]; status: 'active' | 'resolved'; title: string; description: string;
  ru_sites_ok: boolean; foreign_sites_ok: boolean; user_upvoted: boolean; created_at: string; updated_at: string;
}
const text = (value: unknown, field: string, max: number, required = true): string => {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new ContractError(`Поле ${field} должно быть строкой`);
  const result = value.trim();
  if (required && !result) throw new ContractError(`Заполните ${field}`);
  if (result.length > max) throw new ContractError(`Поле ${field} длиннее ${max} символов`);
  return result;
};
const bool = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ContractError('Логическое поле должно быть true или false');
  return value;
};
export function validClientId(value: unknown): string {
  if (typeof value !== 'string' || !CLIENT_ID_RE.test(value)) throw new ContractError('Некорректный ID отчёта');
  return value.toLowerCase();
}
export function deviceIdentity(deviceId: string | null, secret: string | null): { deviceId: string; secret: string } {
  if (!deviceId || !DEVICE_ID_RE.test(deviceId) || !secret || !DEVICE_SECRET_RE.test(secret))
    throw new ContractError('Нужен действительный идентификатор устройства', 401);
  return { deviceId: deviceId.toLowerCase(), secret };
}
export async function hashDevice(deviceId: string, secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${deviceId.toLowerCase()}:${secret}`);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function parseIncident(body: unknown, existing?: IncidentInput): IncidentInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ContractError('Нужен JSON-объект отчёта');
  const b = body as Record<string, unknown>;
  const clientId = validClientId(b.client_id ?? existing?.client_id);
  const type = b.incident_type ?? existing?.incident_type ?? 'whitelist';
  const severity = b.severity ?? existing?.severity ?? 'moderate';
  const status = b.status ?? existing?.status ?? 'active';
  if (!INCIDENT_TYPES.includes(type as IncidentInput['incident_type'])) throw new ContractError('Неизвестный тип сбоя');
  if (!SEVERITIES.includes(severity as IncidentInput['severity'])) throw new ContractError('Неизвестная серьёзность');
  if (status !== 'active' && status !== 'resolved') throw new ContractError('Неизвестный статус сбоя');
  const now = new Date().toISOString();
  const date = (value: unknown, fallback: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new ContractError('Некорректная дата отчёта');
    return new Date(value).toISOString();
  };
  return {
    client_id: clientId, region: text(b.region ?? existing?.region, 'регион', 100), carrier: text(b.carrier ?? existing?.carrier, 'оператор', 100),
    incident_type: type as IncidentInput['incident_type'], severity: severity as IncidentInput['severity'], status,
    title: text(b.title ?? existing?.title, 'заголовок', 180), description: text(b.description ?? existing?.description, 'описание', 4000, false),
    ru_sites_ok: bool(b.ru_sites_ok, existing?.ru_sites_ok ?? true), foreign_sites_ok: bool(b.foreign_sites_ok, existing?.foreign_sites_ok ?? false),
    user_upvoted: bool(b.user_upvoted, existing?.user_upvoted ?? true),
    created_at: date(b.created_at, existing?.created_at ?? now), updated_at: date(b.updated_at, existing?.updated_at ?? now),
  };
}
export interface StoredIncident extends Omit<IncidentInput, 'user_upvoted'> { id: number; device_hash: string; upvotes: number; user_upvoted?: number | boolean }
export function publicIncident(row: StoredIncident, deviceHash: string) {
  return {
    id: row.id, user_id: null, author_name: `Участник ${row.device_hash.slice(0, 4)}`,
    region: row.region, carrier: row.carrier, incident_type: row.incident_type, severity: row.severity, status: row.status,
    title: row.title, description: row.description, upvotes: Number(row.upvotes),
    ru_sites_ok: Boolean(row.ru_sites_ok), foreign_sites_ok: Boolean(row.foreign_sites_ok),
    user_upvoted: Boolean(row.user_upvoted), is_owner: row.device_hash === deviceHash,
    client_id: row.client_id, created_at: row.created_at, updated_at: row.updated_at, sync_state: 'synced' as const,
  };
}
export interface Cursor { at: string; id: number }
export function encodeCursor(row: { created_at: string; id: number }): string {
  return btoa(JSON.stringify({ at: row.created_at, id: row.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 256) throw new Error();
    const parsed = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || !Number.isSafeInteger(parsed.id) || parsed.id < 1) throw new Error();
    return { at: new Date(parsed.at).toISOString(), id: parsed.id };
  } catch { throw new ContractError('Некорректный курсор ленты'); }
}
export function pageLimit(value: string | null): number {
  if (value == null || value === '') return 200;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ContractError('limit должен быть от 1 до 200');
  return limit;
}
