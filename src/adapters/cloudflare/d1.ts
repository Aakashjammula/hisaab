import type { SqlClient, Stmt } from '../sql/client.ts';

/** SqlClient on Cloudflare D1 (SQLite). D1 batches run as a single transaction. */
export class D1Client implements SqlClient {
  constructor(private db: D1Database) {}

  private prepare(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).bind(...params);
  }

  async all<T>(sql: string, params?: unknown[]) {
    return (await this.prepare(sql, params).all<T>()).results;
  }

  async first<T>(sql: string, params?: unknown[]) {
    return (await this.prepare(sql, params).first<T>()) ?? null;
  }

  async run(sql: string, params?: unknown[]) {
    return { changes: (await this.prepare(sql, params).run()).meta.changes ?? 0 };
  }

  async batch(stmts: Stmt[]) {
    if (!stmts.length) return [];
    const res = await this.db.batch(stmts.map(s => this.prepare(s.sql, s.params)));
    return res.map(r => ({ rows: r.results ?? [], changes: r.meta?.changes ?? 0 }));
  }

  isUniqueViolation(err: unknown) {
    return /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));
  }
}
