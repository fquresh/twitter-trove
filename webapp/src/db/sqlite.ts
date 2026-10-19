import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { openDB, type IDBPDatabase } from 'idb';
import {
  INITIAL_SCHEMA,
  MIGRATION_V2,
  MIGRATION_V3,
  EMBEDDINGS_SCHEMA,
  FTS_CREATE_V5,
  FTS_TRIGGERS_V5,
} from './schema';

// Two serialized SQLite files live in IndexedDB, in the same store under two keys:
//   - 'primary'    - the MAIN db (tweets, categories, FTS, chat, sync…). Rewritten
//                    on the 2 s debounce after every mutation (the hot path).
//   - 'embeddings' - the embeddings-only db (~28 MB of immutable int8 vectors).
//                    Rewritten ONLY on import, so a favorite/notes mutation no
//                    longer re-serializes it. (Schema v4 split.)

const IDB_NAME = 'trove';
const IDB_STORE = 'snapshots';
const IDB_KEY = 'primary';
const IDB_EMB_KEY = 'embeddings';

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      // Vite serves files in /public at the root.
      locateFile: (file: string) => `/${file}`,
    });
  }
  return sqlJsPromise;
}

async function openIdb(): Promise<IDBPDatabase> {
  return openDB(IDB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    },
  });
}

async function readKey(key: string): Promise<Uint8Array | null> {
  const idb = await openIdb();
  const buf = (await idb.get(IDB_STORE, key)) as Uint8Array | undefined;
  idb.close();
  return buf ?? null;
}

async function writeKey(key: string, bytes: Uint8Array): Promise<void> {
  const idb = await openIdb();
  await idb.put(IDB_STORE, bytes, key);
  idb.close();
}

async function deleteKey(key: string): Promise<void> {
  const idb = await openIdb();
  await idb.delete(IDB_STORE, key);
  idb.close();
}

export async function clearSnapshot(): Promise<void> {
  await deleteKey(IDB_KEY);
  await deleteKey(IDB_EMB_KEY);
}

function readUserVersion(db: Database): number {
  const res = db.exec('PRAGMA user_version');
  return (res[0]?.values[0]?.[0] as number | undefined) ?? 0;
}

function tableExists(db: Database, name: string): boolean {
  const r = db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}'`);
  return (r[0]?.values.length ?? 0) > 0;
}

function columnExists(db: Database, table: string, column: string): boolean {
  // PRAGMA table_info works on virtual tables too (returns declared columns).
  const r = db.exec(`PRAGMA table_info(${table})`);
  return (r[0]?.values ?? []).some((row) => row[1] === column);
}

function runStep(db: Database, stmts: string[]): void {
  db.exec('BEGIN');
  try {
    for (const stmt of stmts) db.exec(stmt);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Ordered MAIN-db migration ladder. v1→v2→v3 are statement arrays; the v4→v5
// step (article columns + FTS rebuild) is the guarded `migrateToV5` below.
// The v3→v4 step (moving tweet_embeddings out to its own db) spans two
// databases, so it stays a separate call (migrateEmbeddingsOut) keyed off
// table presence, which makes it safe at any point in this ladder. Exported
// for migration tests.
export function applyMigrations(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON;');
  if (readUserVersion(db) < 1) {
    runStep(db, INITIAL_SCHEMA);
  }
  if (readUserVersion(db) < 2) {
    runStep(db, MIGRATION_V2);
  }
  if (readUserVersion(db) < 3) {
    runStep(db, MIGRATION_V3);
  }
  migrateToV5(db);
}

function applyEmbSchema(db: Database): void {
  runStep(db, EMBEDDINGS_SCHEMA);
}

/**
 * v3→v4: move tweet_embeddings out of the main db into embDb.
 *
 * Safety ordering (matters if the tab closes mid-migration): copy embeddings to
 * embDb and PERSIST embDb FIRST, only then drop the table from main + bump its
 * version + persist main. The copy is idempotent (INSERT OR REPLACE), so any
 * interrupted run is safely re-done on the next load. Returns true if the main
 * db changed and needs persisting by the caller.
 */
export async function migrateEmbeddingsOut(
  mainDb: Database,
  embDb: Database,
  // Persist embDb to durable storage. Called AFTER the copy and BEFORE the drop
  // from main, so a crash can't lose embeddings. Defaulted to a no-op so the
  // migration logic is testable without IndexedDB.
  persistEmb: () => Promise<void> = async () => {},
): Promise<boolean> {
  // Table-driven, not version-driven: the tweet_embeddings table's presence in
  // main is the real "not yet split" signal, and checking it keeps this safe
  // no matter where in the ladder the caller is (applyMigrations may already
  // have bumped the db past v4 by the time this runs).
  const alreadySplit = readUserVersion(mainDb) >= 4 && !tableExists(mainDb, 'tweet_embeddings');
  if (alreadySplit) return false;

  if (tableExists(mainDb, 'tweet_embeddings')) {
    const sel = mainDb.prepare(
      'SELECT tweet_id, model, dim, dtype, scale, offset, vector, created_at FROM tweet_embeddings',
    );
    const ins = embDb.prepare(
      `INSERT OR REPLACE INTO tweet_embeddings
         (tweet_id, model, dim, dtype, scale, offset, vector, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let moved = 0;
    embDb.exec('BEGIN');
    try {
      while (sel.step()) {
        const r = sel.get();
        // sql.js BLOBs alias WASM memory - copy before binding into the other db.
        const rawVec = r[6] as Uint8Array;
        const vec = new Uint8Array(rawVec.byteLength);
        vec.set(rawVec);
        ins.bind([r[0], r[1], r[2], r[3], r[4], r[5], vec, r[7]]);
        ins.step();
        ins.reset();
        moved++;
      }
      embDb.exec('COMMIT');
    } catch (e) {
      embDb.exec('ROLLBACK');
      sel.free();
      ins.free();
      throw e;
    }
    sel.free();
    ins.free();

    if (moved > 0) {
      // Persist embeddings BEFORE we drop them from main, so a crash here can't
      // lose them (main still holds them until embDb is safely on disk).
      await persistEmb();
    }
    mainDb.exec('DROP TABLE IF EXISTS tweet_embeddings');
  }
  // Mark v4 without ever DOWNGRADING a db that applyMigrations already took
  // further (migrateToV5 runs inside the ladder now).
  if (readUserVersion(mainDb) < 4) mainDb.exec('PRAGMA user_version = 4');
  return true;
}

/**
 * v4→v5: X long-form article support.
 *
 * Adds `tweets.is_article` (tri-state: NULL unknown / 0 / 1) and
 * `tweets.article_title`, then rebuilds tweets_fts with article_title as a
 * fourth indexed column so article titles are searchable (article posts have
 * empty `content`). Every step is guarded by a column-presence check, so a
 * crash mid-migration is safely re-done on the next load.
 *
 * Runs as the final step of applyMigrations; safe at any ladder position
 * because migrateEmbeddingsOut keys off table presence rather than version.
 * Returns true if the db changed and needs persisting by the caller.
 */
export function migrateToV5(db: Database): boolean {
  if (readUserVersion(db) >= 5) return false;

  if (!columnExists(db, 'tweets', 'is_article')) {
    db.exec('ALTER TABLE tweets ADD COLUMN is_article INTEGER');
  }
  if (!columnExists(db, 'tweets', 'article_title')) {
    db.exec('ALTER TABLE tweets ADD COLUMN article_title TEXT');
  }

  if (!columnExists(db, 'tweets_fts', 'article_title')) {
    // Rebuild FTS with the new column set. Drop triggers first so the rebuild
    // INSERT...SELECT doesn't fire them per row.
    db.exec('DROP TRIGGER IF EXISTS tweets_bd');
    db.exec('DROP TRIGGER IF EXISTS tweets_bu');
    db.exec('DROP TRIGGER IF EXISTS tweets_au');
    db.exec('DROP TRIGGER IF EXISTS tweets_ai');
    db.exec('DROP TABLE IF EXISTS tweets_fts');
    db.exec(FTS_CREATE_V5);
    db.exec(
      `INSERT INTO tweets_fts(docid, content, author_handle, author_display_name, article_title)
       SELECT rowid, content, author_handle, author_display_name, article_title FROM tweets`,
    );
    for (const stmt of FTS_TRIGGERS_V5) db.exec(stmt);
  }

  db.exec('PRAGMA user_version = 5');
  return true;
}

export interface SqliteHandle {
  /** Main db: tweets, categories, FTS, chat, sync. Snapshotted on every write. */
  db: Database;
  /** Embeddings-only db. Snapshotted only on import (via flushEmbeddings). */
  embDb: Database;
  /** Force a main-db flush to IndexedDB immediately (awaits the write). */
  flush: () => Promise<void>;
  /** Persist embeddings db to IndexedDB. Call after an embeddings import. */
  flushEmbeddings: () => Promise<void>;
  /** Schedule a debounced main-db flush. Call after every main-db write. */
  markDirty: () => void;
  /** Replace the main db with raw bytes (Settings → Import .db). */
  replace: (bytes: Uint8Array) => Promise<void>;
  /** Serialize the main db to bytes (used by snapshot export). */
  export: () => Uint8Array;
  /** Serialize the embeddings db to bytes (used to seed the retrieval worker). */
  exportEmbeddings: () => Uint8Array;
  /** Close both DBs and any resources. */
  close: () => Promise<void>;
}

let handle: SqliteHandle | null = null;

export async function getDb(): Promise<SqliteHandle> {
  if (handle) return handle;

  const SQL = await loadSqlJs();

  // Main db.
  const mainSnap = await readKey(IDB_KEY);
  const db = mainSnap ? new SQL.Database(mainSnap) : new SQL.Database();
  const versionAtOpen = readUserVersion(db);
  applyMigrations(db);

  // Embeddings db.
  const embSnap = await readKey(IDB_EMB_KEY);
  const embDb = embSnap ? new SQL.Database(embSnap) : new SQL.Database();
  applyEmbSchema(embDb);

  // v3→v4: move embeddings out of main (one-time; no-op once split).
  const mainChanged = await migrateEmbeddingsOut(db, embDb, () =>
    writeKey(IDB_EMB_KEY, embDb.export()),
  );
  // Persist when either the embeddings split or an applyMigrations step (e.g.
  // the v5 article columns + FTS rebuild) changed the main db.
  if (mainChanged || readUserVersion(db) !== versionAtOpen) {
    await writeKey(IDB_KEY, db.export());
  }

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFlush: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingFlush) return pendingFlush;
    const bytes = db.export();
    pendingFlush = writeKey(IDB_KEY, bytes).finally(() => {
      pendingFlush = null;
    });
    return pendingFlush;
  };

  const flushEmbeddings = async (): Promise<void> => {
    await writeKey(IDB_EMB_KEY, embDb.export());
  };

  const markDirty = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      void flush();
    }, 2000);
  };

  // On tab close, try a final main-db flush (embeddings are import-persisted).
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (flushTimer || pendingFlush) {
        const bytes = db.export();
        void writeKey(IDB_KEY, bytes); // fire-and-forget best effort
      }
    });
  }

  handle = {
    db,
    embDb,
    flush,
    flushEmbeddings,
    markDirty,
    async replace(bytes) {
      // Replace the MAIN db from an imported .db. The imported file is a
      // different archive, so reset embeddings: clear the old ones, then move
      // any embeddings the imported .db itself carries (old-format backups had
      // them in the main db) into embDb. Embeddings absent from the import are
      // re-loaded later via the ⟳ sync.
      db.close();
      embDb.close();
      const freshMain = new SQL.Database(bytes);
      applyMigrations(freshMain);
      await deleteKey(IDB_EMB_KEY);
      const freshEmb = new SQL.Database();
      applyEmbSchema(freshEmb);
      await migrateEmbeddingsOut(freshMain, freshEmb, () =>
        writeKey(IDB_EMB_KEY, freshEmb.export()),
      );
      const h = handle as unknown as { db: Database; embDb: Database };
      h.db = freshMain;
      h.embDb = freshEmb;
      await writeKey(IDB_KEY, freshMain.export());
      await writeKey(IDB_EMB_KEY, freshEmb.export());
    },
    export: () => db.export(),
    exportEmbeddings: () => embDb.export(),
    async close() {
      await flush();
      await flushEmbeddings();
      db.close();
      embDb.close();
      handle = null;
    },
  };

  return handle;
}

/** Destroy the in-memory DBs and reset to an empty fresh state. */
export async function resetDb(): Promise<void> {
  if (handle) {
    handle.db.close();
    handle.embDb.close();
    handle = null;
  }
  await clearSnapshot();
}
