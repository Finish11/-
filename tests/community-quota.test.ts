import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { COMMUNITY_LIMITS, handleCommunityRequest, rateLimitCleanup } from '../community/handler.ts';
import { sqliteCommunityStore } from '../server/communityStore.ts';

const DAY = 86_400_000, MINUTE = 60_000;
const headers = { 'X-Device-Id': '00000000-0000-4000-8000-000000000009', 'X-Device-Secret': 'c'.repeat(64), 'Content-Type': 'application/json' };

test('суточная квота ограничивает создание, но не ломает идемпотентные повторы', async () => {
  const db = new Database(':memory:'); const store = sqliteCommunityStore(db);
  const start = Date.parse('2026-11-06T00:00:00.000Z');
  const call = (path: string, method: string, body: unknown, now: number, ip = '203.0.113.7') =>
    handleCommunityRequest(new Request(`http://local/api/community${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), store, ip, now);
  const payload = (n: number) => ({ client_id: `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    region: 'Москва и МО', carrier: 'МТС', incident_type: 'whitelist', severity: 'high', title: `Сбой ${n}`,
    description: '', ru_sites_ok: true, foreign_sites_ok: false, user_upvoted: true, created_at: new Date(start).toISOString() });

  // Раскладываем создания по разным минутам, чтобы минутный лимит не мешал проверке суточного.
  for (let i = 0; i < COMMUNITY_LIMITS.createsPerDevicePerDay; i++)
    assert.equal((await call('/incidents', 'POST', payload(i), start + i * MINUTE)).status, 201);
  const overNow = start + COMMUNITY_LIMITS.createsPerDevicePerDay * MINUTE;
  const over = await call('/incidents', 'POST', payload(999), overNow);
  assert.equal(over.status, 429);
  assert.match((await over.json() as any).error, /Суточный лимит/);
  assert.equal(over.headers.get('Retry-After'), '3600');
  // Повтор уже принятого отчёта бесплатен: клиент не должен терять доставку из-за квоты.
  assert.equal((await call('/incidents', 'POST', payload(0), overNow)).status, 200);
  assert.equal((await call(`/incidents/${payload(0).client_id}/vote`, 'PUT', { voted: false }, overNow)).status, 200);
  // На следующие сутки создание снова разрешено.
  assert.equal((await call('/incidents', 'POST', payload(1001), start + DAY + MINUTE)).status, 201);
  db.close();
});

test('суточная квота IP действует поверх разных устройств', async () => {
  const db = new Database(':memory:'); const store = sqliteCommunityStore(db);
  const start = Date.parse('2026-11-06T00:00:00.000Z');
  const asDevice = (n: number, at: number) => handleCommunityRequest(new Request('http://local/api/community/incidents', {
    method: 'POST', headers: { ...headers, 'X-Device-Id': `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, 'X-Device-Secret': String(n).padStart(64, '0') },
    body: JSON.stringify({ client_id: `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`, region: 'Москва и МО', carrier: 'МТС',
      incident_type: 'whitelist', severity: 'high', title: `Сбой ${n}`, description: '', ru_sites_ok: true, foreign_sites_ok: false,
      user_upvoted: true, created_at: new Date(at).toISOString() }),
  }), store, '198.51.100.4', at);
  for (let i = 0; i < COMMUNITY_LIMITS.createsPerIpPerDay; i++) {
    const response = await asDevice(i, start + i * MINUTE);
    assert.equal(response.status, 201, `устройство ${i}: ${await response.clone().text()}`);
  }
  assert.equal((await asDevice(500, start + COMMUNITY_LIMITS.createsPerIpPerDay * MINUTE)).status, 429,
    'новая пара ключей с того же адреса не должна обнулять суточную квоту');
  // Другой адрес не наказан за чужой трафик.
  assert.equal((await handleCommunityRequest(new Request('http://local/api/community/incidents', { method: 'POST',
    headers: { ...headers, 'X-Device-Id': '00000000-0000-4000-8000-000000000777', 'X-Device-Secret': 'd'.repeat(64) },
    body: JSON.stringify({ client_id: '70000000-0000-4000-8000-000000000777', region: 'Москва и МО', carrier: 'МТС', incident_type: 'whitelist',
      severity: 'high', title: 'Другой адрес', description: '', ru_sites_ok: true, foreign_sites_ok: false, user_upvoted: true,
      created_at: new Date(start + COMMUNITY_LIMITS.createsPerIpPerDay * MINUTE).toISOString() }),
  }), store, '198.51.100.5', start + COMMUNITY_LIMITS.createsPerIpPerDay * MINUTE)).status, 201);
  db.close();
});

test('очистка лимитов стирает минутные окна, но сохраняет суточные счётчики', async () => {
  const db = new Database(':memory:'); const store = sqliteCommunityStore(db);
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  db.prepare('CREATE TABLE IF NOT EXISTS community_rate_limits (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, window))').run();
  const insert = db.prepare('INSERT OR REPLACE INTO community_rate_limits (key, window, count) VALUES (?,?,?)');
  insert.run('device:hash:write', Math.floor(now / MINUTE) - 500, 30);   // давно прошедшая минута
  insert.run('device:hash:write', Math.floor(now / MINUTE), 3);          // текущая минута
  insert.run('day:device:hash', Math.floor(now / DAY), 30);              // сегодняшняя квота
  insert.run('day:ip:hash', Math.floor(now / DAY) - 10, 100);            // позапрошлые сутки
  const cleanup = rateLimitCleanup(now);
  await store.execute(cleanup.sql, cleanup.params);
  const left = (db.prepare('SELECT key FROM community_rate_limits ORDER BY key').all() as Array<{ key: string }>).map((row) => row.key);
  assert.deepEqual(left, ['day:device:hash', 'device:hash:write'], 'суточный счётчик нельзя стирать минутным порогом');
  assert.equal((db.prepare('SELECT count n FROM community_rate_limits WHERE key = ?').get('day:device:hash') as any).n, 30);
  db.close();
});

test('X-Forwarded-For по умолчанию учитывается только от локального прокси', async () => {
  const { resolveTrustProxy } = await import('../server/proxyTrust.ts');
  assert.equal(resolveTrustProxy(undefined), 'loopback', 'иначе любой клиент подделает IP и обойдёт лимит');
  assert.equal(resolveTrustProxy('  '), 'loopback');
  assert.equal(resolveTrustProxy('2'), 2);
  assert.equal(resolveTrustProxy('false'), false);
  assert.equal(resolveTrustProxy('true'), true, 'небезопасный режим остаётся явным выбором владельца');
  assert.equal(resolveTrustProxy('10.0.0.0/8, 192.168.1.10'), '10.0.0.0/8, 192.168.1.10');
});
