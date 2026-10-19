// The cloud / JSON-only import path: classifier JSON must create tweet rows AND
// link categories without the FK-violation rollback that silently discarded all
// categorization. Runs in node so sql.js resolves its wasm from disk.
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import { importClassifierTweets } from '../db/queries/tweets';
import { replaceClassifierAssignments } from '../db/queries/categories';
import type { ClassifierTweet } from '../parser/classifierJson';

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

function ct(over: Partial<ClassifierTweet>): ClassifierTweet {
  return {
    id: 'x',
    categories: ['Crypto > AI'],
    author: 'Alice',
    handle: '@alice',
    text: 'hello',
    timestamp: 'Jul 26, 2021',
    images: [],
    hasVideo: false,
    likeCount: 0,
    retweetCount: 0,
    ...over,
  };
}

describe('classifier-only import (JSON without HTML)', () => {
  it('creates rows then links categories - no FK rollback', () => {
    const db = freshDb();
    const tweets = [
      ct({ id: '1', categories: ['Crypto > AI', 'Trading'] }),
      ct({ id: '2', categories: ['Crypto > AI'] }),
    ];
    importClassifierTweets(db, tweets);
    const link = replaceClassifierAssignments(
      db,
      tweets.map((t) => ({ tweetId: t.id, categories: t.categories })),
    );
    expect(link.linked).toBe(2);
    expect(link.skipped).toBe(0);
    const n = db.exec(
      `SELECT COUNT(*) FROM tweet_categories WHERE assigned_by='classifier'`,
    )[0].values[0][0];
    expect(n).toBe(3); // 2 + 1 assignments survived (would be 0 under the old rollback bug)
    db.close();
  });

  it('skips assignments for tweets not in the DB instead of aborting them all', () => {
    const db = freshDb();
    // Only tweet '1' exists; '2' is referenced but never created.
    importClassifierTweets(db, [ct({ id: '1' })]);
    const link = replaceClassifierAssignments(db, [
      { tweetId: '1', categories: ['Crypto > AI'] },
      { tweetId: '2', categories: ['Trading'] }, // missing tweet → must be skipped, not throw
    ]);
    expect(link.linked).toBe(1);
    expect(link.skipped).toBe(1);
    // tweet 1's category still landed (no wholesale rollback)
    const n = db.exec(`SELECT COUNT(*) FROM tweet_categories`)[0].values[0][0];
    expect(n).toBe(1);
    db.close();
  });
});
