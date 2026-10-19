import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import { getTweetById, listTweetsPage } from '../db/queries/tweets';
import { all } from '../db/exec';
import { filtersFromParams, paramsFromFilters } from '../filters/urlSync';
import { TweetCard } from '../components/TweetCard';
import { TweetSelectionBar } from '../components/TweetSelectionBar';
import { useUiStore } from '../state/uiStore';
import { EmptyState } from '../components/EmptyState';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import type { CategoryRow } from '../db/queries/categories';

interface CategoryRowLite extends CategoryRow {
  tweet_id: string;
}

export function TweetsRoute() {
  const handle = useDb();
  const [params, setParams] = useSearchParams();
  const pageSize = useUiStore((s) => s.pageSize);
  const setPageSize = useUiStore((s) => s.setPageSize);

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const targetTweetId = params.get('id');
  // Set by in-app links (chat sources) so the pinned card can offer a direct
  // way back to the originating view.
  const location = useLocation();
  const navigate = useNavigate();
  const backTo = (location.state as { from?: string; fromLabel?: string } | null) ?? null;
  const backLink =
    backTo?.from && targetTweetId ? (
      <button
        type="button"
        className="inline-flex min-h-8 items-center gap-1 font-medium underline underline-offset-2"
        onClick={() => navigate(backTo.from!)}
      >
        ← Back to {backTo.fromLabel ?? 'previous view'}
      </button>
    ) : null;
  const [page, setPage] = useState(1);
  const [orderBy, setOrderBy] = useState<'liked_desc' | 'created_desc' | 'created_asc'>(
    'liked_desc',
  );
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState(filters.q ?? '');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // Live-search (debounced via submit on enter) - we keep the URL as source.
  const submitSearch = () => {
    const next = { ...filters, q: search.trim() === '' ? null : search };
    setParams(paramsFromFilters(next));
    setPage(1);
  };

  const query = useQuery({
    queryKey: ['tweet-list', params.toString(), page, pageSize, orderBy],
    queryFn: () => listTweetsPage(handle.db, filters, page, pageSize, orderBy),
  });

  // Pinned tweet (deep-link from chat citation, e.g. /tweets?id=1234567890).
  const pinnedQuery = useQuery({
    enabled: !!targetTweetId,
    queryKey: ['pinned-tweet', targetTweetId],
    queryFn: () => (targetTweetId ? getTweetById(handle.db, targetTweetId) : null),
  });

  // Scroll to and briefly highlight the pinned card when it lands.
  useEffect(() => {
    if (!targetTweetId) return;
    setHighlightedId(targetTweetId);
    const t = setTimeout(() => {
      const node = cardRefs.current.get(targetTweetId);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    const clear = setTimeout(() => setHighlightedId(null), 2500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [targetTweetId]);

  const clearPin = () => {
    const next = new URLSearchParams(params);
    next.delete('id');
    setParams(next);
  };

  const categoriesByTweet = useQuery({
    enabled: !!query.data && query.data.rows.length > 0,
    queryKey: ['tweet-categories', query.data?.rows.map((r) => r.id).join(',')],
    queryFn: () => {
      const ids = query.data!.rows.map((r) => r.id);
      if (ids.length === 0) return new Map<string, CategoryRow[]>();
      const placeholders = ids.map(() => '?').join(', ');
      const rows = all<CategoryRowLite>(
        handle.db,
        `SELECT c.id, c.name, c.color, c.source, c.created_at, tc.tweet_id
         FROM tweet_categories tc
         JOIN categories c ON c.id = tc.category_id
         WHERE tc.tweet_id IN (${placeholders})
         ORDER BY c.name ASC`,
        ids,
      );
      const map = new Map<string, CategoryRow[]>();
      for (const r of rows) {
        const list = map.get(r.tweet_id) ?? [];
        const { tweet_id: _drop, ...cat } = r;
        void _drop;
        list.push(cat);
        map.set(r.tweet_id, list);
      }
      return map;
    },
  });

  const toggleSelect = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectPage = () => {
    if (!query.data) return;
    const pageIds = query.data.rows.map((r) => r.id);
    const allOn = pageIds.every((id) => selection.has(id));
    setSelection((prev) => {
      const next = new Set(prev);
      if (allOn) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  // Esc clears the selection - a tiny but durable affordance.
  useEffect(() => {
    if (selection.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setSelection(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection.size]);

  const total = query.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="h-display">Tweets</h1>
          <p className="text-sm text-ink-500 dark:text-ink-300">
            {query.isLoading ? 'Loading…' : `${total.toLocaleString()} matching`}
          </p>
        </div>
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:overflow-visible">
          <input
            className="input min-w-[12rem] flex-1 sm:w-64 md:w-80"
            placeholder="Search tweets, authors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch();
            }}
          />
          <button type="button" className="btn-outline" onClick={submitSearch}>
            Search
          </button>
          <select
            className="input w-32 shrink-0"
            value={orderBy}
            onChange={(e) => setOrderBy(e.target.value as typeof orderBy)}
          >
            <option value="liked_desc">Newest liked</option>
            <option value="created_desc">Newest tweet</option>
            <option value="created_asc">Oldest tweet</option>
          </select>
          <select
            className="input w-24 shrink-0"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[25, 50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n}/page
              </option>
            ))}
          </select>
        </div>
      </header>

      <TweetSelectionBar
        selection={selection}
        pageRows={query.data?.rows ?? []}
        onClear={() => setSelection(new Set())}
        onSelectPage={selectPage}
        resolveTweet={(id) =>
          (pinnedQuery.data && pinnedQuery.data.id === id ? pinnedQuery.data : undefined) ??
          query.data?.rows.find((r) => r.id === id)
        }
      />

      {targetTweetId && pinnedQuery.data && (
        <section className="rounded-md border border-accent-500/40 bg-accent-500/5 p-3">
          <div className="mb-2 flex items-center justify-between gap-3 text-xs text-accent-800 dark:text-accent-200">
            {backLink}
            <span className="mr-auto">Pinned from chat citation</span>
            <button type="button" className="inline-flex min-h-8 items-center underline" onClick={clearPin}>
              clear
            </button>
          </div>
          <div
            ref={(el) => {
              if (el) cardRefs.current.set(pinnedQuery.data!.id, el);
              else cardRefs.current.delete(pinnedQuery.data!.id);
            }}
            className={`transition-shadow ${
              highlightedId === pinnedQuery.data.id
                ? 'rounded-lg shadow-[0_0_0_3px_rgba(99,102,241,0.7)]'
                : ''
            }`}
          >
            <TweetCard
              tweet={pinnedQuery.data}
              categories={[]}
              filters={filters}
              selected={selection.has(pinnedQuery.data.id)}
              onToggleSelect={toggleSelect}
            />
          </div>
        </section>
      )}
      {targetTweetId && pinnedQuery.isFetched && !pinnedQuery.data && (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-yellow-700/50 dark:bg-yellow-900/20 dark:text-yellow-200">
          Cited tweet (id <code>{targetTweetId}</code>) not found in this archive.
          {backLink && <span className="ml-3">{backLink}</span>}
          <button type="button" className="ml-3 inline-flex min-h-8 items-center underline" onClick={clearPin}>
            clear
          </button>
        </section>
      )}

      <section>
        {query.isLoading ? (
          <LoadingSkeleton rows={Math.min(10, pageSize)} />
        ) : total === 0 ? (
          <EmptyState
            title="No tweets match"
            hint="Adjust the active filters or import more HTML files."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {query.data!.rows.map((t) => (
              <div
                key={t.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(t.id, el);
                  else cardRefs.current.delete(t.id);
                }}
                className={`transition-shadow ${
                  highlightedId === t.id
                    ? 'rounded-lg shadow-[0_0_0_3px_rgba(99,102,241,0.7)]'
                    : ''
                }`}
              >
                <TweetCard
                  tweet={t}
                  categories={categoriesByTweet.data?.get(t.id) ?? []}
                  filters={filters}
                  selected={selection.has(t.id)}
                  onToggleSelect={toggleSelect}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {total > 0 && (
        <nav className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-500 dark:text-ink-300">
          <div>
            Page {page} of {lastPage}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(1)}
              className="btn-outline px-3 py-1.5 text-xs disabled:opacity-50 md:px-4 md:py-2 md:text-sm"
            >
              « first
            </button>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="btn-outline px-3 py-1.5 text-xs disabled:opacity-50 md:px-4 md:py-2 md:text-sm"
            >
              ‹ prev
            </button>
            <button
              type="button"
              disabled={page >= lastPage}
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              className="btn-outline px-3 py-1.5 text-xs disabled:opacity-50 md:px-4 md:py-2 md:text-sm"
            >
              next ›
            </button>
            <button
              type="button"
              disabled={page >= lastPage}
              onClick={() => setPage(lastPage)}
              className="btn-outline px-3 py-1.5 text-xs disabled:opacity-50 md:px-4 md:py-2 md:text-sm"
            >
              last »
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
