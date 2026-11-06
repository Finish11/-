import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Cloudflare Worker + D1: health, cursor, idempotency, votes, ownership, tombstones', async () => {
  const bundled = await build({ entryPoints: ['community/worker.ts'], bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'neutral' });
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'community-test' },
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const statement of readFileSync('community/migrations/0001_community.sql', 'utf8').split(';').map((s) => s.trim()).filter(Boolean))
      await db.prepare(statement).run();
    const dispatch = await mf.dispatchFetch.bind(mf);
    const device = (n: number) => ({ 'X-Device-Id': `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, 'X-Device-Secret': String(n).padStart(64, '0') });
    const call = async (path: string, method = 'GET', body?: unknown, n = 1) => {
      const response = await dispatch(`https://community.test/api/community${path}`, { method, headers: { ...(n === 0 ? {} : device(n)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    assert.deepEqual((await call('/health')).data, { ok: true, service: 'pulsenet-community', version: 1 });
    assert.equal((await call('/incidents', 'GET', undefined, 0)).status, 401);
    const payload = { client_id: '10000000-0000-4000-8000-000000000001', region: 'Москва и МО', carrier: 'МТС', incident_type: 'whitelist', severity: 'high', title: 'Белые списки', description: 'Только ВК', ru_sites_ok: true, foreign_sites_ok: false, user_upvoted: true };
    const created = await call('/incidents', 'POST', payload);
    assert.equal(created.status, 201); assert.equal(created.data.incident.upvotes, 1); assert.equal(created.data.incident.is_owner, true);
    const replay = await call('/incidents', 'POST', payload);
    assert.equal(replay.status, 200); assert.equal(replay.data.incident.id, created.data.incident.id);
    assert.equal((await call('/incidents', 'POST', payload, 2)).status, 409);
    const id = payload.client_id;
    assert.equal((await call(`/incidents/${id}`, 'PATCH', { title: 'Изменено' }, 2)).status, 403);
    assert.equal((await call(`/incidents/${id}`, 'PATCH', { title: 'Изменено', status: 'resolved' })).data.incident.title, 'Изменено');
    assert.equal((await call(`/incidents/${id}/vote`, 'PUT', { voted: true }, 2)).data.incident.upvotes, 2);
    assert.equal((await call(`/incidents/${id}/vote`, 'PUT', { voted: true }, 2)).data.incident.upvotes, 2);
    assert.equal((await call(`/incidents/${id}/vote`, 'PUT', { voted: false }, 2)).data.incident.upvotes, 1);
    const second = await call('/incidents', 'POST', { ...payload, client_id: '10000000-0000-4000-8000-000000000002', title: 'Второй' });
    assert.equal(second.status, 201);
    const page1 = await call('/incidents?limit=1'); assert.equal(page1.data.incidents.length, 1); assert.ok(page1.data.next_cursor);
    const page2 = await call(`/incidents?limit=1&cursor=${encodeURIComponent(page1.data.next_cursor)}`);
    assert.equal(page2.data.incidents.length, 1); assert.notEqual(page2.data.incidents[0].id, page1.data.incidents[0].id);
    assert.equal((await call(`/incidents/${id}`, 'DELETE', undefined, 2)).status, 403);
    assert.equal((await call(`/incidents/${id}`, 'DELETE')).status, 200);
    assert.equal((await call(`/incidents/${id}`, 'DELETE')).status, 200);
    assert.equal((await call('/incidents', 'POST', payload)).status, 410);
    assert.equal((await call('/incidents')).data.incidents.length, 1);
  } finally { await mf.dispose(); }
});
