import type { Database } from 'sql.js';
import { run, all, get, scalar, transaction } from '../exec';
import type { RawTweet } from '../../parser/htmlExport';
import { extractEntities } from '../../parser/entities';
import { buildFilterFragments } from '../../filters/queryBuilder';
import type { FilterSet } from '../../filters/types';
import { recordMutation } from './outbox';
import type { ClassifierTweet } from '../../parser/classifierJson';

export interface TweetRow {
  id: string;
  author_handle: string;
  author_display_name: string | null;
  content: string;
  created_at: number;
  liked_at: number;
  like_count: number;
  retweet_count: number;
  reply_count: number;
  is_thread: number;
  thread_id: string | null;
  image_urls: string | null;
  source_file: string | null;
  imported_at: number;
  is_favorite: number;
  user_notes: string | null;
  has_video: number;
  link: string | null;
  /** Tri-state: 1 known article, 0 known non-article, NULL unknown (row
   * predates article-aware capture). Filter with `is_article = 1`. */
  is_article: number | null;
  /** Article card title when the scrape exposed it; NULL otherwise. */
  article_title: string | null;
}

export interface ImportSummary {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

// Upserts tweets from HTML-export parse. New tweets are inserted; existing
// tweets have engagement counts and media refreshed but keep is_favorite,
// user_notes, and any manual category/tag assignments.
export function importHtmlTweets(
  db: Database,
  tweets: Array<RawTweet & { source_file: string }>,
): ImportSummary {
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  transaction(db, () => {
    const insertStmt = db.prepare(`
      INSERT INTO tweets (
        id, author_handle, author_display_name, content,
        created_at, liked_at, like_count, retweet_count,
        is_thread, image_urls, source_file, imported_at,
        has_video, link, is_article, article_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        like_count    = excluded.like_count,
        retweet_count = excluded.retweet_count,
        image_urls    = excluded.image_urls,
        has_video     = excluded.has_video,
        author_display_name = COALESCE(excluded.author_display_name, tweets.author_display_name),
        source_file   = COALESCE(excluded.source_file, tweets.source_file),
        imported_at   = excluded.imported_at,
        is_article    = COALESCE(excluded.is_article, tweets.is_article),
        article_title = COALESCE(excluded.article_title, tweets.article_title)
    `);
    // We can't read sqlite3_changes() reliably here, so we probe existence
    // once per tweet. For 10K imports this is a single indexed lookup each,
    // still well within the perf budget.
    const existsStmt = db.prepare('SELECT 1 FROM tweets WHERE id = ?');

    for (const t of tweets) {
      try {
        const createdAt = Math.floor(Date.parse(t.timestamp) / 1000);
        if (Number.isNaN(createdAt)) {
          errors.push(`${t.id}: unparseable timestamp ${t.timestamp}`);
          continue;
        }
        existsStmt.bind([t.id]);
        const already = existsStmt.step();
        existsStmt.reset();

        insertStmt.bind([
          t.id,
          t.handle,
          t.username || null,
          t.text,
          createdAt,
          createdAt, // liked_at fallback; see README.
          t.likeCount,
          t.retweetCount,
          t.images ? JSON.stringify(t.images) : null,
          t.source_file,
          now,
          t.hasVideo ? 1 : 0,
          t.link,
          // undefined (legacy export) -> NULL so the ON CONFLICT COALESCE
          // keeps any previously known flag instead of clearing it.
          t.isArticle === undefined ? null : t.isArticle ? 1 : 0,
          t.articleTitle ?? null,
        ]);
        while (insertStmt.step()) {
          // no-op
        }
        insertStmt.reset();

        if (already) updated++;
        else inserted++;
      } catch (e) {
        errors.push(`${t.id}: ${(e as Error).message}`);
      }
    }
    insertStmt.free();
    existsStmt.free();

    // Extract entities for every tweet (both new AND updated - text may have
    // evolved on X between captures, though in practice it's stable).
    upsertEntitiesForTweets(db, tweets);

    // Recompute thread flags once per import. This UPDATE is O(N·avg-cluster)
    // bounded by the indexes on author_handle and created_at.
    db.exec(`
      UPDATE tweets AS t
      SET is_thread = CASE WHEN EXISTS (
        SELECT 1 FROM tweets o
        WHERE o.author_handle = t.author_handle
          AND o.id != t.id
          AND ABS(o.created_at - t.created_at) < 3600
      ) THEN 1 ELSE 0 END
    `);
  });

  return { inserted, updated, skipped: 0, errors };
}

// Create/refresh tweet rows from the classifier JSON's full content. This is
// the ONLY source of tweet rows in CLOUD mode, where no HTML files are served
// (the other producer, importHtmlTweets, runs on HTML). Mirrors importHtmlTweets'
// idempotency contract: new tweets are inserted with their engagement; existing
// tweets have like/retweet counts refreshed but keep is_favorite, user_notes,
// liked_at, and manual category/tag assignments. To match the HTML path's count,
// the only reason a row is dropped is an unparseable timestamp - empty-text and
// image/video-only tweets ARE imported.
export function importClassifierTweets(
  db: Database,
  tweets: ClassifierTweet[],
): ImportSummary {
  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];
  const fresh: Array<{ id: string; text: string }> = [];

  transaction(db, () => {
    const exists = db.prepare('SELECT 1 FROM tweets WHERE id = ?');
    const insert = db.prepare(`
      INSERT INTO tweets (
        id, author_handle, author_display_name, content,
        created_at, liked_at, like_count, retweet_count,
        is_thread, image_urls, source_file, imported_at, has_video, link,
        is_article, article_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Refresh engagement on an existing row, but ONLY when it actually changed -
    // the guard avoids firing the FTS update triggers for every unchanged row on
    // a no-op re-sync (matters on mobile with tens of thousands of rows). Never touches favorites/notes.
    const refresh = db.prepare(`
      UPDATE tweets SET like_count = ?, retweet_count = ?
      WHERE id = ? AND (like_count != ? OR retweet_count != ?)
    `);
    // Article flags arrive only when the classifier ran on extension v1.1+
    // exports (isArticle defined). The `IS NOT` guard is null-safe inequality,
    // so a known flag is written exactly once and stale null-flagged classifier
    // JSON never clears one set by the HTML path.
    const refreshArticle = db.prepare(`
      UPDATE tweets SET is_article = ?, article_title = COALESCE(?, article_title)
      WHERE id = ? AND (is_article IS NOT ? OR (? IS NOT NULL AND article_title IS NULL))
    `);
    for (const t of tweets) {
      const createdAt = t.timestamp ? Math.floor(Date.parse(t.timestamp) / 1000) : NaN;
      if (Number.isNaN(createdAt)) {
        errors.push(`${t.id}: unparseable timestamp ${t.timestamp}`);
        continue;
      }
      const handle = (t.handle ?? '').replace(/^@/, '');
      exists.bind([t.id]);
      const already = exists.step();
      exists.reset();
      if (already) {
        refresh.bind([t.likeCount, t.retweetCount, t.id, t.likeCount, t.retweetCount]);
        while (refresh.step()) {
          // no-op
        }
        refresh.reset();
        if (t.isArticle !== undefined) {
          const flag = t.isArticle ? 1 : 0;
          refreshArticle.bind([flag, t.articleTitle ?? null, t.id, flag, t.articleTitle ?? null]);
          while (refreshArticle.step()) {
            // no-op
          }
          refreshArticle.reset();
        }
        updated++;
        continue;
      }
      const link = handle
        ? `https://x.com/${handle}/status/${t.id}`
        : `https://x.com/i/web/status/${t.id}`;
      insert.bind([
        t.id,
        handle,
        t.author ?? null,
        t.text ?? '',
        createdAt,
        createdAt, // liked_at fallback; see README.
        t.likeCount,
        t.retweetCount,
        t.images.length ? JSON.stringify(t.images) : null,
        'categorized_tweets.json',
        now,
        t.hasVideo ? 1 : 0,
        link,
        t.isArticle === undefined ? null : t.isArticle ? 1 : 0,
        t.articleTitle ?? null,
      ]);
      while (insert.step()) {
        // no-op
      }
      insert.reset();
      inserted++;
      fresh.push({ id: t.id, text: t.text ?? '' });
    }
    exists.free();
    insert.free();
    refresh.free();
    refreshArticle.free();

    // Extract entities only for newly created rows - existing rows already have
    // theirs (text never changes between syncs of the same archive).
    upsertEntitiesForTweets(db, fresh);
  });

  return { inserted, updated, skipped: 0, errors };
}

function upsertEntitiesForTweets(
  db: Database,
  tweets: Array<{ id: string; text: string }>,
): void {
  // Clear existing entity links for these tweets, then re-insert fresh.
  // We keep the entities table rows (they're shared), but the join table
  // is tweet-specific.
  const deleteStmt = db.prepare('DELETE FROM tweet_entities WHERE tweet_id = ?');
  const entityInsert = db.prepare(
    'INSERT OR IGNORE INTO entities (type, value) VALUES (?, ?)',
  );
  const entityLookup = db.prepare('SELECT id FROM entities WHERE type = ? AND value = ?');
  const linkInsert = db.prepare(
    'INSERT OR IGNORE INTO tweet_entities (tweet_id, entity_id) VALUES (?, ?)',
  );

  for (const t of tweets) {
    deleteStmt.bind([t.id]);
    while (deleteStmt.step()) {
      // no-op
    }
    deleteStmt.reset();

    const { tickers, hashtags, mentions } = extractEntities(t.text);
    const pairs: Array<['ticker' | 'hashtag' | 'mention', string]> = [
      ...tickers.map((v) => ['ticker' as const, v] as ['ticker', string]),
      ...hashtags.map((v) => ['hashtag' as const, v] as ['hashtag', string]),
      ...mentions.map((v) => ['mention' as const, v] as ['mention', string]),
    ];
    for (const [type, value] of pairs) {
      entityInsert.bind([type, value]);
      while (entityInsert.step()) {
        // no-op
      }
      entityInsert.reset();

      entityLookup.bind([type, value]);
      if (entityLookup.step()) {
        const row = entityLookup.get();
        const entityId = row[0] as number;
        entityLookup.reset();

        linkInsert.bind([t.id, entityId]);
        while (linkInsert.step()) {
          // no-op
        }
        linkInsert.reset();
      } else {
        entityLookup.reset();
      }
    }
  }

  deleteStmt.free();
  entityInsert.free();
  entityLookup.free();
  linkInsert.free();
}

export interface ListPage {
  rows: TweetRow[];
  total: number;
}

export function listTweetsPage(
  db: Database,
  filters: FilterSet,
  page: number,
  pageSize: number,
  orderBy: 'liked_desc' | 'liked_asc' | 'created_desc' | 'created_asc' = 'liked_desc',
): ListPage {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  const sort = (() => {
    switch (orderBy) {
      case 'liked_asc':
        return 't.liked_at ASC';
      case 'created_desc':
        return 't.created_at DESC';
      case 'created_asc':
        return 't.created_at ASC';
      case 'liked_desc':
      default:
        return 't.liked_at DESC';
    }
  })();
  const offset = Math.max(0, (page - 1) * pageSize);

  const rows = all<TweetRow>(
    db,
    `SELECT t.* FROM tweets t ${joinSql} WHERE ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = scalar<number>(
    db,
    `SELECT COUNT(*) FROM tweets t ${joinSql} WHERE ${whereSql}`,
    params,
  ) ?? 0;
  return { rows, total };
}

export function getTweetById(db: Database, id: string): TweetRow | null {
  return get<TweetRow>(db, 'SELECT * FROM tweets WHERE id = ?', [id]);
}

export function setFavorite(db: Database, id: string, isFav: boolean): void {
  run(db, 'UPDATE tweets SET is_favorite = ? WHERE id = ?', [isFav ? 1 : 0, id]);
  recordMutation(db, 'favorite', id, JSON.stringify(isFav));
}

export function setNotes(db: Database, id: string, notes: string | null): void {
  run(db, 'UPDATE tweets SET user_notes = ? WHERE id = ?', [notes, id]);
  recordMutation(db, 'notes', id, JSON.stringify(notes ?? null));
}

export function totalTweetCount(db: Database): number {
  return scalar<number>(db, 'SELECT COUNT(*) FROM tweets') ?? 0;
}

export function filteredTweetCount(db: Database, filters: FilterSet): number {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  return (
    scalar<number>(
      db,
      `SELECT COUNT(*) FROM tweets t ${joinSql} WHERE ${whereSql}`,
      params,
    ) ?? 0
  );
}

export function earliestTweetTime(db: Database): number | null {
  return scalar<number>(db, 'SELECT MIN(created_at) FROM tweets');
}

export function latestTweetTime(db: Database): number | null {
  return scalar<number>(db, 'SELECT MAX(created_at) FROM tweets');
}

// Per-year tweet counts, keyed by calendar year (local time). Used by the
// date-range picker's year drill-down to annotate each year with its volume.
export function tweetCountByYear(db: Database): Map<number, number> {
  const rows = all<{ y: string; c: number }>(
    db,
    "SELECT strftime('%Y', created_at, 'unixepoch') AS y, COUNT(*) AS c FROM tweets GROUP BY y",
  );
  const map = new Map<number, number>();
  for (const r of rows) {
    if (r.y != null) map.set(Number(r.y), Number(r.c));
  }
  return map;
}
