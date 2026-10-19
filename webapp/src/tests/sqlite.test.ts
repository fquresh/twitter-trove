// Migrations are pure SQL - no IDB, no DOM. Run this file in the node env so
// sql.js can resolve its wasm via the filesystem, the way scripts/perf.ts does.
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, migrateEmbeddingsOut, migrateToV5 } from '../db/sqlite';
import {
  INITIAL_SCHEMA,
  INITIAL_SCHEMA_V1,
  MIGRATION_V2,
  MIGRATION_V3,
  EMBEDDINGS_SCHEMA,
  SCHEMA_VERSION,
} from '../db/schema';

const __dirname = dirname(fileURLToPath(import.meta.url));

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
});

function userVersion(db: { exec: (sql: string) => Array<{ values: unknown[][] }> }): number {
  const r = db.exec('PRAGMA user_version');
  return (r[0]?.values[0]?.[0] as number) ?? 0;
}

function tableNames(db: { exec: (sql: string) => Array<{ values: unknown[][] }> }): string[] {
  const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
  return (r[0]?.values ?? []).map((row) => row[0] as string);
}

const V2_TABLES = ['tweet_embeddings', 'enrichments', 'chat_sessions', 'chat_messages'];
const V3_TABLES = ['sync_outbox', 'sync_state'];

function freshEmbDb(): Database {
  const db = new SQL.Database();
  for (const s of EMBEDDINGS_SCHEMA) db.exec(s);
  return db;
}

describe('applyMigrations - fresh DB', () => {
  // applyMigrations is the MAIN-db ladder: v1→v2→v3 statement arrays plus the
  // guarded v5 article step. The v3→v4 embeddings split is a separate cross-db
  // step (migrateEmbeddingsOut), tested below.
  it('lands a brand-new database at user_version = 5', () => {
    const db = new SQL.Database();
    applyMigrations(db);
    expect(userVersion(db)).toBe(5);
    expect(SCHEMA_VERSION).toBe(5);

    const names = new Set(tableNames(db));
    for (const t of V2_TABLES) expect(names.has(t)).toBe(true);
    for (const t of V3_TABLES) expect(names.has(t)).toBe(true);
    // v1 tables also still present.
    for (const t of ['tweets', 'categories', 'entities']) expect(names.has(t)).toBe(true);

    db.close();
  });

  it('is idempotent - re-running migrations is a no-op', () => {
    const db = new SQL.Database();
    applyMigrations(db);
    applyMigrations(db);
    applyMigrations(db);
    expect(userVersion(db)).toBe(5);
    db.close();
  });
});

describe('migrateEmbeddingsOut - embeddings split', () => {
  it('moves embeddings from the main db into embDb and drops the table', async () => {
    const db = new SQL.Database();
    applyMigrations(db); // ladder complete (v5), tweet_embeddings still in main
    db.exec(`INSERT INTO tweets (id, author_handle, content, created_at, imported_at)
             VALUES ('t1','alice','hi',1700000000,1700000000)`);
    db.exec(`INSERT INTO tweet_embeddings (tweet_id, model, dim, dtype, scale, offset, vector, created_at)
             VALUES ('t1','voyage-3-large',4,'int8',0.5,0,X'01020304',1700000000)`);

    const emb = freshEmbDb();
    const changed = await migrateEmbeddingsOut(db, emb);
    expect(changed).toBe(true);
    // table-driven guard: the split happens without downgrading the v5 ladder
    expect(userVersion(db)).toBe(5);

    // main no longer has the table; embDb has the row.
    expect(new Set(tableNames(db)).has('tweet_embeddings')).toBe(false);
    expect(emb.exec('SELECT COUNT(*) FROM tweet_embeddings')[0]?.values[0]?.[0]).toBe(1);
    // the vector blob survived the copy intact
    const v = emb.exec("SELECT vector FROM tweet_embeddings WHERE tweet_id='t1'")[0].values[0][0] as Uint8Array;
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);

    db.close();
    emb.close();
  });

  it('is a no-op once the embeddings table has left the main db', async () => {
    const db = new SQL.Database();
    applyMigrations(db);
    const emb = freshEmbDb();
    await migrateEmbeddingsOut(db, emb); // splits (table-driven)
    const changed = await migrateEmbeddingsOut(db, emb); // already split
    expect(changed).toBe(false);
    expect(userVersion(db)).toBe(5);
    db.close();
    emb.close();
  });
});

describe('applyMigrations - v1 → latest', () => {
  it('walks an old v1 snapshot up the full ladder to the latest version', () => {
    // Build a v1 fixture using only INITIAL_SCHEMA_V1 (which ends at
    // user_version = 1). This is exactly what an old IDB snapshot from before
    // the v2 deploy would deserialize as - the ladder must carry it through
    // every later delta in order.
    const db = new SQL.Database();
    db.exec('BEGIN');
    for (const stmt of INITIAL_SCHEMA_V1) db.exec(stmt);
    db.exec('COMMIT');
    expect(userVersion(db)).toBe(1);

    const before = new Set(tableNames(db));
    for (const t of [...V2_TABLES, ...V3_TABLES]) expect(before.has(t)).toBe(false);

    applyMigrations(db);

    // The main ladder carries v1 → v5 (the v3→v4 embeddings split is separate).
    expect(userVersion(db)).toBe(5);
    const after = new Set(tableNames(db));
    for (const t of [...V2_TABLES, ...V3_TABLES]) expect(after.has(t)).toBe(true);
    // v5 article columns arrived too.
    const cols = db.exec('PRAGMA table_info(tweets)')[0]?.values.map((r) => r[1]) ?? [];
    expect(cols).toContain('is_article');
    expect(cols).toContain('article_title');

    db.close();
  });

  it('preserves existing v1 row data through the upgrade', () => {
    const db = new SQL.Database();
    for (const stmt of INITIAL_SCHEMA_V1) db.exec(stmt);

    db.exec(`
      INSERT INTO tweets (id, author_handle, content, created_at, imported_at)
      VALUES ('1', 'alice', 'hello', 1700000000, 1700000000);
    `);

    applyMigrations(db);

    const got = db.exec("SELECT id, author_handle FROM tweets WHERE id='1'");
    expect(got[0]?.values).toEqual([['1', 'alice']]);

    db.close();
  });
});

describe('applyMigrations - v2 → v3', () => {
  // A v2 snapshot is v1 statements + the v2 delta, landing at user_version = 2.
  function buildV2(): Database {
    const db = new SQL.Database();
    db.exec('BEGIN');
    for (const stmt of INITIAL_SCHEMA_V1) db.exec(stmt);
    for (const stmt of MIGRATION_V2) db.exec(stmt);
    db.exec('COMMIT');
    return db;
  }

  it('upgrades a v2 snapshot by adding the sync tables and v5 article columns', () => {
    const db = buildV2();
    expect(userVersion(db)).toBe(2);
    const before = new Set(tableNames(db));
    for (const t of V3_TABLES) expect(before.has(t)).toBe(false);

    applyMigrations(db);

    expect(userVersion(db)).toBe(5);
    const after = new Set(tableNames(db));
    for (const t of V3_TABLES) expect(after.has(t)).toBe(true);
    // v2 tables untouched.
    for (const t of V2_TABLES) expect(after.has(t)).toBe(true);
    const cols = db.exec('PRAGMA table_info(tweets)')[0]?.values.map((r) => r[1]) ?? [];
    expect(cols).toContain('is_article');
    db.close();
  });

  it('preserves existing row data through the v2 → v3 upgrade', () => {
    const db = buildV2();
    db.exec(`
      INSERT INTO tweets (id, author_handle, content, created_at, imported_at, is_favorite)
      VALUES ('1', 'alice', 'hello', 1700000000, 1700000000, 1);
    `);
    applyMigrations(db);
    const got = db.exec("SELECT id, is_favorite FROM tweets WHERE id='1'");
    expect(got[0]?.values).toEqual([['1', 1]]);
    db.close();
  });
});

describe('schema export shape', () => {
  it('INITIAL_SCHEMA ends at v3; the guarded code migrations carry SCHEMA_VERSION higher', () => {
    // INITIAL_SCHEMA is the statement-array portion of the ladder (fresh DBs
    // then get the v5 article step from migrateToV5 inside applyMigrations).
    const trailing = INITIAL_SCHEMA[INITIAL_SCHEMA.length - 1];
    expect(trailing).toMatch(/PRAGMA user_version\s*=\s*3/);
    expect(SCHEMA_VERSION).toBe(5);
  });

  it('MIGRATION_V2 creates exactly the four v2 tables', () => {
    const creates = MIGRATION_V2.filter((s) => /CREATE TABLE/.test(s));
    expect(creates).toHaveLength(4);
    for (const t of V2_TABLES) {
      expect(creates.some((s) => s.includes(t))).toBe(true);
    }
  });

  it('MIGRATION_V3 creates exactly the two sync tables', () => {
    const creates = MIGRATION_V3.filter((s) => /CREATE TABLE/.test(s));
    expect(creates).toHaveLength(2);
    for (const t of V3_TABLES) {
      expect(creates.some((s) => s.includes(t))).toBe(true);
    }
  });
});

describe('migrateToV5 - article columns + FTS rebuild', () => {
  // A db at the end of the STATEMENT ladder (v3): INITIAL_SCHEMA only, so
  // tweets_fts is still the original 3-column table.
  function buildStatementLadderDb(): Database {
    const db = new SQL.Database();
    db.exec('BEGIN');
    for (const s of INITIAL_SCHEMA) db.exec(s);
    db.exec('COMMIT');
    return db;
  }

  function ftsColumns(db: Database): unknown[] {
    return db.exec('PRAGMA table_info(tweets_fts)')[0]?.values.map((r) => r[1]) ?? [];
  }

  it('adds tri-state article columns (existing rows stay NULL = unknown)', () => {
    const db = buildStatementLadderDb();
    db.exec(`INSERT INTO tweets (id, author_handle, content, created_at, imported_at)
             VALUES ('1', 'alice', 'hello', 1700000000, 1700000000)`);

    const changed = migrateToV5(db);
    expect(changed).toBe(true);
    expect(userVersion(db)).toBe(5);

    const cols = db.exec('PRAGMA table_info(tweets)')[0]?.values.map((r) => r[1]) ?? [];
    expect(cols).toContain('is_article');
    expect(cols).toContain('article_title');
    const row = db.exec('SELECT is_article, article_title FROM tweets WHERE id=\'1\'');
    expect(row[0]?.values).toEqual([[null, null]]);
    db.close();
  });

  it('rebuilds FTS with article_title and preserves the existing index', () => {
    const db = buildStatementLadderDb();
    db.exec(`INSERT INTO tweets (id, author_handle, content, created_at, imported_at)
             VALUES ('1', 'alice', 'a zenith moment', 1700000000, 1700000000)`);
    // Pre-migration: 3-column FTS already indexed the content via triggers.
    expect(ftsColumns(db)).not.toContain('article_title');
    expect(
      db.exec(`SELECT COUNT(*) FROM tweets_fts WHERE tweets_fts MATCH 'zenith'`)[0]
        ?.values[0]?.[0],
    ).toBe(1);

    migrateToV5(db);

    expect(ftsColumns(db)).toContain('article_title');
    // The rebuild re-indexed pre-existing content.
    expect(
      db.exec(`SELECT COUNT(*) FROM tweets_fts WHERE tweets_fts MATCH 'zenith'`)[0]
        ?.values[0]?.[0],
    ).toBe(1);
    db.close();
  });

  it('keeps FTS in sync for article_title via the recreated triggers', () => {
    const db = buildStatementLadderDb();
    migrateToV5(db);

    db.exec(`INSERT INTO tweets (id, author_handle, content, created_at, imported_at, is_article, article_title)
             VALUES ('1', 'alice', '', 1700000000, 1700000000, 1, 'The Zenith Playbook')`);
    // Article posts have empty content; the title is what search must find.
    expect(
      db.exec(`SELECT COUNT(*) FROM tweets_fts WHERE tweets_fts MATCH 'playbook'`)[0]
        ?.values[0]?.[0],
    ).toBe(1);

    // Update path: the au trigger re-indexes the new title.
    db.exec(`UPDATE tweets SET article_title = 'A Field Guide to Zenith' WHERE id = '1'`);
    expect(
      db.exec(`SELECT COUNT(*) FROM tweets_fts WHERE tweets_fts MATCH 'guide'`)[0]
        ?.values[0]?.[0],
    ).toBe(1);
    expect(
      db.exec(`SELECT COUNT(*) FROM tweets_fts WHERE tweets_fts MATCH 'playbook'`)[0]
        ?.values[0]?.[0],
    ).toBe(0);
    db.close();
  });

  it('is a no-op on a db already at v5', () => {
    const db = new SQL.Database();
    applyMigrations(db);
    expect(migrateToV5(db)).toBe(false);
    expect(userVersion(db)).toBe(5);
    db.close();
  });

  it('tolerates a partial prior application (crash-safety guards)', () => {
    const db = buildStatementLadderDb();
    // Simulate a crash that added only ONE of the two columns before dying.
    db.exec('ALTER TABLE tweets ADD COLUMN is_article INTEGER');
    const changed = migrateToV5(db);
    expect(changed).toBe(true);
    const cols = db.exec('PRAGMA table_info(tweets)')[0]?.values.map((r) => r[1]) ?? [];
    expect(cols).toContain('article_title');
    expect(ftsColumns(db)).toContain('article_title');
    expect(userVersion(db)).toBe(5);
    db.close();
  });
});
