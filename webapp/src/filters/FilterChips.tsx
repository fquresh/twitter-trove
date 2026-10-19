import { useSearchParams } from 'react-router-dom';
import type { FilterSet } from './types';
import { clearFiltersFromParams, paramsFromFilters } from './urlSync';
import { formatDate } from '../lib/format';

export interface ChipDef {
  key: string;
  label: string;
}

/** Pure helper: returns the active filter chips that should be displayed.
 * Used by both the UI and tests. */
export function chipListForFilters(filters: FilterSet): ChipDef[] {
  const chips: ChipDef[] = [];

  if (filters.from !== null || filters.to !== null) {
    const f = filters.from !== null ? formatDate(filters.from) : '…';
    const t = filters.to !== null ? formatDate(filters.to) : '…';
    let label: string;
    if (filters.from !== null && filters.to === null) label = `From ${f}`;
    else if (filters.from === null && filters.to !== null) label = `Through ${t}`;
    else label = `${f} → ${t}`;
    chips.push({ key: 'date', label });
  }

  for (const c of filters.categories) {
    chips.push({ key: 'cat:' + c, label: `Category: ${c}` });
  }
  for (const a of filters.authors) {
    chips.push({ key: 'author:' + a, label: `@${a}` });
  }
  for (const t of filters.tickers) {
    chips.push({ key: 'ticker:' + t, label: `$${t}` });
  }
  for (const h of filters.hashtags) {
    chips.push({ key: 'hash:' + h, label: `#${h}` });
  }
  for (const m of filters.mentions) {
    chips.push({ key: 'mention:' + m, label: `@${m} (mentioned)` });
  }
  if (filters.minLikes !== null && filters.minLikes > 0) {
    chips.push({ key: 'minLikes', label: `≥ ${filters.minLikes} likes` });
  }
  if (filters.minRetweets !== null && filters.minRetweets > 0) {
    chips.push({ key: 'minRetweets', label: `≥ ${filters.minRetweets} RT` });
  }
  if (filters.favorite) {
    chips.push({ key: 'fav', label: 'Favorites' });
  }
  if (filters.thread) {
    chips.push({ key: 'thread', label: 'Threads' });
  }
  if (filters.article) {
    chips.push({ key: 'article', label: 'Articles' });
  }
  if (filters.q) {
    chips.push({ key: 'q', label: `“${filters.q}”` });
  }

  return chips;
}

export function FilterChips({ filters }: { filters: FilterSet }) {
  const [params, setParams] = useSearchParams();

  const remove = (mutator: (next: FilterSet) => FilterSet) => {
    const next = mutator({ ...filters });
    setParams(paramsFromFilters(next));
  };

  const clearAll = () => {
    setParams(clearFiltersFromParams(params));
  };

  const chips = chipListForFilters(filters);

  if (chips.length === 0) return null;

  return (
    <div
      className="chip-strip relative flex flex-nowrap items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:overflow-visible"
      style={{ touchAction: 'pan-y' }}
      data-testid="filter-chips"
    >
      {/* Clear all pinned at the start so it's always reachable on mobile */}
      <button
        type="button"
        onClick={clearAll}
        className="btn-destructive shrink-0 text-xs"
        data-testid="clear-all"
      >
        Clear all
      </button>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => remove(mutatorForKey(c.key))}
          className="chip max-w-[60vw] shrink-0 truncate md:max-w-none"
          title="Remove"
          data-testid={`chip-${c.key}`}
        >
          <span className="truncate">{c.label}</span>
          <span className="shrink-0 text-ink-400">×</span>
        </button>
      ))}
    </div>
  );
}

function mutatorForKey(key: string): (next: FilterSet) => FilterSet {
  if (key === 'date') {
    return (next) => ({ ...next, from: null, to: null });
  }
  if (key.startsWith('cat:')) {
    const name = key.slice(4);
    return (next) => ({ ...next, categories: next.categories.filter((x) => x !== name) });
  }
  if (key.startsWith('author:')) {
    const name = key.slice(7);
    return (next) => ({ ...next, authors: next.authors.filter((x) => x !== name) });
  }
  if (key.startsWith('ticker:')) {
    const name = key.slice(7);
    return (next) => ({ ...next, tickers: next.tickers.filter((x) => x !== name) });
  }
  if (key.startsWith('hash:')) {
    const name = key.slice(5);
    return (next) => ({ ...next, hashtags: next.hashtags.filter((x) => x !== name) });
  }
  if (key.startsWith('mention:')) {
    const name = key.slice(8);
    return (next) => ({ ...next, mentions: next.mentions.filter((x) => x !== name) });
  }
  if (key === 'minLikes') {
    return (next) => ({ ...next, minLikes: null });
  }
  if (key === 'minRetweets') {
    return (next) => ({ ...next, minRetweets: null });
  }
  if (key === 'fav') {
    return (next) => ({ ...next, favorite: false });
  }
  if (key === 'thread') {
    return (next) => ({ ...next, thread: false });
  }
  if (key === 'article') {
    return (next) => ({ ...next, article: false });
  }
  if (key === 'q') {
    return (next) => ({ ...next, q: null });
  }
  return (next) => next;
}
