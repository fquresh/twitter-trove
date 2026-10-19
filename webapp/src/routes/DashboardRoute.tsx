import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import {
  categoryBreakdown,
  entityTrends,
  timeSeries,
  topAccounts,
  tweetStats,
  type TimeSeriesPoint,
} from '../db/queries/analytics';
import { TimeSeriesChart } from '../components/TimeSeriesChart';
import { CategoryBreakdown } from '../components/CategoryBreakdown';
import { TopAccountsTable } from '../components/TopAccountsTable';
import { EntityTrends } from '../components/EntityTrends';
import { MobileDotList } from '../components/MobileDotList';
import { MobileStatGrid } from '../components/MobileStatGrid';
import { BarSkeleton } from '../components/LoadingSkeleton';
import { filtersFromParams, paramsFromFilters } from '../filters/urlSync';
import { isEmptyFilterSet } from '../filters/types';
import { bucketBounds } from '../lib/time';
import { useUiStore } from '../state/uiStore';
import { useIsMobile } from '../lib/useIsMobile';
import type { Granularity, TimeField } from '../filters/types';
import { formatNumber } from '../lib/format';

export function DashboardRoute() {
  const handle = useDb();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const entityTab = useUiStore((s) => s.entityTab);
  const setEntityTab = useUiStore((s) => s.setEntityTab);
  const isMobile = useIsMobile();

  const statsQ = useQuery({
    queryKey: ['stats', params.toString()],
    queryFn: () => tweetStats(handle.db, filters),
  });

  const tsQ = useQuery({
    queryKey: ['ts', params.toString()],
    queryFn: () => timeSeries(handle.db, filters),
  });
  const catQ = useQuery({
    queryKey: ['cat', params.toString()],
    queryFn: () => categoryBreakdown(handle.db, filters, 20),
  });
  const accQ = useQuery({
    queryKey: ['acc', params.toString()],
    queryFn: () => topAccounts(handle.db, filters, 15),
  });
  const entQ = useQuery({
    queryKey: ['ent', params.toString(), entityTab],
    queryFn: () => entityTrends(handle.db, filters, entityTab, 8),
  });

  const onDrillDown = (bucket: TimeSeriesPoint) => {
    const bounds = bucketBounds(bucket.bucket, filters.granularity);
    if (!bounds) return;
    const next = { ...filters, from: bounds.from, to: bounds.to };
    setParams(paramsFromFilters(next));
  };

  const setGranularity = (g: Granularity) =>
    setParams(paramsFromFilters({ ...filters, granularity: g }));
  const setTimeField = (t: TimeField) =>
    setParams(paramsFromFilters({ ...filters, timeField: t }));

  // Dashboard widget clicks pivot to /tweets with the chosen entity layered
  // onto the current filter set. This is the "I clicked because I want to see
  // the actual tweets" flow. The chart drill-down (time bucket) is the one
  // exception below - narrowing time is part of dashboard exploration, so
  // it stays put.
  const pivotToTweets = (next: typeof filters) => {
    navigate({ pathname: '/tweets', search: paramsFromFilters(next).toString() });
  };
  const addCategory = (name: string) =>
    pivotToTweets({
      ...filters,
      categories: [...new Set([...filters.categories, name])],
    });
  const addAccount = (handle: string) =>
    pivotToTweets({
      ...filters,
      authors: [...new Set([...filters.authors, handle])],
    });
  const addEntity = (value: string) => {
    const next = { ...filters };
    if (entityTab === 'ticker') next.tickers = [...new Set([...filters.tickers, value.toUpperCase()])];
    if (entityTab === 'hashtag') next.hashtags = [...new Set([...filters.hashtags, value.toLowerCase()])];
    if (entityTab === 'mention') next.mentions = [...new Set([...filters.mentions, value.toLowerCase().replace(/^@/, '')])];
    pivotToTweets(next);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="h-display">Dashboard</h1>
          <p className="text-sm text-ink-500 dark:text-ink-300">
            Reflects your filters.{' '}
            <span className="hidden md:inline">
              Click a chart bar to drill the time window; click an account,
              category, or entity to jump straight to those tweets.
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(() => {
            const count = tsQ.data
              ? tsQ.data.reduce((s, p) => s + p.count, 0)
              : null;
            const filtered = !isEmptyFilterSet(filters);
            const label =
              count === null
                ? 'View tweets →'
                : `View ${formatNumber(count)} ${filtered ? 'matching' : ''} tweets →`.replace(/\s+/g, ' ');
            return (
              <button
                type="button"
                onClick={() =>
                  navigate({
                    pathname: '/tweets',
                    search: paramsFromFilters(filters).toString(),
                  })
                }
                disabled={count === 0}
                title={
                  filtered
                    ? 'See the tweets matching your current filters'
                    : 'Open the full tweet list'
                }
                className={`min-h-9 rounded-full px-4 py-1.5 text-xs font-semibold shadow-soft transition-colors disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 ${
                  filtered
                    ? 'bg-accent-600 text-white hover:bg-accent-700'
                    : 'border border-canvas-300 bg-white text-ink-800 hover:border-accent-300 hover:bg-accent-50 dark:border-white/10 dark:bg-white/5 dark:text-ink-100 dark:hover:bg-white/10'
                }`}
              >
                {label}
              </button>
            );
          })()}
          <div className="inline-flex overflow-hidden rounded-full border border-canvas-300 bg-white p-0.5 text-xs dark:border-white/10 dark:bg-transparent">
            {(['year', 'month', 'week', 'day'] as Granularity[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGranularity(g)}
                className={`min-h-9 rounded-full px-3 py-1 font-medium transition-colors md:min-h-0 ${
                  filters.granularity === g
                    ? 'bg-accent-600 text-white shadow-soft'
                    : 'bg-transparent text-ink-600 hover:bg-canvas-150 dark:text-ink-200 dark:hover:bg-white/5'
                }`}
              >
                {g}
              </button>
            ))}
          </div>
          <div className="inline-flex overflow-hidden rounded-full border border-canvas-300 bg-white p-0.5 text-xs dark:border-white/10 dark:bg-transparent">
            <button
              type="button"
              onClick={() => setTimeField('liked_at')}
              className={`min-h-9 rounded-full px-3 py-1 font-medium transition-colors md:min-h-0 ${
                filters.timeField === 'liked_at'
                  ? 'bg-accent-600 text-white shadow-soft'
                  : 'bg-transparent text-ink-600 hover:bg-canvas-150 dark:text-ink-200 dark:hover:bg-white/5'
              }`}
              title="Best-effort proxy for liked_at; falls back to the tweet creation time."
            >
              liked_at
            </button>
            <button
              type="button"
              onClick={() => setTimeField('created_at')}
              className={`min-h-9 rounded-full px-3 py-1 font-medium transition-colors md:min-h-0 ${
                filters.timeField === 'created_at'
                  ? 'bg-accent-600 text-white shadow-soft'
                  : 'bg-transparent text-ink-600 hover:bg-canvas-150 dark:text-ink-200 dark:hover:bg-white/5'
              }`}
            >
              created_at
            </button>
          </div>
        </div>
      </header>

      {isMobile && <MobileStatGrid stats={statsQ.data} timeFieldLabel={filters.timeField} />}

      <section className="card p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
          <div className="text-xs text-ink-500 dark:text-ink-300">
            {tsQ.data
              ? `${tsQ.data.reduce((s, p) => s + p.count, 0).toLocaleString()} tweets over ${tsQ.data.length} bucket${tsQ.data.length === 1 ? '' : 's'}`
              : ''}
          </div>
        </div>
        {tsQ.isLoading || !tsQ.data ? (
          <BarSkeleton />
        ) : (
          <TimeSeriesChart
            data={tsQ.data}
            granularity={filters.granularity}
            onDrillDown={onDrillDown}
          />
        )}
      </section>

      {isMobile ? (
        <div className="space-y-3">
          {catQ.isLoading || !catQ.data ? (
            <BarSkeleton />
          ) : (
            <MobileDotList
              title="Top categories"
              data={catQ.data.map((c) => ({
                id: String(c.id),
                name: c.name,
                count: c.count,
                color: c.color,
              }))}
              total={statsQ.data?.total ?? 0}
              onSelect={addCategory}
            />
          )}
          {accQ.isLoading || !accQ.data ? (
            <BarSkeleton />
          ) : (
            <MobileDotList
              title="Top accounts"
              data={accQ.data.map((a) => ({
                id: a.handle,
                name: a.display_name ?? a.handle,
                count: a.count,
                pct: a.pct,
              }))}
              total={statsQ.data?.total ?? 0}
              onSelect={addAccount}
            />
          )}
        </div>
      ) : (
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="card p-6">
            <h2 className="mb-4 text-lg font-semibold tracking-tight">Top categories</h2>
            {catQ.isLoading || !catQ.data ? (
              <BarSkeleton />
            ) : (
              <CategoryBreakdown data={catQ.data} onSelect={addCategory} />
            )}
          </div>
          <div className="card p-6">
            <h2 className="mb-4 text-lg font-semibold tracking-tight">Top accounts</h2>
            {accQ.isLoading || !accQ.data ? (
              <BarSkeleton />
            ) : (
              <TopAccountsTable data={accQ.data} onSelect={addAccount} />
            )}
          </div>
        </section>
      )}

      <section className="card p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Entity trends</h2>
          <div className="inline-flex overflow-hidden rounded-full border border-canvas-300 bg-white p-0.5 text-xs dark:border-white/10 dark:bg-transparent">
            {(['ticker', 'hashtag', 'mention'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setEntityTab(t)}
                className={`min-h-9 rounded-full px-3 py-1 font-medium transition-colors md:min-h-0 ${
                  entityTab === t
                    ? 'bg-accent-600 text-white shadow-soft'
                    : 'bg-transparent text-ink-600 hover:bg-canvas-150 dark:text-ink-200 dark:hover:bg-white/5'
                }`}
              >
                {t}s
              </button>
            ))}
          </div>
        </div>
        {entQ.isLoading || !entQ.data ? (
          <BarSkeleton />
        ) : (
          <EntityTrends data={entQ.data} onSelect={addEntity} />
        )}
      </section>
    </div>
  );
}
