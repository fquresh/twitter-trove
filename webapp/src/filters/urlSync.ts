import { emptyFilterSet, type FilterSet, type Granularity, type TimeField } from './types';

// URL <-> FilterSet. We keep the URL canonical: the store derives filters from
// the URL, and mutations update the URL. Values default-omit so shared URLs
// stay short.

/** Query params owned by the filter system. Used when preserving non-filter
 * params (e.g. session ids) across mutations. */
export const FILTER_PARAM_KEYS = [
  'from',
  'to',
  'cat',
  'author',
  'ticker',
  'hashtag',
  'mention',
  'minLikes',
  'minRetweets',
  'favorite',
  'thread',
  'article',
  'q',
  'timeField',
  'g',
];

function parseUnixSeconds(s: string | null, role: 'from' | 'to'): number | null {
  if (!s) return null;
  // Accept YYYY-MM-DD or raw unix seconds. For the `to` boundary, anchor to
  // 23:59:59 so the user-typed end date is *inclusive* - otherwise a saved
  // range like to=2024-01-15 silently drops tweets liked after midnight of
  // that day on every URL round-trip.
  if (/^\d+$/.test(s)) return Number(s);
  const suffix = role === 'from' ? 'T00:00:00' : 'T23:59:59.999';
  const t = Date.parse(s + suffix);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function formatDate(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function filtersFromParams(sp: URLSearchParams): FilterSet {
  const base = emptyFilterSet();
  base.from = parseUnixSeconds(sp.get('from'), 'from');
  base.to = parseUnixSeconds(sp.get('to'), 'to');
  base.categories = sp.getAll('cat');
  base.authors = sp.getAll('author');
  base.tickers = sp.getAll('ticker').map((t) => t.toUpperCase());
  base.hashtags = sp.getAll('hashtag').map((t) => t.toLowerCase());
  base.mentions = sp.getAll('mention').map((t) => t.toLowerCase());

  const minLikes = sp.get('minLikes');
  if (minLikes !== null && minLikes !== '') base.minLikes = Number(minLikes);
  const minRT = sp.get('minRetweets');
  if (minRT !== null && minRT !== '') base.minRetweets = Number(minRT);

  base.favorite = sp.get('favorite') === '1';
  base.thread = sp.get('thread') === '1';
  base.article = sp.get('article') === '1';
  const q = sp.get('q');
  base.q = q && q.trim() !== '' ? q : null;

  const tf = sp.get('timeField');
  if (tf === 'created_at' || tf === 'liked_at') base.timeField = tf;
  const g = sp.get('g');
  if (g === 'year' || g === 'month' || g === 'week' || g === 'day') base.granularity = g;

  return base;
}

/** Build a new URLSearchParams containing only the params that are not owned
 * by the filter system, so non-filter state (session ids, etc.) survives a
 * "clear all" action. */
export function clearFiltersFromParams(sp: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  for (const [k, v] of sp.entries()) {
    if (!FILTER_PARAM_KEYS.includes(k)) next.append(k, v);
  }
  return next;
}

export function paramsFromFilters(f: FilterSet): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.from !== null) sp.set('from', formatDate(f.from));
  if (f.to !== null) sp.set('to', formatDate(f.to));
  for (const c of f.categories) sp.append('cat', c);
  for (const a of f.authors) sp.append('author', a);
  for (const t of f.tickers) sp.append('ticker', t);
  for (const h of f.hashtags) sp.append('hashtag', h);
  for (const m of f.mentions) sp.append('mention', m);
  if (f.minLikes !== null) sp.set('minLikes', String(f.minLikes));
  if (f.minRetweets !== null) sp.set('minRetweets', String(f.minRetweets));
  if (f.favorite) sp.set('favorite', '1');
  if (f.thread) sp.set('thread', '1');
  if (f.article) sp.set('article', '1');
  if (f.q && f.q.trim() !== '') sp.set('q', f.q);
  if (f.timeField !== 'liked_at') sp.set('timeField', f.timeField);
  if (f.granularity !== 'month') sp.set('g', f.granularity);
  return sp;
}

export function withDateRange(f: FilterSet, from: number, to: number): FilterSet {
  return { ...f, from, to };
}

export function withGranularity(f: FilterSet, g: Granularity): FilterSet {
  return { ...f, granularity: g };
}

export function withTimeField(f: FilterSet, t: TimeField): FilterSet {
  return { ...f, timeField: t };
}
