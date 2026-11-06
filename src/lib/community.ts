import { CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { Incident } from '../types';
import { isNativeApp } from './nativeBridge';

const DEVICE_KEY = 'pulsenet_community_device_id';
const SECRET_KEY = 'pulsenet_community_device_secret';
const ENDPOINT_KEY = 'pulsenet_community_url';
const STORAGE_KEY = 'pulsenet-community-credentials-v1';
let memory: { deviceId: string; deviceSecret: string; endpoint: string } | null = null;
let hydrated: Promise<void> | null = null;
let writeChain: Promise<void> = Promise.resolve();
let storageError = '';
export function communityStorageError(): string { return storageError; }
const readLocal = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const writeLocal = (key: string, value: string): boolean => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); return true; } catch { return false; } };
export function normalizeCommunityEndpoint(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, ''); if (!trimmed) return '';
  const url = new URL(trimmed), localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('Общий API должен использовать HTTPS');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    throw new Error('Укажите только адрес сервера: без логина, пути и параметров');
  return url.origin;
}
/** В APK ключ живёт в Preferences, а не только в очищаемом WebView localStorage. */
export function hydrateCommunityStorage(): Promise<void> {
  if (hydrated) return hydrated;
  hydrated = (async () => {
    let stored: Partial<NonNullable<typeof memory>> = {};
    if (isNativeApp()) {
      try { stored = JSON.parse((await Preferences.get({ key: STORAGE_KEY })).value || '{}'); }
      catch { storageError = 'Не удалось прочитать ключ устройства из Android Preferences'; }
    }
    let endpoint = '';
    try { endpoint = normalizeCommunityEndpoint(stored.endpoint || readLocal(ENDPOINT_KEY) || import.meta.env.VITE_COMMUNITY_API_URL || ''); }
    catch { storageError = 'Сохранённый адрес общего сервера некорректен; укажите его заново'; }
    memory = { deviceId: stored.deviceId || readLocal(DEVICE_KEY), deviceSecret: stored.deviceSecret || readLocal(SECRET_KEY), endpoint };
    if (memory.deviceId || memory.endpoint) {
      try { await persistCommunityStorage(); storageError = ''; }
      catch (error) { storageError = error instanceof Error ? error.message : 'Не удалось сохранить ключ устройства'; }
    }
  })();
  return hydrated;
}
function snapshot() {
  if (!memory) memory = { deviceId: readLocal(DEVICE_KEY), deviceSecret: readLocal(SECRET_KEY), endpoint: readLocal(ENDPOINT_KEY) };
  return memory;
}
function persistCommunityStorage(): Promise<void> {
  const value = { ...snapshot() };
  if (!isNativeApp()) {
    const ok = writeLocal(DEVICE_KEY, value.deviceId) && writeLocal(SECRET_KEY, value.deviceSecret) && writeLocal(ENDPOINT_KEY, value.endpoint);
    if (!ok) return Promise.reject(new Error('Браузер запретил сохранить ключ устройства. Освободите место или отключите приватный режим.'));
    return Promise.resolve();
  }
  writeChain = writeChain.catch(() => undefined).then(async () => {
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(value) });
    writeLocal(DEVICE_KEY, value.deviceId); writeLocal(ENDPOINT_KEY, value.endpoint); writeLocal(SECRET_KEY, '');
  });
  return writeChain;
}
export function communityEndpoint(): string { return snapshot().endpoint; }
export const getCommunityEndpoint = communityEndpoint;
export async function setCommunityEndpoint(value: string): Promise<string> {
  await hydrateCommunityStorage(); const endpoint = normalizeCommunityEndpoint(value);
  const previous = snapshot().endpoint; snapshot().endpoint = endpoint;
  try { await persistCommunityStorage(); storageError = ''; } catch (error) { snapshot().endpoint = previous; throw error; }
  return endpoint;
}
export function communityIdentity() {
  const state = snapshot();
  if (!state.deviceId || !state.deviceSecret) {
    state.deviceId ||= crypto.randomUUID();
    if (!state.deviceSecret) { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); state.deviceSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }
  }
  return { deviceId: state.deviceId, deviceSecret: state.deviceSecret };
}
export function communityConfigured(): boolean { return Boolean(communityEndpoint()); }
export async function checkCommunityHealth(endpoint: string): Promise<void> {
  const base = normalizeCommunityEndpoint(endpoint); if (!base) throw new Error('Сначала укажите HTTPS-адрес общего сервера');
  const url = `${base}/api/community/health`; let status: number; let data: { service?: string; ok?: boolean };
  if (isNativeApp()) {
    const response = await CapacitorHttp.get({ url, connectTimeout: 8000, readTimeout: 8000, headers: { Accept: 'application/json' } });
    status = response.status; data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  } else { const response = await fetch(url, { signal: AbortSignal.timeout(8000), credentials: 'omit' }); status = response.status; data = await response.json(); }
  if (status !== 200) throw new Error(`Сервер ответил HTTP ${status}`);
  if (data?.service !== 'pulsenet-community' || data?.ok !== true) throw new Error('По этому адресу нет совместимого API «ПульсСети»');
}
export async function communityRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  await hydrateCommunityStorage(); if (storageError) throw new Error(storageError);
  const base = communityEndpoint(); if (!base) throw new Error('Общий сервер не подключён');
  const identity = communityIdentity(); await persistCommunityStorage(); storageError = '';
  const headers = { 'Content-Type': 'application/json', 'X-Device-Id': identity.deviceId, 'X-Device-Secret': identity.deviceSecret };
  const url = `${base}/api/community${path}`;
  if (isNativeApp()) {
    const response = await CapacitorHttp.request({ url, method: method as 'GET', headers, data: body, connectTimeout: 10000, readTimeout: 15000 });
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    if (response.status < 200 || response.status >= 300) throw new Error(data?.error || `HTTP ${response.status}`); return data as T;
  }
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(18000) });
  const data = await response.json(); if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`); return data as T;
}
export const newClientId = (): string => crypto.randomUUID();
export const incidentClientId = newClientId;
export function incidentPayload(item: Incident) {
  return { client_id: item.client_id, region: item.region, carrier: item.carrier, incident_type: item.incident_type,
    severity: item.severity, status: item.status, title: item.title, description: item.description,
    ru_sites_ok: item.ru_sites_ok, foreign_sites_ok: item.foreign_sites_ok, user_upvoted: item.desired_upvote ?? item.user_upvoted,
    created_at: item.created_at, updated_at: item.updated_at || item.created_at };
}
export function queueIncidentEdit(item: Incident, patch: Partial<Incident>, endpoint = communityEndpoint(), now = new Date().toISOString()): Incident {
  return { ...item, ...patch, updated_at: now, sync_dirty: true, sync_endpoint: endpoint,
    sync_state: item.sync_state === 'synced' ? 'pending' : item.sync_state || 'local', sync_error: '' };
}
export function queueIncidentVote(item: Incident, endpoint = communityEndpoint()): Incident {
  const desired = !(item.desired_upvote ?? item.user_upvoted);
  return { ...item, desired_upvote: desired, user_upvoted: desired, upvotes: Math.max(0, item.upvotes + (desired ? 1 : -1)), vote_dirty: true, sync_endpoint: endpoint };
}
export function queueIncidentDelete(item: Incident, endpoint = communityEndpoint(), now = new Date().toISOString()): Incident {
  return { ...item, pending_delete: true, sync_dirty: true, updated_at: now, sync_endpoint: endpoint, sync_state: 'pending' };
}
export function pendingCommunityCount(items: Incident[]): number {
  return items.filter((item) => !item.demo && (item.vote_dirty || (item.is_owner && (item.pending_delete || item.sync_dirty || item.sync_state !== 'synced')))).length;
}
export function belongsToEndpoint(item: Incident, endpoint: string): boolean { return !item.demo && item.sync_endpoint === endpoint; }
export function withLocalIds(items: Incident[], userId: number, previous: Incident[] = []): Incident[] {
  const known = new Map(previous.filter((item) => item.client_id).map((item) => [`${item.is_owner}:${item.client_id}`, item.id]));
  let nextId = Math.max(0, ...previous.map((item) => item.id)) + 1;
  return [...items].sort((a,b) => String(a.client_id).localeCompare(String(b.client_id))).map((item) => {
    const key = `${item.is_owner}:${item.client_id}`, id = known.get(key) ?? nextId++; known.set(key, id);
    return { ...item, id, user_id: item.is_owner ? userId : null };
  });
}
export function reconcileCommunityState(local: Incident[], remote: Incident[], endpoint: string): Incident[] {
  const localById = new Map(local.map((item) => [item.id, item]));
  const merged = remote.map((item) => {
    const old = localById.get(item.id); if (!old || old.demo) return item; if (old.pending_delete) return old;
    const keepEdit = old.sync_dirty && old.sync_endpoint === endpoint, keepVote = old.vote_dirty && old.sync_endpoint === endpoint;
    return { ...item,
      ...(keepEdit ? { title: old.title, description: old.description, region: old.region, carrier: old.carrier,
        incident_type: old.incident_type, severity: old.severity, status: old.status, ru_sites_ok: old.ru_sites_ok,
        foreign_sites_ok: old.foreign_sites_ok, updated_at: old.updated_at, sync_dirty: true, sync_state: 'pending' as const } : {}),
      ...(keepVote ? { vote_dirty: true, desired_upvote: old.desired_upvote, user_upvoted: old.user_upvoted,
        upvotes: Math.max(0, item.upvotes + ((old.desired_upvote ?? old.user_upvoted) === item.user_upvoted ? 0 : (old.desired_upvote ?? old.user_upvoted) ? 1 : -1)) } : {}),
      sync_endpoint: endpoint, sync_error: keepEdit || keepVote ? old.sync_error : '' };
  });
  const remoteIds = new Set(remote.map((item) => item.id)), remoteOwnedKeys = new Set(remote.filter((item) => item.is_owner).map((item) => item.client_id));
  for (const item of local) {
    if (remoteIds.has(item.id)) continue;
    if (item.sync_endpoint && item.sync_endpoint !== endpoint) { merged.push(item); continue; }
    if (item.pending_delete || (item.sync_dirty && !remoteOwnedKeys.has(item.client_id)) || (!item.client_id && item.is_owner && item.sync_state !== 'synced')) merged.push(item);
  }
  return merged.sort((a,b) => b.created_at.localeCompare(a.created_at));
}
export interface CommunitySyncResult { incidents: Incident[]; failed: number; fetched: boolean; error?: string }
let syncFlight: Promise<CommunitySyncResult> | null = null;
export function synchronizeCommunity(current: Incident[], userId = 1): Promise<CommunitySyncResult> {
  if (syncFlight) return syncFlight;
  syncFlight = synchronizeNow(current, userId).finally(() => { syncFlight = null; }); return syncFlight;
}
async function synchronizeNow(current: Incident[], userId: number): Promise<CommunitySyncResult> {
  await hydrateCommunityStorage(); const endpoint = communityEndpoint();
  if (!endpoint || !navigator.onLine) return { incidents: current, failed: pendingCommunityCount(current), fetched: false };
  let working = current.map((item) => ({ ...item })), failed = 0;
  const mark = (id: number, patch: Partial<Incident>) => { working = working.map((item) => item.id === id ? { ...item, ...patch } : item); };
  for (const item of current.filter((item) => item.pending_delete && item.is_owner && belongsToEndpoint(item, endpoint))) {
    try { await communityRequest(`/incidents/${encodeURIComponent(item.client_id || String(item.id))}`, 'DELETE'); working = working.filter((row) => row.id !== item.id); }
    catch (error) { failed++; mark(item.id, { sync_state: 'error', sync_error: error instanceof Error ? error.message : 'Удаление не доставлено' }); }
  }
  for (const original of current.filter((item) => !item.demo && !item.pending_delete && belongsToEndpoint(item, endpoint) && (item.is_owner || item.vote_dirty))) {
    let item = working.find((row) => row.id === original.id);
    if (!item || (!item.sync_dirty && !item.vote_dirty && item.sync_state === 'synced')) continue;
    try {
      if (item.is_owner && (item.sync_dirty || item.sync_state !== 'synced')) {
        const result = await communityRequest<{ incident: Incident }>(item.sync_state === 'synced' ? `/incidents/${encodeURIComponent(item.client_id || String(item.id))}` : '/incidents',
          item.sync_state === 'synced' ? 'PATCH' : 'POST', incidentPayload(item));
        const live = working.find((row) => row.id === original.id)!, edited = live.updated_at !== item.updated_at;
        mark(item.id, { ...result.incident, id: item.id, user_id: userId, sync_endpoint: endpoint,
          sync_state: edited ? 'pending' : 'synced', sync_dirty: edited, vote_dirty: live.vote_dirty, desired_upvote: live.desired_upvote,
          sync_error: '', client_id: result.incident.client_id || item.client_id });
        item = working.find((row) => row.id === original.id)!;
      }
      if (item.vote_dirty) {
        const desired = item.desired_upvote ?? item.user_upvoted;
        const result = await communityRequest<{ incident: Incident }>(`/incidents/${encodeURIComponent(item.client_id || String(item.id))}/vote`, 'PUT', { voted: desired });
        const live = working.find((row) => row.id === original.id)!, changed = live.desired_upvote !== desired;
        mark(item.id, { ...result.incident, id: item.id, user_id: item.is_owner ? userId : null, sync_endpoint: endpoint,
          sync_state: live.sync_dirty ? 'pending' : 'synced', sync_dirty: live.sync_dirty, vote_dirty: changed,
          desired_upvote: changed ? live.desired_upvote : desired, sync_error: '' });
      }
    } catch (error) { failed++; mark(item.id, { sync_state: 'error', sync_error: error instanceof Error ? error.message : 'Нет связи с общим сервером' }); }
  }
  try {
    const remote: Incident[] = []; let cursor = '';
    for (let page = 0; page < 50; page++) {
      const result = await communityRequest<{ incidents: Incident[]; next_cursor?: string | null }>(`/incidents?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      remote.push(...result.incidents); if (!result.next_cursor || remote.length >= 10000) break; cursor = result.next_cursor;
    }
    const identified = withLocalIds(remote, userId, working).map((item) => ({ ...item, sync_state: 'synced' as const, sync_endpoint: endpoint, sync_error: '' }));
    return { incidents: reconcileCommunityState(working, identified, endpoint), failed, fetched: true };
  } catch (error) { return { incidents: working, failed: failed + 1, fetched: false, error: error instanceof Error ? error.message : 'Не удалось получить отчёты группы' }; }
}
export function communitySyncChanged(before: Incident[], after: Incident[]): boolean { return JSON.stringify(before) !== JSON.stringify(after); }
export function reconcileCommunitySync(snapshot: Incident[], live: Incident[], synced: Incident[]): Incident[] {
  const endpoint = communityEndpoint(), syncedById = new Map(synced.map((item) => [item.id, item]));
  const base = snapshot.map((old) => {
    const current = live.find((item) => item.id === old.id), remote = syncedById.get(old.id);
    if (!current) return old.pending_delete && remote ? old : null;
    if (!remote) return old.pending_delete ? null : current;
    if (communitySyncChanged([old], [current])) return { ...current, sync_dirty: true, sync_state: 'pending' as const, sync_endpoint: endpoint };
    return reconcileCommunityState([current], [remote], endpoint)[0] || current;
  }).filter((item): item is Incident => Boolean(item));
  for (const item of live) if (!snapshot.some((old) => old.id === item.id)) base.push(item);
  for (const item of synced) if (!snapshot.some((old) => old.id === item.id) && !live.some((row) => row.id === item.id)) base.push(item);
  return base.sort((a,b) => b.created_at.localeCompare(a.created_at));
}
