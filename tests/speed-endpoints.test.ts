import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { registerSpeedEndpoints, SPEED_LIMITS } from '../server/speed.ts';
import { handleCommunityRequest } from '../community/handler.ts';
import { sqliteCommunityStore } from '../server/communityStore.ts';

test('Express отдаёт ровно столько байт, сколько просит замер скорости', async () => {
  const app = express();
  registerSpeedEndpoints(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ping = await fetch(`${base}/api/speed/ping`);
    assert.equal(ping.status, 204);
    assert.equal(ping.headers.get('access-control-allow-origin'), '*');

    const down = await fetch(`${base}/api/speed/down?bytes=1048576`);
    assert.equal(down.status, 200);
    assert.equal(down.headers.get('content-type'), 'application/octet-stream');
    assert.equal(down.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    const body = new Uint8Array(await down.arrayBuffer());
    assert.equal(body.byteLength, 1048576);
    // Поток не должен быть одним повторяющимся байтом: иначе его сожмут по пути.
    assert.ok(new Set(body.subarray(0, 4096)).size > 200, 'байты должны быть случайными');

    const capped = await fetch(`${base}/api/speed/down?bytes=999999999999`);
    assert.equal(Number(capped.headers.get('content-length')), SPEED_LIMITS.maxDownloadBytes);
    await capped.arrayBuffer();

    const payload = new Uint8Array(524288).fill(7);
    const up = await fetch(`${base}/api/speed/up`, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(up.status, 200);
    assert.deepEqual(await up.json(), { ok: true, received: 524288 });

    const options = await fetch(`${base}/api/speed/down`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
  } finally { server.close(); }
});

test('свой сервер ограничивает частоту замеров и объясняет причину', async () => {
  const app = express();
  registerSpeedEndpoints(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Окно минутное: если тест попал на его границу, счётчик обнулится — идём до отказа.
    let limited: Response | null = null;
    for (let index = 0; index < SPEED_LIMITS.requestsPerMinute * 2 + 5; index++) {
      const response = await fetch(`${base}/api/speed/ping`);
      if (response.status === 429) { limited = response; break; }
    }
    assert.ok(limited, 'лимит частоты обязан сработать');
    assert.equal(limited!.headers.get('retry-after'), '60');
    assert.match((await limited!.json() as any).error, /Слишком много запросов/);
  } finally { server.close(); }
});

test('Worker/D1 отдаёт те же точки замера, что и Express', async () => {
  const db = new Database(':memory:');
  const store = sqliteCommunityStore(db);
  const call = (path: string, method = 'GET', body?: Uint8Array) => handleCommunityRequest(
    new Request(`http://local${path}`, { method, body, headers: body ? { 'Content-Type': 'application/octet-stream' } : undefined }),
    store, '203.0.113.5');
  try {
    const ping = await call('/api/speed/ping');
    assert.equal(ping.status, 204);
    assert.equal(ping.headers.get('access-control-allow-origin'), '*');
    // Точки замера публичные: ключ устройства для них не нужен.
    const down = await call('/api/speed/down?bytes=65536');
    assert.equal(down.status, 200);
    assert.equal((await down.arrayBuffer()).byteLength, 65536);
    const up = await call('/api/speed/up', 'POST', new Uint8Array(1024).fill(3));
    assert.deepEqual(await up.json(), { ok: true, received: 1024 });
    const missing = await call('/api/speed/unknown');
    assert.equal(missing.status, 404);
  } finally { db.close(); }
});
