// Cross-device sync logic. Pure DB + apply semantics - no network. Runs in the
// node env so sql.js resolves its wasm from the filesystem (like sqlite.test).
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import { setFavorite, setNotes, importClassifierTweets } from '../db/queries/tweets';
import type { ClassifierTweet } from '../parser/classifierJson';
import { assignUserCategory, upsertCategory } from '../db/queries/categories';
import {
  collectOutbox,
  recordMutation,
  pruneOutbox,
  getSyncState,
  setSyncState,
  deleteSyncState,
  latestOutboxTimestamp,
  categoryAssignTarget,
} from '../db/queries/outbox';
import { applyPulledMutations, type WireMutation } from '../sync/syncClient';

const __dirname = dirname(fileURLToPath(import.meta.url));
let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
});

function freshDb(): Database {
  const db = new SQL.Database();
  applyMigrations(db);
  return db;
}

function insertTweet(db: Database, id: string): void {
  db.run(
    `INSERT INTO tweets (id, author_handle, content, created_at, imported_at)
     VALUES (?, 'alice', 'hello', 1700000000, 1700000000)`,
    [id],
  );
}

function classifierTweet(over: Partial<ClassifierTweet>): ClassifierTweet {
  return {
    id: 'x',
    categories: [],
    author: 'Alice',
    handle: '@alice',
    text: 'hello world',
    timestamp: 'Jul 26, 2021',
    images: [],
    hasVideo: false,
    likeCount: 0,
    retweetCount: 0,
    ...over,
  };
}

describe('importClassifierTweets (cloud tweet creation)', () => {
  it('creates rows with content, engagement, date, image, and a constructed X link', () => {
    const db = freshDb();
    const r = importClassifierTweets(db, [
      classifierTweet({
        id: '100',
        handle: '@bob',
        author: 'Bob',
        text: 'gm',
        timestamp: 'Jan 2, 2024',
        images: ['http://img/1.jpg'],
        likeCount: 1048,
        retweetCount: 99,
      }),
    ]);
    expect(r.inserted).toBe(1);
    const row = db.exec(
      `SELECT author_handle, author_display_name, content, is_favorite, like_count, retweet_count, link, image_urls
       FROM tweets WHERE id='100'`,
    )[0].values[0];
    expect(row[0]).toBe('bob'); // @ stripped
    expect(row[1]).toBe('Bob');
    expect(row[2]).toBe('gm');
    expect(row[3]).toBe(0); // is_favorite default
    expect(row[4]).toBe(1048); // like_count carried from JSON engagement
    expect(row[5]).toBe(99); // retweet_count
    expect(row[6]).toBe('https://x.com/bob/status/100');
    expect(row[7]).toBe(JSON.stringify(['http://img/1.jpg']));
    db.close();
  });

  it('imports image/video-only and empty-text tweets (only skips unparseable dates)', () => {
    const db = freshDb();
    const r = importClassifierTweets(db, [
      classifierTweet({ id: 'img', text: '', images: ['http://img/x.jpg'] }), // image-only, empty text
      classifierTweet({ id: 'vid', text: null, hasVideo: true }), // video-only, null text
      classifierTweet({ id: 'bare', text: '' }), // truly empty but real liked tweet
      classifierTweet({ id: 'baddate', timestamp: 'not a date' }), // the only kind that skips
    ]);
    expect(r.inserted).toBe(3);
    expect(r.errors).toHaveLength(1);
    expect(db.exec('SELECT COUNT(*) FROM tweets')[0].values[0][0]).toBe(3);
    // missing-handle fallback link still resolves a tweet on X
    db.close();
  });

  it('refreshes engagement on an existing tweet but preserves favorite + notes', () => {
    const db = freshDb();
    insertTweet(db, 't1');
    db.run(`UPDATE tweets SET is_favorite = 1, user_notes = 'mine', like_count = 5 WHERE id = 't1'`);
    const r = importClassifierTweets(db, [
      classifierTweet({ id: 't1', likeCount: 4242, retweetCount: 7 }),
    ]);
    expect(r.inserted).toBe(0);
    expect(r.updated).toBe(1);
    const row = db.exec(
      `SELECT like_count, retweet_count, is_favorite, user_notes FROM tweets WHERE id='t1'`,
    )[0].values[0];
    expect(row[0]).toBe(4242); // engagement refreshed
    expect(row[1]).toBe(7);
    expect(row[2]).toBe(1); // favorite preserved
    expect(row[3]).toBe('mine'); // notes preserved
    db.close();
  });
});

function favOf(db: Database, id: string): unknown {
  return db.exec(`SELECT is_favorite FROM tweets WHERE id='${id}'`)[0]?.values[0]?.[0];
}

describe('outbox', () => {
  it('records mutations and collects them in insertion order', () => {
    const db = freshDb();
    recordMutation(db, 'favorite', 't1', 'true');
    recordMutation(db, 'notes', 't1', '"hi"');
    const rows = collectOutbox(db);
    expect(rows.map((r) => r.kind)).toEqual(['favorite', 'notes']);
    db.close();
  });

  it('prunes pushed rows by id, leaving newer ones', () => {
    const db = freshDb();
    recordMutation(db, 'favorite', 't1', 'true');
    recordMutation(db, 'favorite', 't2', 'true');
    const rows = collectOutbox(db);
    pruneOutbox(db, rows[0].id);
    expect(collectOutbox(db).map((r) => r.target_id)).toEqual(['t2']);
    db.close();
  });

  it('round-trips and deletes sync_state key/value', () => {
    const db = freshDb();
    expect(getSyncState(db, 'last_pulled_seq')).toBeNull();
    setSyncState(db, 'last_pulled_seq', '42');
    setSyncState(db, 'last_pulled_seq', '99');
    expect(getSyncState(db, 'last_pulled_seq')).toBe('99');
    deleteSyncState(db, 'last_pulled_seq');
    expect(getSyncState(db, 'last_pulled_seq')).toBeNull();
    db.close();
  });
});

describe('mutation instrumentation', () => {
  it('setFavorite / setNotes update the row AND enqueue an outbox mutation', () => {
    const db = freshDb();
    insertTweet(db, 't1');
    setFavorite(db, 't1', true);
    setNotes(db, 't1', 'a note');
    expect(favOf(db, 't1')).toBe(1);

    const rows = collectOutbox(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'favorite', target_id: 't1', value: 'true' });
    expect(rows[1]).toMatchObject({ kind: 'notes', target_id: 't1', value: '"a note"' });
    db.close();
  });

  it('assignUserCategory enqueues a NAME-keyed category mutation', () => {
    const db = freshDb();
    insertTweet(db, 't1');
    const id = upsertCategory(db, 'Macro', 'manual');
    assignUserCategory(db, 't1', id);
    const rows = collectOutbox(db).filter((r) => r.kind === 'category_assign');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(categoryAssignTarget('t1', 'Macro'));
    expect(rows[0].value).toBe('{"assigned":true}');
    db.close();
  });
});

describe('applyPulledMutations', () => {
  it('applies pulled favorite + notes onto local tweets (seq field is ignored by apply)', () => {
    const db = freshDb();
    insertTweet(db, 't1');
    const muts: WireMutation[] = [
      { kind: 'favorite', target_id: 't1', value: 'true', updated_at: 1000, seq: 7 },
      { kind: 'notes', target_id: 't1', value: JSON.stringify('remember this'), updated_at: 1001, seq: 8 },
    ];
    expect(applyPulledMutations(db, muts)).toBe(2);
    const row = db.exec(`SELECT is_favorite, user_notes FROM tweets WHERE id='t1'`)[0].values[0];
    expect(row[0]).toBe(1);
    expect(row[1]).toBe('remember this');
    db.close();
  });

  it('LWW guard: skips a pulled value older than an un-pushed local mutation', () => {
    const db = freshDb();
    insertTweet(db, 't1');
    // Local un-pushed mutation at "now" (a large ms timestamp).
    db.run(`UPDATE tweets SET is_favorite = 0 WHERE id = 't1'`);
    recordMutation(db, 'favorite', 't1', 'false');
    const localTs = latestOutboxTimestamp(db, 'favorite', 't1')!;
    expect(localTs).toBeGreaterThan(1);

    // A staler server value must NOT clobber the fresher local one.
    const applied = applyPulledMutations(db, [
      { kind: 'favorite', target_id: 't1', value: 'true', updated_at: 1 },
    ]);
    expect(applied).toBe(0);
    expect(favOf(db, 't1')).toBe(0);
    db.close();
  });

  it('applies a category assignment by name, creating the category', () => {
    const db = freshDb();
    insertTweet(db, 't1');
    const target = categoryAssignTarget('t1', 'Crypto');

    expect(
      applyPulledMutations(db, [
        { kind: 'category_assign', target_id: target, value: '{"assigned":true}', updated_at: 1000 },
      ]),
    ).toBe(1);
    const link = db.exec(
      `SELECT c.name, tc.assigned_by FROM categories c
       JOIN tweet_categories tc ON tc.category_id = c.id WHERE tc.tweet_id = 't1'`,
    )[0].values[0];
    expect(link[0]).toBe('Crypto');
    expect(link[1]).toBe('user');

    // An unassign with a later timestamp removes the link.
    applyPulledMutations(db, [
      { kind: 'category_assign', target_id: target, value: '{"assigned":false}', updated_at: 2000 },
    ]);
    expect(db.exec(`SELECT COUNT(*) FROM tweet_categories WHERE tweet_id='t1'`)[0].values[0][0]).toBe(
      0,
    );
    db.close();
  });

  it('skips a category assignment for a tweet not present locally (FK-safe, no throw)', () => {
    const db = freshDb(); // no tweet inserted
    const applied = applyPulledMutations(db, [
      {
        kind: 'category_assign',
        target_id: categoryAssignTarget('ghost', 'X'),
        value: '{"assigned":true}',
        updated_at: 1,
      },
    ]);
    expect(applied).toBe(0);
    expect(db.exec(`SELECT COUNT(*) FROM tweet_categories`)[0].values[0][0]).toBe(0);
    db.close();
  });

  it('reports malformed pulled mutations instead of silently discarding them', () => {
    const db = freshDb();
    insertTweet(db, 't1');
    const errors: string[] = [];
    const applied = applyPulledMutations(
      db,
      [{ kind: 'favorite', target_id: 't1', value: 'not-json', updated_at: 1 }],
      (message) => errors.push(message),
    );
    expect(applied).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('favorite:t1');
    db.close();
  });
});
