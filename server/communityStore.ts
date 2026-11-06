import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { CommunityStore, SqlStatement, SqlValue } from '../community/store.ts';

export const COMMUNITY_SCHEMA = readFileSync(new URL('../community/migrations/0001_community.sql', import.meta.url), 'utf8');
export function sqliteCommunityStore(db: Database.Database): CommunityStore {
  db.exec(COMMUNITY_SCHEMA);
  // Старые общие отчёты 1.5.8 не теряются при переходе на отдельную таблицу.
  const hasLegacy = db.prepare("SELECT 1 FROM pragma_table_info('incidents') WHERE name = 'community'").get();
  if (hasLegacy) db.exec(`
    INSERT OR IGNORE INTO community_incidents
      (client_id, device_hash, region, carrier, incident_type, severity, status, title, description,
       ru_sites_ok, foreign_sites_ok, upvotes, created_at, updated_at)
    SELECT client_id, device_hash, region, carrier, incident_type, severity, status, title, description,
       ru_sites_ok, foreign_sites_ok, upvotes, created_at, COALESCE(updated_at, created_at)
    FROM incidents WHERE community = 1 AND client_id IS NOT NULL AND device_hash IS NOT NULL;
    INSERT OR IGNORE INTO community_votes (incident_id, device_hash)
    SELECT n.id, u.device_hash FROM community_upvotes u
    JOIN incidents old ON old.id = u.incident_id AND old.community = 1
    JOIN community_incidents n ON n.client_id = old.client_id;
  `);
  return {
    async first<T>(sql: string, params: SqlValue[] = []) { return db.prepare(sql).get(...params) as T | undefined; },
    async all<T>(sql: string, params: SqlValue[] = []) { return db.prepare(sql).all(...params) as T[]; },
    async execute(sql: string, params: SqlValue[] = []) { db.prepare(sql).run(...params); },
    async batch(statements: SqlStatement[]) {
      db.transaction(() => { for (const statement of statements) db.prepare(statement.sql).run(...(statement.params || [])); })();
    },
  };
}
