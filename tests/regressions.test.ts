import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { handleCommunityRequest } from '../community/handler.ts';
import { sqliteCommunityStore } from '../server/communityStore.ts';
import { probeSiteResilient, type ProbeOptions } from '../src/lib/siteProbe.ts';
import { mergeSiteMeasurement, siteResultIsStale, siteStatusLabel } from '../src/lib/siteMeasurement.ts';
import { confirmationRouteStillValid } from '../src/lib/appConfirmations.ts';
import { medianSamples, nodeLatencyLabel, tcpLatencyIsComparable } from '../src/lib/nodePing.ts';
import { queueIncidentDelete, queueIncidentEdit, queueIncidentVote, pendingCommunityCount, reconcileCommunitySync } from '../src/lib/community.ts';
import type { Incident, Site } from '../src/types.ts';

const site = (id: number): Site => ({ id, user_id: 1, name: 'Example', domain: 'example.com', probe_url: 'https://example.com/favicon.ico',
  category: 'global_infra', marker_role: 'global_neutral', enabled: 1, last_status: 'unknown', last_latency_ms: null,
  last_checked_at: null, description: '', created_at: '' });
const okHttp = (url: string) => Promise.resolve({ ok: true, status: 200, url, data_base64: btoa('<html><title>Example</title><body>Hello example.com</body></html>'), content_type: 'text/html', latency_ms: 40 });

test('HTTP: favicon fallback использует главную страницу и не повторяет TLS-ошибку', async () => {
  const calls: string[] = [];
  const nativeHttp: NonNullable<ProbeOptions['nativeHttp']> = async (url) => { calls.push(url); return url.endsWith('/favicon.ico') ? { ok: false, error: 'connection timeout' } : okHttp(url); };
  const result = await probeSiteResilient('https://example.com/favicon.ico', { nativeHttp });
  assert.equal(result.verdict, 'ok'); assert.equal(result.probeUrl, 'https://example.com/'); assert.deepEqual(calls, ['https://example.com/favicon.ico', 'https://example.com/']);
  const tlsCalls: string[] = [];
  const tls = await probeSiteResilient('https://example.com/', { nativeHttp: async (url) => { tlsCalls.push(url); return { ok: false, error: 'TLS certificate error' }; } });
  assert.equal(tls.verdict, 'blocked'); assert.equal(tls.attempts, 1); assert.equal(tlsCalls.length, 1);
});
test('HTTP: поздний ответ сканирования не перетирает свежую ручную пробу', () => {
  const fresh = { ...site(1), last_checked_at: '2026-11-06T12:00:00Z', last_status: 'ok' as const, last_proof: 'page' as const };
  const late = mergeSiteMeasurement(fresh, { site_id: 1, name: 'Example', domain: 'example.com', category: 'global_infra', marker_role: 'global_neutral', status: 'blocked', latency_ms: null, checked_at: '2026-11-06T11:59:00Z' });
  assert.equal(late.last_status, 'ok');
  assert.equal(siteResultIsStale(fresh, Date.parse('2026-11-06T12:11:00Z')), true);
  assert.match(siteStatusLabel({ last_status: 'ok', last_proof: 'endpoint', last_http_status: 403 }), /HTTP 403/);
});
test('маршрут приложения: смена VPN-клиента, узла, сети или IP инвалидирует подтверждение', () => {
  const before = { networkKey: 'wifi:1', exitIp: '1.1.1.1', nodeKey: 'vpn:1', vpnPackage: 'com.vpn' };
  assert.equal(confirmationRouteStillValid(before, { ...before }), true);
  for (const patch of [{ networkKey: 'wifi:2' }, { exitIp: '2.2.2.2' }, { nodeKey: 'vpn:2' }, { vpnPackage: 'com.other' }, { exitIp: '' }])
    assert.equal(confirmationRouteStillValid(before, { ...before, ...patch }), false);
});
test('TCP: медиана устойчива к выбросу, VPN и субмиллисекундный ответ не ранжируются', () => {
  assert.equal(medianSamples([120, 40, 900]), 120);
  assert.equal(tcpLatencyIsComparable({ latency_ms: 40, latency_kind: 'tcp_connect', latency_route: 'direct', latency_trusted: true }), true);
  assert.equal(tcpLatencyIsComparable({ latency_ms: 0.4, latency_kind: 'tcp_connect', latency_route: 'vpn', latency_trusted: true }), false);
  assert.match(nodeLatencyLabel({ latency_ms: 0.4, latency_kind: 'tcp_connect', latency_route: 'vpn', latency_trusted: false }), /не RTT/);
});
const incident = (id: number): Incident => ({ id, user_id: 1, author_name: 'Я', region: 'Москва и МО', carrier: 'МТС', incident_type: 'whitelist',
  severity: 'high', status: 'active', title: 'Сбой', description: '', upvotes: 1, ru_sites_ok: true, foreign_sites_ok: false,
  user_upvoted: true, is_owner: true, created_at: '2026-11-06T10:00:00Z', client_id: `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`, sync_state: 'synced' });
test('очередь: правка, голос и удаление сохраняются локально до доставки', () => {
  const base = incident(1);
  const edited = queueIncidentEdit(base, { title: 'Новый' }, 'https://api.example', '2026-11-06T11:00:00Z');
  const voted = queueIncidentVote(edited, 'https://api.example');
  const deleted = queueIncidentDelete(voted, 'https://api.example', '2026-11-06T12:00:00Z');
  assert.equal(edited.sync_dirty, true); assert.equal(voted.vote_dirty, true); assert.equal(voted.user_upvoted, false);
  assert.equal(deleted.pending_delete, true); assert.equal(pendingCommunityCount([deleted]), 1);
});
test('очередь: доставленный tombstone исчезает, неудалённый остаётся, чужой голос учитывается', () => {
  const base = incident(1), deleted = queueIncidentDelete(base, 'https://api.example');
  assert.equal(reconcileCommunitySync([deleted], [deleted], []).length, 0);
  assert.equal(reconcileCommunitySync([deleted], [deleted], [{ ...deleted, sync_state: 'synced' }]).length, 1);
  const foreign = { ...incident(2), is_owner: false, user_id: null, sync_state: 'synced' as const };
  assert.equal(pendingCommunityCount([queueIncidentVote(foreign, 'https://api.example')]), 1);
});
test('Express/SQLite использует тот же контракт: идемпотентность, голоса, tombstone и лимиты', async () => {
  const db = new Database(':memory:'); const store = sqliteCommunityStore(db);
  const headers = { 'X-Device-Id': '00000000-0000-4000-8000-000000000001', 'X-Device-Secret': 'a'.repeat(64), 'Content-Type': 'application/json' };
  const call = (path: string, method = 'GET', body?: unknown) => handleCommunityRequest(new Request(`http://local/api/community${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), store);
  const payload = { client_id: '30000000-0000-4000-8000-000000000001', region: 'Москва и МО', carrier: 'МТС', incident_type: 'whitelist', severity: 'high', title: 'Сбой', description: '', ru_sites_ok: true, foreign_sites_ok: false, user_upvoted: true };
  assert.equal((await call('/incidents', 'POST', payload)).status, 201);
  assert.equal((await call('/incidents', 'POST', payload)).status, 200);
  assert.equal((await (await call(`/incidents/${payload.client_id}/vote`, 'PUT', { voted: true })).json() as any).incident.upvotes, 1);
  assert.equal((await call(`/incidents/${payload.client_id}`, 'DELETE')).status, 200);
  assert.equal((await call('/incidents', 'POST', payload)).status, 410);
  for (let i = 0; i < 121; i++) await call('/incidents');
  assert.equal((await call('/incidents')).status, 429);
  db.close();
});
test('Express/SQLite: старые общие отчёты мигрируют, личная лента их не показывает', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE incidents (id INTEGER PRIMARY KEY, user_id INTEGER, author_name TEXT, region TEXT, carrier TEXT, incident_type TEXT, severity TEXT, status TEXT, title TEXT, description TEXT, upvotes INTEGER, ru_sites_ok INTEGER, foreign_sites_ok INTEGER, created_at TEXT, updated_at TEXT, client_id TEXT, device_hash TEXT, community INTEGER);
    CREATE TABLE community_upvotes (incident_id INTEGER, device_hash TEXT);`);
  db.prepare(`INSERT INTO incidents VALUES (1,NULL,'Участник','Москва и МО','МТС','whitelist','high','active','Общий','',1,1,0,'2026-11-06T10:00:00Z',NULL,'inc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','hash',1)`).run();
  db.prepare(`INSERT INTO incidents VALUES (2,1,'Я','Москва и МО','МТС','whitelist','high','active','Личный','',1,1,0,'2026-11-06T10:00:00Z',NULL,NULL,NULL,0)`).run();
  const store = sqliteCommunityStore(db);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM community_incidents').get() as any).n, 1);
  const legacy = db.prepare('SELECT title FROM incidents WHERE COALESCE(community,0)=0').all() as any[];
  assert.deepEqual(legacy.map((r) => r.title), ['Личный']);
  const request = new Request('http://local/api/community/incidents', { headers: { 'X-Device-Id': '00000000-0000-4000-8000-000000000001', 'X-Device-Secret': 'b'.repeat(64) } });
  const data = await (await handleCommunityRequest(request, store)).json() as any;
  assert.equal(data.incidents[0].title, 'Общий'); db.close();
});
