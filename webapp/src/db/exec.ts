import type { Database, BindParams } from 'sql.js';

// sql.js returns rows as arrays of arrays. These helpers wrap the verbose
// prepare/bind/step/free dance into a more ergonomic API for callers.

export function run(db: Database, sql: string, params: BindParams = []): void {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    while (stmt.step()) {
      // no-op; run() is for side-effect statements (INSERT/UPDATE/DELETE).
    }
  } finally {
    stmt.free();
  }
}

export function all<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: BindParams = [],
): T[] {
  const stmt = db.prepare(sql);
  const rows: T[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
  } finally {
    stmt.free();
  }
  return rows;
}

export function get<T = Record<string, unknown>>(
  db: Database,
  sql: string,
  params: BindParams = [],
): T | null {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) return stmt.getAsObject() as T;
    return null;
  } finally {
    stmt.free();
  }
}

export function scalar<T = unknown>(
  db: Database,
  sql: string,
  params: BindParams = [],
): T | null {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.get();
      return (row[0] ?? null) as T;
    }
    return null;
  } finally {
    stmt.free();
  }
}

export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
