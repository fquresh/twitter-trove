import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import { topAccounts } from '../db/queries/analytics';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { EmptyState } from '../components/EmptyState';
import { filtersFromParams, paramsFromFilters } from '../filters/urlSync';
import { isEmptyFilterSet } from '../filters/types';
import { useUiStore } from '../state/uiStore';
import { formatNumber } from '../lib/format';

const LIMIT_OPTIONS = [25, 50, 100] as const;

export function AccountsRoute() {
  const handle = useDb();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const filtered = !isEmptyFilterSet(filters);

  const limit = useUiStore((s) => s.accountsLimit);
  const setLimit = useUiStore((s) => s.setAccountsLimit);

  const accQ = useQuery({
    queryKey: ['accounts', params.toString(), limit],
    queryFn: () => topAccounts(handle.db, filters, limit),
  });

  // Layer the chosen author onto the current filters and jump to /tweets - the
  // "show me this account's tweets" flow, matching DashboardRoute.addAccount.
  const openAccount = (author: string) => {
    const next = {
      ...filters,
      authors: [...new Set([...filters.authors, author])],
    };
    navigate({ pathname: '/tweets', search: paramsFromFilters(next).toString() });
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="h-display">Accounts</h1>
          <p className="text-sm text-ink-500 dark:text-ink-300">
            Most-liked accounts{filtered ? ' in the current filter' : ''}, by liked-tweet
            count. Click a card to see their tweets; the @handle opens x.com.
          </p>
        </div>
        <div className="inline-flex overflow-hidden rounded-full border border-canvas-300 bg-white p-0.5 text-xs dark:border-white/10 dark:bg-transparent">
          {LIMIT_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setLimit(n)}
              className={`min-h-9 rounded-full px-3 py-1 font-medium transition-colors md:min-h-0 ${
                limit === n
                  ? 'bg-accent-600 text-white shadow-soft'
                  : 'bg-transparent text-ink-600 hover:bg-canvas-150 dark:text-ink-200 dark:hover:bg-white/5'
              }`}
            >
              Top {n}
            </button>
          ))}
        </div>
      </header>

      {accQ.isPending ? (
        <LoadingSkeleton rows={9} />
      ) : accQ.data && accQ.data.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accQ.data.map((a) => {
            const bare = a.handle.replace(/^@/, '');
            return (
              <button
                key={a.handle}
                type="button"
                onClick={() => openAccount(a.handle)}
                className="card group flex flex-col gap-2 p-4 text-left transition-colors hover:border-accent-300 hover:bg-accent-50/50 dark:hover:bg-white/[0.04]"
                title={`See ${formatNumber(a.count)} saved tweets from ${a.display_name ?? a.handle}`}
              >
                <div className="min-w-0">
                  <div className="line-clamp-2 break-words font-medium text-ink-900 dark:text-ink-50">
                    {a.display_name ?? `@${bare}`}
                  </div>
                  <a
                    href={`https://x.com/${bare}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-xs text-ink-500 hover:text-accent-600 hover:underline dark:text-ink-300 dark:hover:text-accent-400"
                    title="Open on x.com"
                  >
                    @{bare}
                  </a>
                </div>
                <div className="mt-1 flex items-baseline justify-between">
                  <div className="text-2xl font-semibold tabular-nums text-ink-900 dark:text-ink-50">
                    {formatNumber(a.count)}
                    <span className="ml-1 text-xs font-normal text-ink-500 dark:text-ink-300">
                      liked
                    </span>
                  </div>
                  <div className="text-xs tabular-nums text-ink-500 dark:text-ink-300">
                    {a.pct}% share
                  </div>
                </div>
                <div className="text-xs tabular-nums text-ink-400 dark:text-ink-400">
                  {formatNumber(a.avg_likes)} avg ♥
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title={filtered ? 'No accounts match' : 'No accounts yet'}
          hint={filtered ? 'Adjust the active filters to see more accounts.' : 'Import HTML files to populate the archive.'}
        />
      )}
    </div>
  );
}
