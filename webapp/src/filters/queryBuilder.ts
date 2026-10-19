import type { SqlValue } from 'sql.js';
import type { FilterSet } from './types';

// Produces SQL fragments that select tweet ids matching a FilterSet.
//
// Returns:
//   - `whereSql`: the WHERE body (no leading WHERE keyword).
//   - `joinSql`: any JOINs that must sit in the FROM clause alongside `tweets t`.
//   - `params`: positional parameters in order.
//
// Consumer queries wrap this in their own SELECT + ORDER + LIMIT.
//
// Why EXISTS instead of JOIN-with-HAVING-COUNT for categories?
//   - Short-circuit evaluation: SQLite can bail as soon as a tweet fails one
//     category. A GROUP BY + HAVING pass computes every tweet's category count
//     first.
//   - The EXISTS form stays readable with N categories.

export interface BuiltQuery {
  whereSql: string;
  joinSql: string;
  params: SqlValue[];
}

export function buildFilterFragments(f: FilterSet): BuiltQuery {
  const where: string[] = [];
  const params: SqlValue[] = [];
  let joinSql = '';

  // Time range: always applied against the chosen time field.
  const timeCol = f.timeField === 'created_at' ? 't.created_at' : 't.liked_at';
  if (f.from !== null) {
    where.push(`${timeCol} >= ?`);
    params.push(f.from);
  }
  if (f.to !== null) {
    where.push(`${timeCol} <= ?`);
    params.push(f.to);
  }

  // Engagement.
  if (f.minLikes !== null && f.minLikes > 0) {
    where.push(`t.like_count >= ?`);
    params.push(f.minLikes);
  }
  if (f.minRetweets !== null && f.minRetweets > 0) {
    where.push(`t.retweet_count >= ?`);
    params.push(f.minRetweets);
  }

  // Flags.
  if (f.favorite) where.push(`t.is_favorite = 1`);
  if (f.thread) where.push(`t.is_thread = 1`);
  // Tri-state: NULL means the row predates article-aware capture, so only
  // rows positively identified as articles match.
  if (f.article) where.push(`t.is_article = 1`);

  // Authors: OR across the set (a tweet can only have one author).
  if (f.authors.length > 0) {
    const placeholders = f.authors.map(() => '?').join(', ');
    where.push(`t.author_handle IN (${placeholders})`);
    for (const a of f.authors) params.push(a);
  }

  // Categories: AND across the set (tweet must have all of them).
  for (const cat of f.categories) {
    where.push(
      `EXISTS (SELECT 1 FROM tweet_categories tc JOIN categories c ON c.id = tc.category_id WHERE tc.tweet_id = t.id AND c.name = ?)`,
    );
    params.push(cat);
  }

  // Entities: AND across the entire entity set, but type is encoded per-entity.
  // For 'ticker', we uppercase to match how we normalize on insert.
  const entityFilters: Array<{ type: 'ticker' | 'hashtag' | 'mention'; value: string }> = [
    ...f.tickers.map((v) => ({ type: 'ticker' as const, value: v.toUpperCase() })),
    ...f.hashtags.map((v) => ({ type: 'hashtag' as const, value: v.toLowerCase() })),
    ...f.mentions.map((v) => ({ type: 'mention' as const, value: v.toLowerCase() })),
  ];
  for (const ent of entityFilters) {
    where.push(
      `EXISTS (SELECT 1 FROM tweet_entities te JOIN entities e ON e.id = te.entity_id WHERE te.tweet_id = t.id AND e.type = ? AND e.value = ?)`,
    );
    params.push(ent.type, ent.value);
  }

  // Full-text search: joins with the FTS table. We use MATCH which wants a
  // single query string; we also sanitize the input (strip FTS operators) and
  // wrap each term with "*" for prefix search. FTS4 uses `docid` to refer to
  // the parent rowid.
  if (f.q && f.q.trim() !== '') {
    joinSql = `JOIN tweets_fts ON tweets_fts.docid = t.rowid`;
    where.push(`tweets_fts MATCH ?`);
    params.push(sanitizeFtsQuery(f.q.trim()));
  }

  return {
    whereSql: where.length > 0 ? where.join(' AND ') : '1=1',
    joinSql,
    params,
  };
}

// FTS5 MATCH grammar is strict. We build a conservative expression from the
// user input: quote each token to avoid interpreting as operators, and append
// `*` for prefix search so partial words hit.
export function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"*`).join(' ');
}
