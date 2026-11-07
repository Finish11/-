import {
  COMMUNITY_SERVICE, COMMUNITY_VERSION, ContractError, decodeCursor, deviceIdentity, encodeCursor,
  hashDevice, pageLimit, parseIncident, publicIncident, validClientId, type IncidentInput, type StoredIncident,
} from './contract.ts';
import type { CommunityStore, SqlValue } from './store.ts';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Device-Id,X-Device-Secret', 'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
};
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(data), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
});
const fail = (error: unknown) => error instanceof ContractError
  ? json({ error: error.message }, error.status)
  : json({ error: 'Временная ошибка сервера. Повторите позже.' }, 500);
const VALUES: (keyof IncidentInput)[] = ['client_id', 'region', 'carrier', 'incident_type', 'severity', 'status', 'title', 'description', 'ru_sites_ok', 'foreign_sites_ok', 'created_at', 'updated_at'];
const values = (input: IncidentInput): SqlValue[] => VALUES.map((key) => typeof input[key] === 'boolean' ? Number(input[key]) : input[key]);
async function readBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 32_768) throw new ContractError('Отчёт слишком большой', 413);
  const raw = await request.text();
  if (raw.length > 32_768) throw new ContractError('Отчёт слишком большой', 413);
  try { return JSON.parse(raw); } catch { throw new ContractError('Нужен корректный JSON'); }
}
export const COMMUNITY_LIMITS = {
  readPerMinute: 120, writePerMinute: 30, ipPerMinute: 300, createsPerDevicePerDay: 30, createsPerIpPerDay: 100,
};
const MINUTE = 60_000, DAY = 86_400_000;
/** Окна минут и суток живут в одной таблице, поэтому чистятся раздельно. */
export function rateLimitCleanup(now: number): { sql: string; params: number[] } {
  return { sql: "DELETE FROM community_rate_limits WHERE (key LIKE 'day:%' AND window < ?) OR (key NOT LIKE 'day:%' AND window < ?)",
    params: [Math.floor(now / DAY) - 2, Math.floor(now / MINUTE) - 120] };
}
async function limit(store: CommunityStore, key: string, max: number, now: number, span = MINUTE): Promise<boolean> {
  const window = Math.floor(now / span);
  const row = await store.first<{ count: number }>(
    `INSERT INTO community_rate_limits (key, window, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END,
       window = excluded.window RETURNING count`, [key, window]);
  if (window % 7 === 0) { const cleanup = rateLimitCleanup(now); await store.execute(cleanup.sql, cleanup.params); }
  return Number(row?.count || 1) <= max;
}
async function incidentRow(store: CommunityStore, clientId: string, hash: string): Promise<StoredIncident | undefined> {
  return store.first<StoredIncident>(`SELECT i.*, EXISTS(SELECT 1 FROM community_votes v WHERE v.incident_id = i.id AND v.device_hash = ?) AS user_upvoted
    FROM community_incidents i WHERE i.client_id = ?`, [hash, clientId]);
}
const recount = (id: number) => `UPDATE community_incidents SET upvotes = (SELECT COUNT(*) FROM community_votes WHERE incident_id = ${id}) WHERE id = ${id}`;

/** Единственная реализация API для Express/SQLite и Cloudflare Worker/D1. */
export async function handleCommunityRequest(request: Request, store: CommunityStore, clientIp = 'local', now = Date.now()): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/api/community/health' && request.method === 'GET')
      return json({ ok: true, service: COMMUNITY_SERVICE, version: COMMUNITY_VERSION });
    // Точки замера скорости живут рядом с общим API: свой сервер снимает
    // зависимость от публичных лимитов speed.cloudflare.com.
    if (path === '/api/speed/ping' || path === '/api/speed/down' || path === '/api/speed/up')
      return speedEndpoint(request, url, path, store, clientIp, now);
    if (!path.startsWith('/api/community/')) return json({ error: 'Неизвестный метод API' }, 404);
    const identity = deviceIdentity(request.headers.get('x-device-id'), request.headers.get('x-device-secret'));
    const hash = await hashDevice(identity.deviceId, identity.secret);
    const write = request.method !== 'GET';
    const ipHash = await hashDevice('ip', clientIp.slice(0, 128));
    if (!await limit(store, `device:${hash}:${write ? 'write' : 'read'}`, write ? COMMUNITY_LIMITS.writePerMinute : COMMUNITY_LIMITS.readPerMinute, now)
      || !await limit(store, `ip:${ipHash}`, COMMUNITY_LIMITS.ipPerMinute, now))
      return json({ error: 'Слишком много запросов. Повторите через минуту.' }, 429, { 'Retry-After': '60' });

    if (path === '/api/community/incidents' && request.method === 'GET') {
      const limitValue = pageLimit(url.searchParams.get('limit')), cursor = decodeCursor(url.searchParams.get('cursor'));
      const params: SqlValue[] = [hash]; let where = '';
      if (cursor) { where = 'WHERE i.created_at < ? OR (i.created_at = ? AND i.id < ?)'; params.push(cursor.at, cursor.at, cursor.id); }
      params.push(limitValue + 1);
      const rows = await store.all<StoredIncident>(`SELECT i.*, EXISTS(SELECT 1 FROM community_votes v WHERE v.incident_id = i.id AND v.device_hash = ?) AS user_upvoted
        FROM community_incidents i ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT ?`, params);
      const page = rows.slice(0, limitValue);
      return json({ incidents: page.map((row) => publicIncident(row, hash)), next_cursor: rows.length > limitValue ? encodeCursor(page[page.length - 1]) : null });
    }
    if (path === '/api/community/incidents' && request.method === 'POST') {
      const input = parseIncident(await readBody(request));
      const tombstone = await store.first<{ device_hash: string }>('SELECT device_hash FROM community_tombstones WHERE client_id = ?', [input.client_id]);
      if (tombstone) return json({ error: 'Отчёт уже удалён; повторное создание запрещено' }, 410);
      const existing = await incidentRow(store, input.client_id, hash);
      if (existing) return existing.device_hash === hash ? json({ incident: publicIncident(existing, hash) }) : json({ error: 'ID отчёта занят другим устройством' }, 409);
      // Квота расходуется только на реальное создание: повторы идемпотентного POST бесплатны.
      if (!await limit(store, `day:device:${hash}`, COMMUNITY_LIMITS.createsPerDevicePerDay, now, DAY)
        || !await limit(store, `day:ip:${ipHash}`, COMMUNITY_LIMITS.createsPerIpPerDay, now, DAY))
        return json({ error: 'Суточный лимит новых отчётов исчерпан. Повторите завтра.' }, 429, { 'Retry-After': '3600' });
      if (Date.parse(input.created_at) > now + 300_000) input.created_at = new Date(now).toISOString();
      input.updated_at = input.created_at;
      const inserted = await store.first<{ id: number }>(`INSERT INTO community_incidents
        (client_id, device_hash, region, carrier, incident_type, severity, status, title, description, ru_sites_ok, foreign_sites_ok, created_at, updated_at, upvotes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(client_id) DO NOTHING RETURNING id`, [input.client_id, hash, ...values(input).slice(1)]);
      if (!inserted) {
        const raced = await incidentRow(store, input.client_id, hash);
        return raced?.device_hash === hash ? json({ incident: publicIncident(raced, hash) }) : json({ error: 'ID отчёта занят другим устройством' }, 409);
      }
      const id = Number(inserted.id);
      if (input.user_upvoted) await store.batch([
        { sql: 'INSERT OR IGNORE INTO community_votes (incident_id, device_hash) VALUES (?,?)', params: [id, hash] },
        { sql: recount(id) },
      ]);
      return json({ incident: publicIncident((await incidentRow(store, input.client_id, hash))!, hash) }, 201);
    }
    const match = path.match(/^\/api\/community\/incidents\/([^/]+)(?:\/(vote|upvote))?$/);
    if (!match) return json({ error: 'Неизвестный метод API' }, 404);
    const clientId = validClientId(decodeURIComponent(match[1])), action = match[2];
    const existing = await incidentRow(store, clientId, hash);
    if (!action && request.method === 'DELETE') {
      if (existing && existing.device_hash !== hash) return json({ error: 'Отчёт принадлежит другому устройству' }, 403);
      if (existing) await store.batch([
        { sql: 'INSERT OR IGNORE INTO community_tombstones (client_id, device_hash, deleted_at) VALUES (?,?,?)', params: [clientId, hash, new Date(now).toISOString()] },
        { sql: 'DELETE FROM community_votes WHERE incident_id = ?', params: [existing.id] },
        { sql: 'DELETE FROM community_incidents WHERE id = ?', params: [existing.id] },
      ]);
      return json({ ok: true });
    }
    if (!existing) return json({ error: 'Отчёт не найден' }, 404);
    if (!action && request.method === 'PATCH') {
      if (existing.device_hash !== hash) return json({ error: 'Отчёт принадлежит другому устройству' }, 403);
      const parsed = parseIncident(await readBody(request), { ...existing, user_upvoted: Boolean(existing.user_upvoted) });
      parsed.created_at = existing.created_at;
      parsed.updated_at = new Date(Math.max(Date.parse(existing.updated_at), Date.parse(parsed.updated_at))).toISOString();
      const assignments = VALUES.filter((key) => key !== 'client_id').map((key) => `${key} = ?`).join(', ');
      const params = VALUES.filter((key) => key !== 'client_id').map((key) => typeof parsed[key] === 'boolean' ? Number(parsed[key]) : parsed[key]) as SqlValue[];
      await store.execute(`UPDATE community_incidents SET ${assignments} WHERE id = ?`, [...params, existing.id]);
      return json({ incident: publicIncident((await incidentRow(store, clientId, hash))!, hash) });
    }
    if ((action === 'vote' && request.method === 'PUT') || (action === 'upvote' && request.method === 'POST')) {
      const body = await readBody(request) as { voted?: unknown };
      let voted: boolean;
      if (action === 'vote') {
        if (typeof body?.voted !== 'boolean') throw new ContractError('Нужно поле voted: true или false');
        voted = body.voted;
      } else voted = !Boolean(existing.user_upvoted); // совместимость со старыми APK
      await store.batch([
        voted ? { sql: 'INSERT OR IGNORE INTO community_votes (incident_id, device_hash) VALUES (?,?)', params: [existing.id, hash] }
          : { sql: 'DELETE FROM community_votes WHERE incident_id = ? AND device_hash = ?', params: [existing.id, hash] },
        { sql: recount(existing.id) },
      ]);
      return json({ incident: publicIncident((await incidentRow(store, clientId, hash))!, hash) });
    }
    return json({ error: 'Неизвестный метод API' }, 405);
  } catch (error) { return fail(error); }
}

const SPEED_BLOCK = 65536;
const SPEED_MAX_DOWNLOAD = 32 * 1024 * 1024;
const SPEED_MAX_UPLOAD = 8 * 1024 * 1024;

/** Несжимаемые случайные байты: иначе замер покажет скорость компрессии. */
async function speedEndpoint(request: Request, url: URL, path: string, store: CommunityStore, clientIp: string, now: number): Promise<Response> {
  const ipHash = await hashDevice('ip', clientIp.slice(0, 128));
  if (!await limit(store, `speed:${ipHash}`, 400, now))
    return json({ error: 'Слишком много запросов замера. Повторите через минуту.' }, 429, { 'Retry-After': '60' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (path === '/api/speed/ping') return new Response(null, { status: 204, headers: { ...CORS, 'Cache-Control': 'no-store' } });
  if (path === '/api/speed/up' && request.method === 'POST') {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > SPEED_MAX_UPLOAD) return json({ error: 'Слишком большое тело замера' }, 413);
    const body = await request.arrayBuffer();
    if (body.byteLength > SPEED_MAX_UPLOAD) return json({ error: 'Слишком большое тело замера' }, 413);
    return json({ ok: true, received: body.byteLength });
  }
  if (path === '/api/speed/down' && request.method === 'GET') {
    const requested = Number(url.searchParams.get('bytes') || 1048576);
    const total = Math.max(0, Math.min(SPEED_MAX_DOWNLOAD, Number.isFinite(requested) ? Math.floor(requested) : 1048576));
    const block = new Uint8Array(Math.min(SPEED_BLOCK, Math.max(1, total)));
    crypto.getRandomValues(block);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) { controller.close(); return; }
        const size = Math.min(block.length, total - sent);
        sent += size;
        controller.enqueue(size === block.length ? block : block.slice(0, size));
      },
    });
    return new Response(stream, { headers: { ...CORS, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(total), 'Cache-Control': 'no-store', 'Content-Encoding': 'identity' } });
  }
  return json({ error: 'Неизвестный метод замера' }, 404);
}
