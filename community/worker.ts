import { handleCommunityRequest } from './handler.ts';
import type { CommunityStore, SqlStatement, SqlValue } from './store.ts';

export interface Env { DB: D1Database }
function d1Store(db: D1Database): CommunityStore {
  return {
    async first<T>(sql: string, params: SqlValue[] = []) { return await db.prepare(sql).bind(...params).first<T>() ?? undefined; },
    async all<T>(sql: string, params: SqlValue[] = []) { return (await db.prepare(sql).bind(...params).all<T>()).results; },
    async execute(sql: string, params: SqlValue[] = []) { await db.prepare(sql).bind(...params).run(); },
    async batch(statements: SqlStatement[]) { await db.batch(statements.map((s) => db.prepare(s.sql).bind(...(s.params || [])))); },
  };
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleCommunityRequest(request, d1Store(env.DB), request.headers.get('CF-Connecting-IP') || 'unknown');
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await env.DB.prepare('DELETE FROM community_rate_limits WHERE window < ?').bind(Math.floor(Date.now() / 60_000) - 120).run();
  },
};
