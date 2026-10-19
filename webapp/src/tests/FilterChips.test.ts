import { describe, it, expect } from 'vitest';
import { chipListForFilters } from '../filters/FilterChips';
import { emptyFilterSet } from '../filters/types';

describe('chipListForFilters', () => {
  it('returns an empty array for an empty filter set', () => {
    expect(chipListForFilters(emptyFilterSet())).toEqual([]);
  });

  it('emits a date chip for a from/to range', () => {
    const f = emptyFilterSet();
    f.from = 1704153600; // 2024-01-02 00:00:00 UTC
    f.to = 1710025199; // roughly 2024-03-09
    const chips = chipListForFilters(f);
    const dateChip = chips.find((c) => c.key === 'date');
    expect(dateChip).toBeDefined();
    expect(dateChip!.label).toContain('→');
  });

  it('emits a one-sided date chip when only from is set', () => {
    const f = emptyFilterSet();
    f.from = 1704153600;
    const chips = chipListForFilters(f);
    expect(chips.find((c) => c.key === 'date')?.label).toMatch(/^From /);
  });

  it('emits a one-sided date chip when only to is set', () => {
    const f = emptyFilterSet();
    f.to = 1706745599;
    const chips = chipListForFilters(f);
    expect(chips.find((c) => c.key === 'date')?.label).toMatch(/^Through /);
  });

  it('emits category, author, ticker, hashtag, and mention chips', () => {
    const f = emptyFilterSet();
    f.categories = ['Crypto > AI'];
    f.authors = ['ada_fieldstone'];
    f.tickers = ['BTC'];
    f.hashtags = ['ai'];
    f.mentions = ['jhalvorsen'];
    const chips = chipListForFilters(f);
    expect(chips.map((c) => c.key)).toEqual([
      'cat:Crypto > AI',
      'author:ada_fieldstone',
      'ticker:BTC',
      'hash:ai',
      'mention:jhalvorsen',
    ]);
  });

  it('emits engagement threshold chips', () => {
    const f = emptyFilterSet();
    f.minLikes = 100;
    f.minRetweets = 10;
    const chips = chipListForFilters(f);
    expect(chips.find((c) => c.key === 'minLikes')?.label).toBe('≥ 100 likes');
    expect(chips.find((c) => c.key === 'minRetweets')?.label).toBe('≥ 10 RT');
  });

  it('emits favorite, thread, and article chips', () => {
    const f = emptyFilterSet();
    f.favorite = true;
    f.thread = true;
    f.article = true;
    const chips = chipListForFilters(f);
    expect(chips.map((c) => c.key)).toContain('fav');
    expect(chips.map((c) => c.key)).toContain('thread');
    expect(chips.map((c) => c.key)).toContain('article');
  });

  it('emits a search query chip', () => {
    const f = emptyFilterSet();
    f.q = 'openai';
    const chips = chipListForFilters(f);
    expect(chips[0].label).toBe('“openai”');
  });
});
