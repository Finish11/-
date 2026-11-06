import test from 'node:test';
import assert from 'node:assert/strict';
import type { Incident } from '../src/types.ts';

/** Минимальное браузерное окружение: durable outbox живёт в localStorage + fetch. */
function browserEnv() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  return store;
}
const report = (patch: Partial<Incident> = {}): Incident => ({
  id: 1, user_id: 1, author_name: 'Я', region: 'Москва и МО', carrier: 'МТС', incident_type: 'whitelist',
  severity: 'high', status: 'active', title: 'Исходный', description: '', upvotes: 1, ru_sites_ok: true,
  foreign_sites_ok: false, user_upvoted: true, is_owner: true, created_at: '2026-11-06T10:00:00.000Z',
  client_id: '50000000-0000-4000-8000-000000000001', sync_state: 'pending', sync_dirty: true, sync_endpoint: 'https://api.test',
  updated_at: '2026-11-06T12:00:00.000Z', ...patch,
});

test('повторный POST после потерянного ответа не теряет более свежую правку', async () => {
  browserEnv();
  const community = await import('../src/lib/community.ts');
  await community.setCommunityEndpoint('https://api.test');
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let serverRow = { ...report(), title: 'Устаревший на сервере', updated_at: '2026-11-06T10:00:00.000Z', sync_state: 'synced' };
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const path = String(url).replace('https://api.test/api/community', '');
    const method = init.method || 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    // Сервер уже принял первый POST, но ответ потерялся: он возвращает старую версию.
    if (method === 'PATCH') serverRow = { ...serverRow, ...JSON.parse(init.body), sync_state: 'synced' };
    const incident = serverRow;
    const body = method === 'GET' ? { incidents: [incident], next_cursor: null } : { incident };
    return { ok: true, status: 200, json: async () => body };
  };
  const local = report({ title: 'Свежая правка пользователя' });
  const result = await community.synchronizeCommunity([local], 1);
  const saved = result.incidents.find((item) => item.client_id === local.client_id)!;
  assert.equal(saved.title, 'Свежая правка пользователя', `правка не должна затираться старым ответом сервера; вызовы: ${JSON.stringify(calls.map((c) => c.method))}`);
  assert.ok(calls.some((call) => call.method === 'PATCH'), 'после идемпотентного POST нужна доводящая PATCH');
});

test('сбой чтения Android Preferences не перезаписывает ключ устройства пустой парой', async () => {
  const community = await import('../src/lib/community.ts');
  const stored = { deviceId: '00000000-0000-4000-8000-000000000001', deviceSecret: 'a'.repeat(64), endpoint: 'https://api.test' };
  const broken = community.mergeStoredCredentials({}, {}, true);
  assert.equal(broken.writable, false, 'без прочитанного ключа хранилище трогать нельзя');
  assert.match(broken.error, /Preferences/);
  const recovered = community.mergeStoredCredentials(stored, {}, true);
  assert.equal(recovered.writable, true);
  assert.equal(recovered.credentials.deviceSecret, stored.deviceSecret);
  // Резервная копия из localStorage спасает владение, если нативное чтение упало.
  const fallback = community.mergeStoredCredentials({}, stored, true);
  assert.equal(fallback.writable, true);
  assert.equal(fallback.credentials.deviceId, stored.deviceId);
});

test('очередь считает только отчёты текущего сервера и игнорирует демо-записи', async () => {
  const community = await import('../src/lib/community.ts');
  const items = [
    report({ id: 1 }),
    report({ id: 2, sync_endpoint: 'https://other.test' }),
    report({ id: 3, demo: true }),
    report({ id: 4, sync_state: 'synced', sync_dirty: false, user_upvoted: false }),
    report({ id: 5, sync_state: 'synced', sync_dirty: false, user_upvoted: true, vote_dirty: true }),
  ];
  assert.equal(community.pendingCommunityCount(items, 'https://api.test'), 2);
  assert.equal(community.pendingCommunityCount(items, 'https://api.test/'), 2, 'слеш в конце адреса не должен прятать очередь');
  assert.equal(community.pendingCommunityCount(items), 3);
});

test('локальный счётчик id перешагивает id отчётов из общей ленты', async () => {
  const { reserveNextLocalId } = await import('../src/demo/stateStorage.ts');
  assert.equal(reserveNextLocalId(100000, [{ id: 7 }, { id: 42 }]), 100000);
  assert.equal(reserveNextLocalId(100000, [{ id: 100000 }, { id: 250000 }]), 250001, 'иначе новый отчёт украдёт id чужого');
  assert.equal(reserveNextLocalId(250001, [{ id: 5 }]), 250001, 'счётчик не откатывается назад');
  assert.equal(reserveNextLocalId(Number.NaN, [null, undefined, { id: 'мусор' }, { id: 1.5 }]), 100000);
});

test('сравнение версий не путает 0/1 и null с настоящей правкой', async () => {
  const community = await import('../src/lib/community.ts');
  const local = report();
  assert.equal(community.incidentContentDiffers(local, { ...local, ru_sites_ok: 1 as any, description: null as any }), false);
  assert.equal(community.incidentContentDiffers(local, { ...local, title: 'Другое' }), true);
  assert.equal(community.incidentContentDiffers(local, { ...local, status: 'resolved' }), true);
  assert.equal(community.incidentContentDiffers(local, undefined), true);
});
