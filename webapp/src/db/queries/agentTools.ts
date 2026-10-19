// Typed wrappers behind the chat agent's SQL tools. Each function is
// invoked from src/chat/tools.ts after argument validation. They return
// JSON-serializable shapes so the assistant can consume them as tool results.
//
// Reuse the existing helpers wherever possible:
//   - listTweetsPage, getTweetById        (queries/tweets.ts)
//   - topAccounts, categoryBreakdown      (queries/analytics.ts)
//   - buildFilterFragments                (filters/queryBuilder.ts)

import type { Database } from 'sql.js';
import { all, scalar } from '../exec';
import { buildFilterFragments } from '../../filters/queryBuilder';
import type { FilterSet } from '../../filters/types';
import { emptyFilterSet } from '../../filters/types';
import { getTweetById, listTweetsPage } from './tweets';
import { topAccounts, categoryBreakdown } from './analytics';

export interface AgentFilterInput {
  categories?: string[];
  authors?: string[];
  tickers?: string[];
  hashtags?: string[];
  mentions?: string[];
  from_date?: string;
  to_date?: string;
}

export function applyAgentFilters(
  base: FilterSet,
  input: AgentFilterInput | undefined,
): FilterSet {
  const f: FilterSet = { ...base };
  if (!input) return f;
  if (input.categories?.length) f.categories = [...input.categories];
  if (input.authors?.length) f.authors = [...input.authors];
  if (input.tickers?.length) f.tickers = input.tickers.map((t) => t.toUpperCase());
  if (input.hashtags?.length) f.hashtags = input.hashtags.map((h) => h.toLowerCase());
  if (input.mentions?.length) f.mentions = input.mentions.map((m) => m.toLowerCase());
  if (input.from_date) {
    const t = parseLooseDate(input.from_date, 'start');
    if (t !== null) f.from = t;
  }
  if (input.to_date) {
    const t = parseLooseDate(input.to_date, 'end');
    if (t !== null) f.to = t;
  }
  return f;
}

// Accepts ISO dates/datetimes, year-only "2024", quarter "2024-Q4", and
// year-month "2024-03". `role` makes the bound inclusive at the right edge of
// the period: a 'start' bound returns the period's first instant; an 'end'
// bound returns its LAST instant. This matters because the filter applies
// `created_at <= to` - so `to_date: '2024'` must resolve to Dec-31 23:59:59,
// not Jan-1 (which would exclude the whole year). Mirrors urlSync.parseUnixSeconds.
export function parseLooseDate(s: string, role: 'start' | 'end' = 'start'): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  const sec = (ms: number) => Math.floor(ms / 1000);
  const lastInstant = (msExclusiveEnd: number) => sec(msExclusiveEnd - 1);

  // Check the coarse-grained patterns BEFORE Date.parse so role semantics apply
  // regardless of how the engine parses a bare year / year-month.

  // YYYY
  const yMatch = /^(\d{4})$/.exec(trimmed);
  if (yMatch) {
    const y = Number(yMatch[1]);
    return role === 'end' ? lastInstant(Date.UTC(y + 1, 0, 1)) : sec(Date.UTC(y, 0, 1));
  }
  // YYYY-Qn
  const qMatch = /^(\d{4})-Q([1-4])$/i.exec(trimmed);
  if (qMatch) {
    const y = Number(qMatch[1]);
    const month = (Number(qMatch[2]) - 1) * 3;
    return role === 'end' ? lastInstant(Date.UTC(y, month + 3, 1)) : sec(Date.UTC(y, month, 1));
  }
  // YYYY-MM
  const ymMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (ymMatch) {
    const y = Number(ymMatch[1]);
    const m = Number(ymMatch[2]) - 1;
    return role === 'end' ? lastInstant(Date.UTC(y, m + 1, 1)) : sec(Date.UTC(y, m, 1));
  }
  // ISO date (YYYY-MM-DD) or full datetime.
  const isoTs = Date.parse(trimmed);
  if (!Number.isNaN(isoTs)) {
    // A date-only string as an 'end' bound means end-of-that-day; a full
    // datetime is used as the exact instant.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    if (role === 'end' && dateOnly) return lastInstant(isoTs + 86_400_000);
    return sec(isoTs);
  }
  return null;
}

export interface CountResult {
  count: number;
  by_category?: Array<{ name: string; count: number }>;
  filters_applied: AgentFilterInput;
}

export function countTweets(
  db: Database,
  base: FilterSet,
  input: AgentFilterInput | undefined,
  byCategory = false,
): CountResult {
  const filters = applyAgentFilters(base, input);
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  const count = scalar<number>(
    db,
    `SELECT COUNT(*) FROM tweets t ${joinSql} WHERE ${whereSql}`,
    params,
  ) ?? 0;
  const out: CountResult = { count, filters_applied: input ?? {} };
  if (byCategory && count > 0) {
    out.by_category = categoryBreakdown(db, filters, 25).map((c) => ({
      name: c.name,
      count: c.count,
    }));
  }
  return out;
}

export interface TopAuthorRow {
  handle: string;
  display_name: string | null;
  n_tweets: number;
  avg_likes: number;
}

export function topAuthors(
  db: Database,
  base: FilterSet,
  input: AgentFilterInput | undefined,
  limit = 10,
): TopAuthorRow[] {
  const filters = applyAgentFilters(base, input);
  return topAccounts(db, filters, limit).map((r) => ({
    handle: r.handle,
    display_name: r.display_name,
    n_tweets: r.count,
    avg_likes: r.avg_likes,
  }));
}

export interface TweetRowSummary {
  id: string;
  handle: string;
  display_name: string | null;
  text: string;
  created_at: number;
  liked_at: number;
  like_count: number;
  retweet_count: number;
  link: string | null;
  categories: string[];
}

function summarizeRow(db: Database, row: {
  id: string; author_handle: string; author_display_name: string | null;
  content: string; created_at: number; liked_at: number;
  like_count: number; retweet_count: number; link: string | null;
}): TweetRowSummary {
  const cats = all<{ name: string }>(
    db,
    `SELECT c.name FROM tweet_categories tc
     JOIN categories c ON c.id = tc.category_id
     WHERE tc.tweet_id = ?`,
    [row.id],
  ).map((r) => r.name);
  return {
    id: row.id,
    handle: row.author_handle,
    display_name: row.author_display_name,
    text: row.content,
    created_at: row.created_at,
    liked_at: row.liked_at,
    like_count: row.like_count,
    retweet_count: row.retweet_count,
    link: row.link,
    categories: cats,
  };
}

export function tweetsInPeriod(
  db: Database,
  base: FilterSet,
  startIso: string,
  endIso: string,
  input: AgentFilterInput | undefined,
  limit = 20,
): TweetRowSummary[] {
  const start = parseLooseDate(startIso, 'start');
  const end = parseLooseDate(endIso, 'end');
  if (start === null || end === null) return [];
  const filters = applyAgentFilters(base, input);
  filters.from = start;
  filters.to = end;
  const page = listTweetsPage(db, filters, 1, limit, 'liked_desc');
  return page.rows.map((r) => summarizeRow(db, r));
}

export interface TweetWithEnrichments extends TweetRowSummary {
  url_enrichments: Array<{ source_ref: string; content: string }>;
  image_enrichments: Array<{ source_ref: string; content: string; model: string | null }>;
}

export function getTweetWithEnrichments(
  db: Database,
  id: string,
): TweetWithEnrichments | null {
  const row = getTweetById(db, id);
  if (!row) return null;
  const summary = summarizeRow(db, row);
  const urlRows = all<{ source_ref: string; content: string }>(
    db,
    `SELECT source_ref, content FROM enrichments
     WHERE tweet_id = ? AND type = 'url_content'
     ORDER BY created_at DESC`,
    [id],
  );
  const imgRows = all<{ source_ref: string; content: string; model: string | null }>(
    db,
    `SELECT source_ref, content, model FROM enrichments
     WHERE tweet_id = ? AND type = 'image_description'
     ORDER BY created_at DESC`,
    [id],
  );
  return {
    ...summary,
    url_enrichments: urlRows,
    image_enrichments: imgRows,
  };
}

// Used by the chat agent to format the pre-fetch context block. Looks up
// whatever metadata exists about the hits - handle, text, date, likes,
// categories, and any URL/image enrichment content.
export function fetchHitsForContextBlock(
  db: Database,
  ids: string[],
): TweetWithEnrichments[] {
  const out: TweetWithEnrichments[] = [];
  for (const id of ids) {
    const t = getTweetWithEnrichments(db, id);
    if (t) out.push(t);
  }
  return out;
}

// Re-export emptyFilterSet to keep the agent's tool dispatcher self-contained.
export { emptyFilterSet };
