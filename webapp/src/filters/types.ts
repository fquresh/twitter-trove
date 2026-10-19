// Filter types shared by URL-sync, the query builder, and the UI.
//
// Semantics (documented here so the query builder and UI agree):
// - Categories: AND (a tweet must have ALL selected categories).
// - Authors: OR (a tweet has a single author, so multi-select is a set).
// - Entities within a type (ticker/hashtag/mention): AND within the type.
//   Across types, AND (the tweet must contain at least one match from each type).
// - Engagement thresholds: inclusive, i.e. like_count >= minLikes.

export type TimeField = 'liked_at' | 'created_at';
export type Granularity = 'year' | 'month' | 'week' | 'day';

export interface FilterSet {
  /** Unix seconds; tweets with the chosen timeField >= from. */
  from: number | null;
  /** Unix seconds; tweets with the chosen timeField <= to (inclusive). */
  to: number | null;
  categories: string[];
  authors: string[];
  tickers: string[];
  hashtags: string[];
  mentions: string[];
  minLikes: number | null;
  minRetweets: number | null;
  favorite: boolean;
  thread: boolean;
  /** When true, restrict to X long-form article posts (t.is_article = 1). */
  article: boolean;
  q: string | null;
  timeField: TimeField;
  /** Preferred bucket granularity for the time-series chart. */
  granularity: Granularity;
}

export const emptyFilterSet = (): FilterSet => ({
  from: null,
  to: null,
  categories: [],
  authors: [],
  tickers: [],
  hashtags: [],
  mentions: [],
  minLikes: null,
  minRetweets: null,
  favorite: false,
  thread: false,
  article: false,
  q: null,
  timeField: 'liked_at',
  granularity: 'month',
});

export function isEmptyFilterSet(f: FilterSet): boolean {
  return (
    f.from === null &&
    f.to === null &&
    f.categories.length === 0 &&
    f.authors.length === 0 &&
    f.tickers.length === 0 &&
    f.hashtags.length === 0 &&
    f.mentions.length === 0 &&
    f.minLikes === null &&
    f.minRetweets === null &&
    !f.favorite &&
    !f.thread &&
    !f.article &&
    (f.q === null || f.q.trim() === '')
  );
}
