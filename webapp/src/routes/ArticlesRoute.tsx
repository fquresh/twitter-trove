import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import { listTweetsPage } from '../db/queries/tweets';
import { filtersFromParams } from '../filters/urlSync';
import { ArticleCard } from '../components/ArticleCard';
import { EmptyState } from '../components/EmptyState';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { useUiStore } from '../state/uiStore';

// The Articles section is the tweets list scoped to X long-form articles
// (is_article = 1). It composes the global filter system rather than
// duplicating it: date range / search / author filters from the URL still
// apply on top of the forced article flag.
export function ArticlesRoute() {
  const handle = useDb();
  const [params] = useSearchParams();
  const pageSize = useUiStore((s) => s.pageSize);
  const [page, setPage] = useState(1);

  const filters = useMemo(() => ({ ...filtersFromParams(params), article: true }), [params]);

  const query = useQuery({
    queryKey: ['articles-list', params.toString(), page, pageSize],
    queryFn: () => listTweetsPage(handle.db, filters, page, pageSize, 'liked_desc'),
  });

  const total = query.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="h-display">Articles</h1>
        <p className="text-sm text-ink-500 dark:text-ink-300">
          {query.isLoading
            ? 'Loading…'
            : `${total.toLocaleString()} long-form ${total === 1 ? 'article' : 'articles'}`}
        </p>
      </header>

      <section>
        {query.isLoading ? (
          <LoadingSkeleton rows={Math.min(10, pageSize)} />
        ) : total === 0 ? (
          <EmptyState
            title="No articles detected yet"
            hint="Article posts are flagged at collection time by the browser extension (v1.1+). Re-collect your likes with the updated extension, then re-import or hit ⟳ to populate this page."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {query.data!.rows.map((t) => (
              <ArticleCard key={t.id} tweet={t} />
            ))}
          </div>
        )}
      </section>

      {total > 0 && lastPage > 1 && (
        <nav className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-500 dark:text-ink-300">
          <div>
            Page {page} of {lastPage}
          </div>
          <div className="flex flex-wrap gap-2">
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
          </div>
        </nav>
      )}
    </div>
  );
}
