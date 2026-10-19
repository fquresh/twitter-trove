import { describe, it, expect } from 'vitest';
import {
  filtersFromParams,
  paramsFromFilters,
  clearFiltersFromParams,
} from '../filters/urlSync';
import { emptyFilterSet } from '../filters/types';
import { startOfDayUnix, endOfDayUnix } from '../lib/dateParse';

describe('filtersFromParams / paramsFromFilters', () => {
  it('round-trips a date range preserving end-of-day on `to`', () => {
    const f = emptyFilterSet();
    f.from = startOfDayUnix(2024, 0, 2); // 2024-01-02 local midnight
    f.to = endOfDayUnix(2024, 2, 9); // 2024-03-09 local end-of-day
    const sp = paramsFromFilters(f);
    const restored = filtersFromParams(sp);
    expect(restored.from).toBe(f.from);
    expect(restored.to).toBe(f.to);
    expect(sp.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sp.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('omits from/to when they are null', () => {
    const sp = paramsFromFilters(emptyFilterSet());
    expect(sp.get('from')).toBeNull();
    expect(sp.get('to')).toBeNull();
  });

  it('round-trips the article flag and omits it when off', () => {
    const f = emptyFilterSet();
    f.article = true;
    const sp = paramsFromFilters(f);
    expect(sp.get('article')).toBe('1');
    expect(filtersFromParams(sp).article).toBe(true);

    const off = paramsFromFilters(emptyFilterSet());
    expect(off.get('article')).toBeNull();
    expect(filtersFromParams(off).article).toBe(false);
  });
});

describe('clearFiltersFromParams', () => {
  it('removes filter-owned params while preserving non-filter params', () => {
    const sp = new URLSearchParams({
      from: '2024-01-01',
      to: '2024-01-31',
      q: 'hello',
      favorite: '1',
      article: '1',
      session: 'abc123',
      ref: 'dashboard',
    });
    const cleared = clearFiltersFromParams(sp);
    expect(cleared.get('session')).toBe('abc123');
    expect(cleared.get('ref')).toBe('dashboard');
    expect(cleared.get('from')).toBeNull();
    expect(cleared.get('to')).toBeNull();
    expect(cleared.get('q')).toBeNull();
    expect(cleared.get('favorite')).toBeNull();
    expect(cleared.get('article')).toBeNull();
  });

  it('returns an empty params when only filter-owned params are present', () => {
    const sp = new URLSearchParams({
      from: '2024-01-01',
      to: '2024-01-31',
      cat: 'Crypto',
    });
    const cleared = clearFiltersFromParams(sp);
    expect([...cleared.entries()]).toEqual([]);
  });
});
