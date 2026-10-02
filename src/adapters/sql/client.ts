// The only thing a database adapter must provide. Repos use `?` placeholders and portable SQL
// (works on SQLite/D1 and Postgres): no SQLite date functions, no COLLATE NOCASE, no GLOB,
// explicit GROUP BY columns, RETURNING / ON CONFLICT (supported by both).
// A Postgres client would rewrite `?` to `$n`, wrap batch() in BEGIN/COMMIT, and map
// unique-violation errors (code 23505) in isUniqueViolation().

export interface Stmt { sql: string; params: unknown[] }

export interface SqlClient {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Runs all statements atomically (one transaction). */
  batch(stmts: Stmt[]): Promise<{ rows: unknown[]; changes: number }[]>;
  isUniqueViolation(err: unknown): boolean;
}

export const stmt = (sql: string, ...params: unknown[]): Stmt => ({ sql, params });
