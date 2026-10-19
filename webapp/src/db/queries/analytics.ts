import type { Database } from 'sql.js';
import { all, scalar } from '../exec';
import { buildFilterFragments } from '../../filters/queryBuilder';
import type { FilterSet, Granularity } from '../../filters/types';

// Time-series aggregation bucketed by the chosen granularity.
// Buckets are computed in local time using SQLite's strftime on a "unix"
// modifier + the user's offset; since sql.js runs in the browser we compute
// the offset from Date() and pass it as minutes.
//
// We use strftime to compute the bucket key, then GROUP BY that key. For
// efficiency we parameterize the bucket expression.

export interface TimeSeriesPoint {
  /** Bucket key: e.g. "2024-03" for a month bucket. */
  bucket: string;
  /** Unix seconds at the start of the bucket (UTC for stable sort). */
  start: number;
  count: number;
}

function bucketExpr(col: string, g: Granularity, tzOffsetMinutes: number): string {
  // Add the offset so dates group by the user's local day/month/year.
  const shifted = `datetime(${col} + ${-tzOffsetMinutes * 60}, 'unixepoch')`;
  switch (g) {
    case 'year':
      return `strftime('%Y', ${shifted})`;
    case 'month':
      return `strftime('%Y-%m', ${shifted})`;
    case 'week':
      // Sunday-start week.  Bucket key is the Sunday's YYYY-MM-DD; the chart
      // formats it as a "M/D-M/D 'YY" range.  We subtract dow days (0=Sun..6=Sat)
      // from the local date to land on the prior Sunday.
      return `strftime('%Y-%m-%d', datetime(${shifted}, '-' || strftime('%w', ${shifted}) || ' days'))`;
    case 'day':
    default:
      return `strftime('%Y-%m-%d', ${shifted})`;
  }
}

function bucketStartExpr(col: string, g: Granularity, tzOffsetMinutes: number): string {
  // Returns unix seconds for the UTC start of the bucket (so chart x-axis is
  // stable regardless of the viewer's TZ). We adjust the column's unixepoch
  // by the offset to compute the local-day boundaries, then use strftime to
  // truncate, then reverse the offset.
  const shifted = `(${col} + ${-tzOffsetMinutes * 60})`;
  const localDateTime = `datetime(${shifted}, 'unixepoch')`;
  const startOf = (() => {
    switch (g) {
      case 'year':
        return `datetime(strftime('%Y-01-01 00:00:00', ${localDateTime}))`;
      case 'month':
        return `datetime(strftime('%Y-%m-01 00:00:00', ${localDateTime}))`;
      case 'week':
        // Round down to Sunday in local time.  strftime('%w') gives
        // 0=Sunday..6=Saturday; subtracting that many days lands us on Sunday
        // 00:00 (or stays put if already Sunday).
        return `datetime(${localDateTime}, '-' || strftime('%w', ${localDateTime}) || ' days', 'start of day')`;
      case 'day':
      default:
        return `datetime(${localDateTime}, 'start of day')`;
    }
  })();
  return `CAST(strftime('%s', ${startOf}) AS INTEGER) + ${tzOffsetMinutes * 60}`;
}

export function timeSeries(
  db: Database,
  filters: FilterSet,
  tzOffsetMinutes: number = new Date().getTimezoneOffset(),
): TimeSeriesPoint[] {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  const col = filters.timeField === 'created_at' ? 't.created_at' : 't.liked_at';
  const key = bucketExpr(col, filters.granularity, tzOffsetMinutes);
  const startSec = bucketStartExpr(col, filters.granularity, tzOffsetMinutes);

  return all<TimeSeriesPoint>(
    db,
    `SELECT ${key} AS bucket,
            ${startSec} AS start,
            COUNT(*) AS count
     FROM tweets t ${joinSql}
     WHERE ${whereSql}
     GROUP BY bucket
     ORDER BY start ASC`,
    params,
  );
}

export interface CategoryCount {
  id: number;
  name: string;
  color: string | null;
  count: number;
}

export function categoryBreakdown(
  db: Database,
  filters: FilterSet,
  limit = 25,
): CategoryCount[] {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  return all<CategoryCount>(
    db,
    `SELECT c.id, c.name, c.color, COUNT(DISTINCT tc.tweet_id) AS count
     FROM tweet_categories tc
     JOIN categories c ON c.id = tc.category_id
     JOIN tweets t ON t.id = tc.tweet_id
     ${joinSql}
     WHERE ${whereSql}
     GROUP BY c.id
     ORDER BY count DESC, c.name ASC
     LIMIT ?`,
    [...params, limit],
  );
}

export interface AccountCount {
  handle: string;
  display_name: string | null;
  count: number;
  avg_likes: number;
  pct: number;
}

export function topAccounts(
  db: Database,
  filters: FilterSet,
  limit = 25,
): AccountCount[] {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);

  return all<AccountCount>(
    db,
    `WITH filtered AS (
       SELECT t.* FROM tweets t ${joinSql} WHERE ${whereSql}
     ),
     total AS (SELECT COUNT(*) AS n FROM filtered)
     SELECT f.author_handle AS handle,
            MAX(f.author_display_name) AS display_name,
            COUNT(*) AS count,
            CAST(AVG(f.like_count) AS INTEGER) AS avg_likes,
            ROUND(100.0 * COUNT(*) / NULLIF((SELECT n FROM total), 0), 2) AS pct
     FROM filtered f
     GROUP BY f.author_handle
     ORDER BY count DESC, handle ASC
     LIMIT ?`,
    [...params, limit],
  );
}

export interface EntityTrendPoint {
  bucket: string;
  start: number;
  value: string;
  count: number;
}

export interface TweetStats {
  total: number;
  thisMonth: number;
  favorites: number;
  authors: number;
}

export function tweetStats(db: Database, filters: FilterSet): TweetStats {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  const timeCol = filters.timeField === 'created_at' ? 't.created_at' : 't.liked_at';

  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const monthEnd = Math.floor(
    new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000 - 1,
  );

  const total =
    scalar<number>(db, `SELECT COUNT(*) FROM tweets t ${joinSql} WHERE ${whereSql}`, params) ?? 0;

  const thisMonth =
    scalar<number>(
      db,
      `SELECT COUNT(*) FROM tweets t ${joinSql} WHERE ${whereSql} AND ${timeCol} >= ? AND ${timeCol} <= ?`,
      [...params, monthStart, monthEnd],
    ) ?? 0;

  const favorites =
    scalar<number>(
      db,
      `SELECT COUNT(*) FROM tweets t ${joinSql} WHERE ${whereSql} AND t.is_favorite = 1`,
      params,
    ) ?? 0;

  const authors =
    scalar<number>(
      db,
      `SELECT COUNT(DISTINCT t.author_handle) FROM tweets t ${joinSql} WHERE ${whereSql}`,
      params,
    ) ?? 0;

  return { total, thisMonth, favorites, authors };
}

export function entityTrends(
  db: Database,
  filters: FilterSet,
  entityType: 'ticker' | 'hashtag' | 'mention',
  topN = 10,
  tzOffsetMinutes: number = new Date().getTimezoneOffset(),
): EntityTrendPoint[] {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  const col = filters.timeField === 'created_at' ? 't.created_at' : 't.liked_at';
  const key = bucketExpr(col, filters.granularity, tzOffsetMinutes);
  const startSec = bucketStartExpr(col, filters.granularity, tzOffsetMinutes);

  return all<EntityTrendPoint>(
    db,
    `WITH filtered AS (
       SELECT t.id, t.liked_at, t.created_at
       FROM tweets t ${joinSql} WHERE ${whereSql}
     ),
     counts AS (
       SELECT e.value AS value, COUNT(*) AS total
       FROM tweet_entities te
       JOIN entities e ON e.id = te.entity_id
       JOIN filtered t ON t.id = te.tweet_id
       WHERE e.type = ?
       GROUP BY e.value
       ORDER BY total DESC
       LIMIT ?
     )
     SELECT ${key} AS bucket,
            ${startSec} AS start,
            e.value AS value,
            COUNT(*) AS count
     FROM tweet_entities te
     JOIN entities e ON e.id = te.entity_id
     JOIN filtered t ON t.id = te.tweet_id
     WHERE e.type = ? AND e.value IN (SELECT value FROM counts)
     GROUP BY value, bucket
     ORDER BY start ASC, value ASC`,
    [...params, entityType, topN, entityType],
  );
}

export interface EntityCount {
  value: string;
  count: number;
}

export function topEntities(
  db: Database,
  filters: FilterSet,
  entityType: 'ticker' | 'hashtag' | 'mention',
  limit = 25,
): EntityCount[] {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  return all<EntityCount>(
    db,
    `SELECT e.value AS value, COUNT(*) AS count
     FROM tweet_entities te
     JOIN entities e ON e.id = te.entity_id
     JOIN tweets t ON t.id = te.tweet_id
     ${joinSql}
     WHERE ${whereSql} AND e.type = ?
     GROUP BY e.value
     ORDER BY count DESC, e.value ASC
     LIMIT ?`,
    [...params, entityType, limit],
  );
}
