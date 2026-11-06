import { CapacitorHttp } from '@capacitor/core';
import { isNativeApp, mapLimit } from './nativeBridge';
import type { Incident } from '../types';

const ENDPOINT_KEY = 'pulsenet_community_url';
const DEVICE_ID_KEY = 'pulsenet_community_device_id';
const DEVICE_SECRET_KEY = 'pulsenet_community_device_secret';
let memoryCredentials: { deviceId: string; secret: string } | null = null;
let endpointOverride: string | null = null;

const randomHex = (bytes: number): string => {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
};

export function newClientId(): string {
  return `inc_${randomHex(16)}`;
}

export function getCommunityEndpoint(): string {
  if (endpointOverride !== null) return endpointOverride;
  try {
    const configured = localStorage.getItem(ENDPOINT_KEY) || import.meta.env.VITE_COMMUNITY_API_URL || '';
    return configured ? normalizeCommunityEndpoint(configured) : '';
  } catch {
    try {
      const configured = import.meta.env.VITE_COMMUNITY_API_URL || '';
      return configured ? normalizeCommunityEndpoint(configured) : '';
    } catch {
      return '';
    }
  }
}

export function normalizeCommunityEndpoint(value: string): string {
  const clean = value.trim();
  if (!clean) return '';
  const url = new URL(clean);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Для общего сервера нужен HTTPS-адрес');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Укажите адрес сервера без логина, параметров и якоря');
  }
  return url.toString().replace(/\/+$/, '');
}

export function setCommunityEndpoint(value: string): string {
  const normalized = normalizeCommunityEndpoint(value);
  endpointOverride = normalized;
  try {
    if (normalized) localStorage.setItem(ENDPOINT_KEY, normalized);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // Runtime override сохраняет выбранный сервер до перезапуска.
  }
  return normalized;
}

function credentials(): { deviceId: string; secret: string } {
  let deviceId = memoryCredentials?.deviceId || '';
  let secret = memoryCredentials?.secret || '';
  try {
    deviceId = localStorage.getItem(DEVICE_ID_KEY) || deviceId || randomHex(16);
    secret = localStorage.getItem(DEVICE_SECRET_KEY) || secret || randomHex(32);
    // Сохраняем пару целиком: частично записанные credentials не должны
    // менять владельца уже отправленных отчётов при следующем запросе.
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    localStorage.setItem(DEVICE_SECRET_KEY, secret);
  } catch {
    if (!deviceId) deviceId = randomHex(16);
    if (!secret) secret = randomHex(32);
  }
  memoryCredentials = { deviceId, secret };
  return memoryCredentials;
}

interface CommunityResponse<T> {
  status: number;
  data: T;
}

export class CommunityRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'CommunityRequestError';
  }
}

export function isMissingCommunityIncident(error: unknown): boolean {
  return error instanceof CommunityRequestError && error.status === 404;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const endpoint = getCommunityEndpoint();
  if (!endpoint) throw new Error('Общий сервер не подключён');
  const { deviceId, secret } = credentials();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Device-Id': deviceId,
    'X-Device-Secret': secret,
  };
  const url = `${endpoint}${path}`;
  let response: CommunityResponse<unknown>;
  if (isNativeApp()) {
    const raw = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body,
      connectTimeout: 15000,
      readTimeout: 15000,
    });
    response = { status: raw.status, data: raw.data };
  } else {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const raw = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      response = { status: raw.status, data: await raw.text() };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Общий сервер не ответил за 15 секунд');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }
  let data: Record<string, unknown>;
  if (typeof response.data === 'string') {
    try {
      data = JSON.parse(response.data) as Record<string, unknown>;
    } catch {
      if (response.status >= 200 && response.status < 300) throw new Error('Общий сервер вернул некорректный JSON');
      data = {};
    }
  } else {
    data = response.data as Record<string, unknown>;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new CommunityRequestError(
      typeof data?.error === 'string' ? data.error : `Общий сервер ответил ${response.status}`,
      response.status
    );
  }
  return data as T;
}

const remoteIncident = (incident: Incident): Incident => ({ ...incident, sync_state: 'synced', sync_error: undefined });
const incidentKey = (incident: Incident): string => incident.client_id ? `client:${incident.client_id}` : `local:${incident.id}`;
const sortIncidents = (items: Incident[]): Incident[] => items.sort((a, b) =>
  Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.created_at.localeCompare(a.created_at)
);

/** Серверный числовой PK не используем как локальный ключ: он может совпасть с демо-записью. */
function withLocalIds(remote: Incident[], local: Incident[]): Incident[] {
  const localIds = new Map(local.filter((item) => item.client_id).map((item) => [item.client_id!, item.id]));
  const used = new Set(local.map((item) => item.id));
  return remote.map((incident) => {
    const clientId = incident.client_id;
    if (!clientId) return remoteIncident(incident);
    let id = localIds.get(clientId);
    if (id == null) {
      // Детерминированный ID сохраняется между синхронизациями даже после очистки кэша.
      const hash = Number.parseInt(clientId.replace(/^inc_/, '').slice(0, 8), 16) >>> 0;
      id = 2_000_000 + hash % 2_000_000_000;
      while (used.has(id)) id += 1;
      localIds.set(clientId, id);
    }
    used.add(id);
    return { ...remoteIncident(incident), id };
  });
}

/**
 * Не даём завершившемуся запросу стереть действия, сделанные во время синхронизации.
 * Новые/изменённые локальные объекты побеждают снимок, удалённые исчезают из результата.
 */
export function reconcileCommunitySync(snapshot: Incident[], current: Incident[], synced: Incident[]): Incident[] {
  const before = new Map(snapshot.map((item) => [incidentKey(item), item]));
  const now = new Map(current.map((item) => [incidentKey(item), item]));
  const merged = new Map<string, Incident>();
  for (const item of synced) {
    const key = incidentKey(item);
    if (before.has(key) && !now.has(key)) continue;
    merged.set(key, item);
  }
  for (const item of current) {
    const key = incidentKey(item);
    if (before.get(key) !== item) merged.set(key, item);
  }
  return sortIncidents([...merged.values()]);
}

export function communitySyncChanged(snapshot: Incident[], current: Incident[]): boolean {
  if (snapshot.length !== current.length) return true;
  const before = new Map(snapshot.map((item) => [incidentKey(item), item]));
  return current.some((item) => before.get(incidentKey(item)) !== item);
}

export async function updateCommunityIncident(clientId: string, body: unknown): Promise<Incident> {
  const result = await request<{ incident: Incident }>('PATCH', `/api/community/incidents/${encodeURIComponent(clientId)}`, body);
  return remoteIncident(result.incident);
}

export async function deleteCommunityIncident(clientId: string): Promise<void> {
  try {
    await request('DELETE', `/api/community/incidents/${encodeURIComponent(clientId)}`);
  } catch (error) {
    // Отчёт мог быть ещё не создан после оборванного POST — тогда цель удаления уже достигнута.
    if (!isMissingCommunityIncident(error)) throw error;
  }
}

export async function voteCommunityIncident(clientId: string): Promise<Incident> {
  const result = await request<{ incident: Incident }>('POST', `/api/community/incidents/${encodeURIComponent(clientId)}/upvote`, {});
  return remoteIncident(result.incident);
}

/** Сначала отправляет локальную очередь, затем объединяет общую ленту без дублей. */
export async function synchronizeCommunity(local: Incident[]): Promise<{ incidents: Incident[]; failed: number }> {
  const uploaded = new Map<string, Incident>();
  let failed = 0;
  await mapLimit(local, 4, async (incident) => {
    if (!incident.client_id || incident.sync_state === 'synced') return;
    try {
      const result = await request<{ incident: Incident }>('POST', '/api/community/incidents', {
        client_id: incident.client_id,
        region: incident.region,
        carrier: incident.carrier,
        incident_type: incident.incident_type,
        severity: incident.severity,
        title: incident.title,
        description: incident.description,
        ru_sites_ok: incident.ru_sites_ok,
        foreign_sites_ok: incident.foreign_sites_ok,
        user_upvoted: incident.user_upvoted,
        created_at: incident.created_at,
      });
      uploaded.set(incident.client_id, remoteIncident(result.incident));
    } catch (error) {
      failed += 1;
      uploaded.set(incident.client_id, {
        ...incident,
        sync_state: 'error',
        sync_error: error instanceof Error ? error.message : 'Сервер недоступен; повторим при следующей синхронизации',
      });
    }
  });

  const remote = await request<{ incidents: Incident[] }>('GET', '/api/community/incidents');
  const merged = new Map<string, Incident>();
  for (const incident of withLocalIds(remote.incidents, local)) {
    if (incident.client_id) merged.set(incident.client_id, incident);
  }
  for (const incident of local) {
    const clientId = incident.client_id;
    if (!clientId) continue;
    const next = uploaded.get(clientId) || incident;
    if (next.sync_state !== 'synced' && !merged.has(clientId)) merged.set(clientId, next);
  }
  // Совместимость со старыми локальными записями без client_id: не удаляем их.
  const legacy = local.filter((incident) => !incident.client_id);
  return { incidents: sortIncidents([...legacy, ...merged.values()]), failed };
}
