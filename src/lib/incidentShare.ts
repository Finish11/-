import type { Incident } from '../types';

/**
 * Обмен отчётами о сбоях без сервера.
 *
 * Общий сервер — лучший путь, но он требует, чтобы владелец его развернул.
 * Пока сервера нет, отчёты можно передать файлом или текстом в любом мессенджере:
 * формат тот же, что у общего API, слияние по client_id, удаление уважается.
 * Секреты устройства и голоса в пакет не попадают — только публичные поля.
 */
export const BUNDLE_VERSION = 1;
export const BUNDLE_MAX_ITEMS = 500;
export const BUNDLE_MAX_BYTES = 2_000_000;

export interface IncidentBundle {
  pulsenet: 'incidents';
  version: number;
  exported_at: string;
  endpoint?: string;
  author?: string;
  incidents: SharedIncident[];
  /** Удалённые client_id: импорт не должен воскрешать отчёт, который удалили. */
  deleted?: string[];
}

export interface SharedIncident {
  client_id: string;
  region: string;
  carrier: string;
  incident_type: string;
  severity: string;
  status: 'active' | 'resolved';
  title: string;
  description: string;
  upvotes: number;
  ru_sites_ok: boolean;
  foreign_sites_ok: boolean;
  created_at: string;
  updated_at: string;
}

const CLIENT_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|inc_[0-9a-f]{32})$/i;
const TYPES = new Set(['whitelist', 'blocking', 'degradation', 'shutdown']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

function iso(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : '';
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback;
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** В пакет идут только публичные поля: ни device_hash, ни секретов, ни локальных id. */
export function sharedIncident(item: Incident): SharedIncident | null {
  if (!item.client_id || !CLIENT_ID.test(item.client_id)) return null;
  const created = iso(item.created_at, new Date().toISOString());
  return {
    client_id: item.client_id.toLowerCase(),
    region: text(item.region, 120), carrier: text(item.carrier, 80),
    incident_type: TYPES.has(item.incident_type) ? item.incident_type : 'blocking',
    severity: SEVERITIES.has(item.severity) ? item.severity : 'medium',
    status: item.status === 'resolved' ? 'resolved' : 'active',
    title: text(item.title, 180), description: text(item.description, 4000),
    upvotes: Math.max(0, Math.min(1_000_000, Math.round(Number(item.upvotes) || 0))),
    ru_sites_ok: Boolean(item.ru_sites_ok), foreign_sites_ok: Boolean(item.foreign_sites_ok),
    created_at: created, updated_at: iso(item.updated_at, created),
  };
}

export function exportIncidentBundle(items: Incident[], options: { endpoint?: string; author?: string; now?: string } = {}): string {
  const exported = items.filter((item) => !item.demo).map(sharedIncident).filter((item): item is SharedIncident => item !== null);
  const bundle: IncidentBundle = {
    pulsenet: 'incidents', version: BUNDLE_VERSION,
    exported_at: options.now || new Date().toISOString(),
    endpoint: options.endpoint || undefined, author: options.author ? text(options.author, 80) : undefined,
    incidents: exported.slice(0, BUNDLE_MAX_ITEMS),
    deleted: items.filter((item) => item.pending_delete && item.client_id).map((item) => item.client_id!.toLowerCase()).slice(0, BUNDLE_MAX_ITEMS),
  };
  return JSON.stringify(bundle, null, 2);
}

export interface BundleImportResult {
  ok: boolean;
  error: string;
  bundle: IncidentBundle | null;
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  incidents: Incident[];
}

/**
 * Слияние детерминированное: побеждает более свежая updated_at, при равенстве —
 * уже сохранённая копия. Удалённые client_id не воскрешаются.
 */
export function importIncidentBundle(raw: string, existing: Incident[], options: { userId?: number; now?: string } = {}): BundleImportResult {
  const fail = (error: string): BundleImportResult => ({ ok: false, error, bundle: null, added: 0, updated: 0, skipped: 0, removed: 0, incidents: existing });
  if (raw.length > BUNDLE_MAX_BYTES) return fail('Файл слишком большой: ожидается пакет отчётов, а не дамп базы');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return fail('Это не JSON: вставьте текст пакета отчётов целиком'); }
  const bundle = parsed as Partial<IncidentBundle>;
  if (!bundle || bundle.pulsenet !== 'incidents') return fail('Это не пакет отчётов «ПульсСети»');
  if (Number(bundle.version) !== BUNDLE_VERSION) return fail(`Версия пакета ${String(bundle.version)} не поддерживается этой сборкой`);
  if (!Array.isArray(bundle.incidents)) return fail('В пакете нет списка отчётов');
  if (bundle.incidents.length > BUNDLE_MAX_ITEMS) return fail(`В пакете больше ${BUNDLE_MAX_ITEMS} отчётов`);

  const now = options.now || new Date().toISOString();
  const deleted = new Set((Array.isArray(bundle.deleted) ? bundle.deleted : [])
    .filter((id): id is string => typeof id === 'string' && CLIENT_ID.test(id)).map((id) => id.toLowerCase()));
  const byClient = new Map<string, Incident>();
  for (const item of existing) if (item.client_id) byClient.set(item.client_id.toLowerCase(), item);

  let added = 0, updated = 0, skipped = 0, removed = 0;
  let nextLocalId = existing.reduce((max, item) => Number.isFinite(item.id) ? Math.max(max, item.id) : max, 0) + 1;
  for (const candidate of bundle.incidents) {
    const shared = candidate && typeof candidate === 'object' ? sharedIncident(candidate as unknown as Incident) : null;
    if (!shared || deleted.has(shared.client_id)) { skipped++; continue; }
    const current = byClient.get(shared.client_id);
    if (current?.pending_delete) { skipped++; continue; }
    if (current) {
      const currentTime = Date.parse(current.updated_at || current.created_at || '');
      const incomingTime = Date.parse(shared.updated_at);
      if (!Number.isFinite(incomingTime) || (Number.isFinite(currentTime) && incomingTime <= currentTime)) { skipped++; continue; }
      // Свои несохранённые правки не перетираем чужим пакетом.
      if (current.is_owner && current.sync_dirty) { skipped++; continue; }
      byClient.set(shared.client_id, { ...current, ...shared, id: current.id, imported_at: now } as Incident);
      updated++;
      continue;
    }
    byClient.set(shared.client_id, {
      ...shared, id: nextLocalId++, user_id: options.userId ?? 0, author_name: text(bundle.author, 80) || 'Участник',
      user_upvoted: false, is_owner: false, sync_state: 'synced', sync_dirty: false,
      sync_endpoint: typeof bundle.endpoint === 'string' ? bundle.endpoint : undefined,
      imported_at: now,
    } as Incident);
    added++;
  }
  const incidents = existing.filter((item) => {
    if (!item.client_id || !deleted.has(item.client_id.toLowerCase())) return true;
    // Своё удаление клиент дошлёт сам; чужую копию убираем сразу.
    if (item.is_owner) return true;
    // Иначе карта существующих вернёт удалённую копию обратно при слиянии.
    byClient.delete(item.client_id.toLowerCase());
    removed++;
    return false;
  }).map((item) => item.client_id ? byClient.get(item.client_id.toLowerCase()) || item : item);
  for (const [client, item] of byClient) {
    if (!incidents.some((existingItem) => existingItem.client_id?.toLowerCase() === client)) incidents.push(item);
  }
  return { ok: true, error: '', bundle: bundle as IncidentBundle, added, updated, skipped, removed, incidents };
}

/** Ссылка-приглашение: получатель открывает приложение и сразу подключает сервер. */
export function communityInviteLink(endpoint: string, appUrl: string): string {
  const base = appUrl.replace(/#.*$/, '');
  return `${base}#community=${encodeURIComponent(endpoint)}`;
}

export function readCommunityInvite(hash: string): string {
  const match = /(?:^|[#&])community=([^&]+)/.exec(hash || '');
  if (!match) return '';
  try { return decodeURIComponent(match[1]).trim(); } catch { return ''; }
}
