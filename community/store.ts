/** Минимальный SQL-адаптер: один и тот же handler работает с SQLite и D1. */
export type SqlValue = string | number | null;
export interface SqlStatement { sql: string; params?: SqlValue[] }
export interface CommunityStore {
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  execute(sql: string, params?: SqlValue[]): Promise<void>;
  /** Атомарная пачка: D1 batch / SQLite transaction. */
  batch(statements: SqlStatement[]): Promise<void>;
}
