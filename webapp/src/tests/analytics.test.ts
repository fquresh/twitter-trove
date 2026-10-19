// Analytics aggregations are pure SQL over sql.js - run in node so the wasm
// resolves from the filesystem (matches sqlite.test.ts / enrichments.test.ts).
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import {
  timeSeries,
  categoryBreakdown,
  topAccounts,
  entityTrends,
  topEntities,
} from '../db/queries/analytics';
import { emptyFilterSet } from '../filters/types';
import type { FilterSet, Granularity, TimeField } from '../filters/types';

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

/** Unix seconds for a UTC calendar instant. */
function t(y: number, mo: number, d: number, h = 0): number {
  return Math.floor(Date.UTC(y, mo - 1, d, h) / 1000);
}

interface SeedTweet {
  id: string;
  handle: string;
  display?: string;
  createdAt: number;
  likedAt?: number;
  likes?: number;
}

function insertTweet(db: Database, tw: SeedTweet): void {
  db.run(
    `INSERT INTO tweets
       (id, author_handle, author_display_name, content, created_at, liked_at, like_count, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tw.id,
      tw.handle,
      tw.display ?? null,
      `tweet ${tw.id}`,
      tw.createdAt,
      tw.likedAt ?? tw.createdAt,
      tw.likes ?? 0,
      1_700_000_000,
    ],
  );
}

function insertCategory(db: Database, name: string, color: string | null): number {
  db.run(
    `INSERT INTO categories (name, color, source, created_at) VALUES (?, ?, 'classifier', ?)`,
    [name, color, 1_700_000_000],
  );
  const r = db.exec('SELECT id FROM categories WHERE name = ?', [name]);
  return r[0].values[0][0] as number;
}

function assignCategory(db: Database, tweetId: string, categoryId: number): void {
  db.run(
    `INSERT INTO tweet_categories (tweet_id, category_id, assigned_at, assigned_by)
     VALUES (?, ?, ?, 'classifier')`,
    [tweetId, categoryId, 1_700_000_000],
  );
}

function insertEntity(db: Database, type: string, value: string): number {
  db.run(`INSERT INTO entities (type, value) VALUES (?, ?)`, [type, value]);
  const r = db.exec('SELECT id FROM entities WHERE type = ? AND value = ?', [type, value]);
  return r[0].values[0][0] as number;
}

function linkEntity(db: Database, tweetId: string, entityId: number): void {
  db.run(`INSERT INTO tweet_entities (tweet_id, entity_id) VALUES (?, ?)`, [tweetId, entityId]);
}

function filters(overrides: Partial<FilterSet> = {}): FilterSet {
  return { ...emptyFilterSet(), ...overrides };
}

describe('timeSeries', () => {
  it('buckets by month and counts, ordered by start ascending (UTC offset)', () => {
    const db = freshDb();
    insertTweet(db, { id: 'a', handle: 'alice', createdAt: t(2024, 1, 15) });
    insertTweet(db, { id: 'b', handle: 'bob', createdAt: t(2024, 1, 20) });
    insertTweet(db, { id: 'c', handle: 'alice', createdAt: t(2024, 2, 10) });

    const rows = timeSeries(
      db,
      filters({ timeField: 'created_at' as TimeField, granularity: 'month' as Granularity }),
      0, // tz offset = 0 → buckets computed in UTC, deterministic
    );

    expect(rows.map((r) => [r.bucket, r.count])).toEqual([
      ['2024-01', 2],
      ['2024-02', 1],
    ]);
    // start is ascending and matches the UTC month boundary of the first bucket.
    expect(rows[0].start).toBe(t(2024, 1, 1));
    db.close();
  });

  it('buckets by Sunday-start week', () => {
    const db = freshDb();
    // 2024-03-10 is a Sunday. 03-12 is the same week; 03-17 is the next Sunday.
    insertTweet(db, { id: 'a', handle: 'alice', createdAt: t(2024, 3, 10, 12) });
    insertTweet(db, { id: 'b', handle: 'bob', createdAt: t(2024, 3, 12, 12) });
    insertTweet(db, { id: 'c', handle: 'carol', createdAt: t(2024, 3, 17, 12) });

    const rows = timeSeries(
      db,
      filters({ timeField: 'created_at' as TimeField, granularity: 'week' as Granularity }),
      0,
    );

    expect(rows.map((r) => [r.bucket, r.count])).toEqual([
      ['2024-03-10', 2],
      ['2024-03-17', 1],
    ]);
    db.close();
  });

  it('respects the from/to time-range filter', () => {
    const db = freshDb();
    insertTweet(db, { id: 'a', handle: 'alice', createdAt: t(2024, 1, 15) });
    insertTweet(db, { id: 'c', handle: 'alice', createdAt: t(2024, 2, 10) });

    const rows = timeSeries(
      db,
      filters({
        timeField: 'created_at' as TimeField,
        granularity: 'month' as Granularity,
        from: t(2024, 2, 1),
      }),
      0,
    );

    expect(rows.map((r) => r.bucket)).toEqual(['2024-02']);
    db.close();
  });

  it('returns nothing for an empty table', () => {
    const db = freshDb();
    expect(timeSeries(db, filters(), 0)).toEqual([]);
    db.close();
  });
});

describe('categoryBreakdown', () => {
  it('counts distinct tweets per category, ordered by count desc then name', () => {
    const db = freshDb();
    insertTweet(db, { id: 'a', handle: 'alice', createdAt: t(2024, 1, 1) });
    insertTweet(db, { id: 'b', handle: 'bob', createdAt: t(2024, 1, 2) });
    insertTweet(db, { id: 'c', handle: 'carol', createdAt: t(2024, 1, 3) });
    const tech = insertCategory(db, 'Tech', '#00f');
    const sports = insertCategory(db, 'Sports', null);
    assignCategory(db, 'a', tech);
    assignCategory(db, 'b', tech);
    assignCategory(db, 'c', sports);

    const rows = categoryBreakdown(db, filters());
    expect(rows.map((r) => [r.name, r.count])).toEqual([
      ['Tech', 2],
      ['Sports', 1],
    ]);
    expect(rows[0].color).toBe('#00f');
    expect(rows[1].color).toBeNull();
    db.close();
  });

  it('honors the limit argument', () => {
    const db = freshDb();
    insertTweet(db, { id: 'a', handle: 'alice', createdAt: t(2024, 1, 1) });
    const one = insertCategory(db, 'One', null);
    const two = insertCategory(db, 'Two', null);
    assignCategory(db, 'a', one);
    assignCategory(db, 'a', two);

    expect(categoryBreakdown(db, filters(), 1)).toHaveLength(1);
    db.close();
  });
});

describe('topAccounts', () => {
  it('aggregates count, average likes, and percentage share', () => {
    const db = freshDb();
    insertTweet(db, { id: 'a', handle: 'alice', display: 'Alice', createdAt: t(2024, 1, 1), likes: 100 });
    insertTweet(db, { id: 'b', handle: 'alice', display: 'Alice', createdAt: t(2024, 1, 2), likes: 200 });
    insertTweet(db, { id: 'c', handle: 'bob', display: 'Bob', createdAt: t(2024, 1, 3), likes: 50 });

    const rows = topAccounts(db, filters());
    expect(rows).toHaveLength(2);

    const alice = rows.find((r) => r.handle === 'alice')!;
    expect(alice.count).toBe(2);
    expect(alice.display_name).toBe('Alice');
    expect(alice.avg_likes).toBe(150);
    expect(alice.pct).toBeCloseTo(66.67, 2);

    const bob = rows.find((r) => r.handle === 'bob')!;
    expect(bob.count).toBe(1);
    expect(bob.pct).toBeCloseTo(33.33, 2);

    // Ordered by count desc → alice first.
    expect(rows[0].handle).toBe('alice');
    db.close();
  });
});

describe('entity aggregations', () => {
  function seedEntities(db: Database): void {
    insertTweet(db, { id: 'a', handle: 'alice', createdAt: t(2024, 1, 10) });
    insertTweet(db, { id: 'b', handle: 'bob', createdAt: t(2024, 2, 10) });
    insertTweet(db, { id: 'c', handle: 'carol', createdAt: t(2024, 2, 20) });
    const aapl = insertEntity(db, 'ticker', 'AAPL');
    const ai = insertEntity(db, 'hashtag', 'ai');
    linkEntity(db, 'a', aapl);
    linkEntity(db, 'b', aapl);
    linkEntity(db, 'c', ai);
  }

  it('topEntities counts by value for a given type, ordered by count desc', () => {
    const db = freshDb();
    seedEntities(db);

    const tickers = topEntities(db, filters(), 'ticker');
    expect(tickers).toEqual([{ value: 'AAPL', count: 2 }]);

    const hashtags = topEntities(db, filters(), 'hashtag');
    expect(hashtags).toEqual([{ value: 'ai', count: 1 }]);
    db.close();
  });

  it('entityTrends buckets an entity value over time', () => {
    const db = freshDb();
    seedEntities(db);

    const rows = entityTrends(
      db,
      filters({ timeField: 'created_at' as TimeField, granularity: 'month' as Granularity }),
      'ticker',
      10,
      0,
    );

    // AAPL appears once in Jan and once in Feb.
    expect(rows.map((r) => [r.bucket, r.value, r.count])).toEqual([
      ['2024-01', 'AAPL', 1],
      ['2024-02', 'AAPL', 1],
    ]);
    db.close();
  });
});

/** Seed `authors` distinct accounts, each with `perAuthor` tweets, so counts
 *  are strictly ordered by author index (author0 has the most). */
function seed(db: Database, authors: number): void {
  for (let a = 0; a < authors; a++) {
    // Higher-indexed accounts get fewer tweets → deterministic ordering.
    const n = authors - a;
    for (let i = 0; i < n; i++) {
      db.run(
        `INSERT INTO tweets (id, author_handle, author_display_name, content, created_at, imported_at, like_count)
         VALUES (?, ?, ?, 'hello', 1700000000, 1700000000, ?)`,
        [`t${a}_${i}`, `@user${a}`, `User ${a}`, 10 * (a + 1)],
      );
    }
  }
}

describe('topAccounts (limits and ordering)', () => {
  it('respects the limit (25 / 50 / 100)', () => {
    const db = freshDb();
    seed(db, 120); // more accounts than the largest limit
    for (const limit of [25, 50, 100]) {
      const rows = topAccounts(db, emptyFilterSet(), limit);
      expect(rows).toHaveLength(limit);
    }
    db.close();
  });

  it('returns fewer than the limit when accounts are scarce', () => {
    const db = freshDb();
    seed(db, 10);
    expect(topAccounts(db, emptyFilterSet(), 25)).toHaveLength(10);
    db.close();
  });

  it('orders by liked-tweet count descending with handle, count, pct, avg_likes', () => {
    const db = freshDb();
    seed(db, 3); // user0: 3 tweets, user1: 2, user2: 1
    const rows = topAccounts(db, emptyFilterSet(), 25);
    expect(rows.map((r) => r.handle)).toEqual(['@user0', '@user1', '@user2']);
    expect(rows.map((r) => r.count)).toEqual([3, 2, 1]);
    expect(rows[0].display_name).toBe('User 0');
    expect(rows[0].avg_likes).toBe(10); // like_count fixed at 10*(a+1) → user0 = 10
    // 3 of 6 total tweets → 50%.
    expect(rows[0].pct).toBeCloseTo(50, 1);
    db.close();
  });
});
