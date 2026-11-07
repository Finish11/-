import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpeedRunPayload } from '../src/lib/speedPayload.ts';
import { queuePendingSpeedRun, readPendingSpeedRuns, SPEED_PENDING_LIMIT } from '../src/lib/speedPending.ts';

const valid = { download_mbps: 95.4, upload_mbps: 20.1, ping_ms: 18, jitter_ms: 3, loaded_ping_ms: 64,
  download_bytes: 1024, upload_bytes: 512, route: 'vpn', network_kind: 'wifi', profile_id: 7, profile_name: 'NL-AMS' };

test('замер проходит проверку и сохраняет задержку под нагрузкой', () => {
  const parsed = normalizeSpeedRunPayload(valid);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.run.download_mbps, 95.4);
  assert.equal(parsed.run.loaded_ping_ms, 64);
  assert.equal(parsed.run.route, 'vpn');
  assert.equal(parsed.run.profile_id, 7);
  assert.equal(parsed.run.reliable, true);
});

test('мусор в числах не попадает в историю', () => {
  for (const value of [Number.NaN, Infinity, -1, 'abc', 1e9]) {
    const parsed = normalizeSpeedRunPayload({ ...valid, download_mbps: value });
    assert.equal(parsed.ok, false, `значение ${value} должно быть отклонено`);
  }
  const parsed = normalizeSpeedRunPayload({ ...valid, ping_ms: 'много', jitter_ms: -5, loaded_ping_ms: 999999 });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.run.ping_ms, null, 'нечитаемая задержка отбрасывается, а не выдумывается');
  assert.equal(parsed.run.jitter_ms, null);
  assert.equal(parsed.run.loaded_ping_ms, null);
});

test('тип сети и маршрут приводятся к известным значениям', () => {
  const parsed = normalizeSpeedRunPayload({ ...valid, network_kind: '<script>', route: 'martian' });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.run.network_kind, 'unknown');
  assert.equal(parsed.run.route, 'unknown');
});

test('дата проверяется, строки обрезаются, узел должен быть числом', () => {
  const parsed = normalizeSpeedRunPayload({ ...valid, created_at: 'не дата', server: 'x'.repeat(500), note: 'y'.repeat(900) },
    new Date('2026-11-08T12:00:00.000Z'));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.run.created_at, '2026-11-08T12:00:00.000Z');
  assert.equal(parsed.run.server.length, 200);
  assert.equal(parsed.run.note.length, 400);
  assert.equal(normalizeSpeedRunPayload({ ...valid, profile_id: 'abc' }).ok, false);
  assert.equal(normalizeSpeedRunPayload({ ...valid, profile_id: 1.5 }).ok, false);
  const empty = normalizeSpeedRunPayload({ ...valid, profile_id: null });
  assert.ok(empty.ok);
  if (empty.ok) assert.equal(empty.run.profile_id, null);
});

test('байты не уходят в минус и не раздуваются', () => {
  const parsed = normalizeSpeedRunPayload({ ...valid, download_bytes: -50, upload_bytes: 1e15 });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.run.download_bytes, 0);
  assert.ok(parsed.run.upload_bytes <= 10 * 1024 * 1024 * 1024);
});

test('очередь на устройстве переживает мусор и не плодит дубликаты', () => {
  assert.deepEqual(readPendingSpeedRuns('сломанный json'), []);
  assert.deepEqual(readPendingSpeedRuns('{"not":"array"}'), []);
  assert.deepEqual(readPendingSpeedRuns(JSON.stringify([{ created_at: 'x' }, 42, null])), []);
  const parsed = normalizeSpeedRunPayload(valid, new Date('2026-11-08T10:00:00.000Z'));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  let raw = JSON.stringify(queuePendingSpeedRun(null, parsed.run));
  raw = JSON.stringify(queuePendingSpeedRun(raw, parsed.run));
  assert.equal(readPendingSpeedRuns(raw).length, 1, 'повторная попытка не создаёт копию');
  for (let index = 0; index < SPEED_PENDING_LIMIT + 5; index++)
    raw = JSON.stringify(queuePendingSpeedRun(raw, { ...parsed.run, created_at: `2026-11-08T11:${String(index).padStart(2, '0')}:00.000Z` }));
  assert.equal(readPendingSpeedRuns(raw).length, SPEED_PENDING_LIMIT, 'очередь ограничена');
});
