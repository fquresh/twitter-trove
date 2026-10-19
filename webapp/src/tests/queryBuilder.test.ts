import { describe, it, expect } from 'vitest';
import { buildFilterFragments, sanitizeFtsQuery } from '../filters/queryBuilder';
import { emptyFilterSet } from '../filters/types';
import { filtersFromParams, paramsFromFilters } from '../filters/urlSync';

describe('buildFilterFragments', () => {
  it('returns the no-op WHERE for empty filters', () => {
    const { whereSql, joinSql, params } = buildFilterFragments(emptyFilterSet());
    expect(whereSql).toBe('1=1');
    expect(joinSql).toBe('');
    expect(params).toEqual([]);
  });

  it('applies the timeField toggle to the date range', () => {
    const f = emptyFilterSet();
    f.from = 1000;
    f.to = 2000;
    f.timeField = 'created_at';
    const out = buildFilterFragments(f);
    expect(out.whereSql).toContain('t.created_at >= ?');
    expect(out.whereSql).toContain('t.created_at <= ?');
    expect(out.params).toEqual([1000, 2000]);
  });

  it('emits one EXISTS clause per category (AND semantics)', () => {
    const f = emptyFilterSet();
    f.categories = ['Crypto > AI', 'Trading > Quantitative'];
    const { whereSql, params } = buildFilterFragments(f);
    const matches = whereSql.match(/EXISTS \(SELECT 1 FROM tweet_categories/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(params).toEqual(['Crypto > AI', 'Trading > Quantitative']);
  });

  it('treats authors as OR via IN()', () => {
    const f = emptyFilterSet();
    f.authors = ['alice', 'bob'];
    const { whereSql, params } = buildFilterFragments(f);
    expect(whereSql).toContain('t.author_handle IN (?, ?)');
    expect(params).toEqual(['alice', 'bob']);
  });

  it('normalizes ticker case and emits an EXISTS per entity', () => {
    const f = emptyFilterSet();
    f.tickers = ['btc'];
    f.hashtags = ['CRYPTO'];
    f.mentions = ['OrrinVasquez'];
    const { whereSql, params } = buildFilterFragments(f);
    expect(whereSql.match(/EXISTS \(SELECT 1 FROM tweet_entities/g) ?? []).toHaveLength(3);
    // ticker uppercased, hashtag/mention lowercased
    expect(params).toEqual([
      'ticker', 'BTC',
      'hashtag', 'crypto',
      'mention', 'orrinvasquez',
    ]);
  });

  it('joins tweets_fts and emits MATCH when q is set', () => {
    const f = emptyFilterSet();
    f.q = 'hello world';
    const { whereSql, joinSql } = buildFilterFragments(f);
    expect(joinSql).toBe('JOIN tweets_fts ON tweets_fts.docid = t.rowid');
    expect(whereSql).toContain('tweets_fts MATCH ?');
  });

  it('restricts to known articles when the article flag is set', () => {
    const f = emptyFilterSet();
    f.article = true;
    const { whereSql, params } = buildFilterFragments(f);
    expect(whereSql).toContain('t.is_article = 1');
    expect(params).toEqual([]);
  });

  it('leaves is_article out of the WHERE when the article flag is off', () => {
    const { whereSql } = buildFilterFragments(emptyFilterSet());
    expect(whereSql).not.toContain('is_article');
  });

  it('skips engagement predicates when threshold is zero or null', () => {
    const f = emptyFilterSet();
    f.minLikes = 0;
    const { whereSql } = buildFilterFragments(f);
    expect(whereSql).not.toContain('like_count');
  });

  it('flags favorite and thread filters', () => {
    const f = emptyFilterSet();
    f.favorite = true;
    f.thread = true;
    const { whereSql } = buildFilterFragments(f);
    expect(whereSql).toContain('t.is_favorite = 1');
    expect(whereSql).toContain('t.is_thread = 1');
  });
});

describe('sanitizeFtsQuery', () => {
  it('wraps tokens in quotes and adds prefix wildcard', () => {
    expect(sanitizeFtsQuery('bitcoin ETF')).toBe('"bitcoin"* "ETF"*');
  });
  it('strips FTS operator-like quotes', () => {
    expect(sanitizeFtsQuery('"NOT" valid')).toBe('"NOT"* "valid"*');
  });
  it('defaults empty query to a no-match', () => {
    expect(sanitizeFtsQuery('    ')).toBe('""');
  });
});

describe('URL sync', () => {
  it('round-trips a populated filter set', () => {
    const f = emptyFilterSet();
    f.from = 1700000000;
    f.to = 1710000000;
    f.categories = ['Crypto > AI'];
    f.authors = ['jack'];
    f.tickers = ['BTC'];
    f.hashtags = ['crypto'];
    f.mentions = ['tobias_quill'];
    f.minLikes = 100;
    f.minRetweets = 10;
    f.favorite = true;
    f.thread = true;
    f.q = 'hello';
    f.timeField = 'created_at';
    f.granularity = 'week';

    const sp = paramsFromFilters(f);
    const restored = filtersFromParams(new URLSearchParams(sp.toString()));
    expect(restored.categories).toEqual(f.categories);
    expect(restored.tickers).toEqual(f.tickers);
    expect(restored.hashtags).toEqual(f.hashtags);
    expect(restored.mentions).toEqual(f.mentions);
    expect(restored.favorite).toBe(true);
    expect(restored.thread).toBe(true);
    expect(restored.q).toBe('hello');
    expect(restored.timeField).toBe('created_at');
    expect(restored.granularity).toBe('week');
    expect(restored.minLikes).toBe(100);
    expect(restored.minRetweets).toBe(10);
    // Dates round-trip via YYYY-MM-DD so they're snapped to midnight local.
    expect(restored.from).not.toBeNull();
    expect(restored.to).not.toBeNull();
  });

  it('omits defaults from the URL', () => {
    const f = emptyFilterSet();
    const sp = paramsFromFilters(f);
    expect(sp.toString()).toBe('');
  });
});
