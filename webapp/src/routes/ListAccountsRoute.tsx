import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import { all } from '../db/exec';
import { paramsFromFilters } from '../filters/urlSync';
import { emptyFilterSet } from '../filters/types';
import { LIST_ACCOUNTS, LIST_NAMES, normalizeHandle } from '../lib/listAccounts';
import { formatNumber } from '../lib/format';
import { EmptyState } from '../components/EmptyState';

interface DbAccount {
  raw: string;
  count: number;
}

interface DisplayAccount {
  handle: string;
  lists: string[];
  norm: string;
  raw: string;
  count: number;
  inDb: boolean;
}

export function ListAccountsRoute() {
  const handle = useDb();
  const navigate = useNavigate();
  const [selectedLists, setSelectedLists] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const dbQ = useQuery({
    queryKey: ['list-accounts-db'],
    queryFn: () => {
      const rows = all<{ author_handle: string; count: number }>(
        handle.db,
        'SELECT author_handle, COUNT(*) AS count FROM tweets GROUP BY author_handle',
      );
      const map = new Map<string, DbAccount>();
      for (const r of rows) {
        const norm = normalizeHandle(r.author_handle);
        if (!map.has(norm)) {
          map.set(norm, { raw: r.author_handle, count: r.count });
        }
      }
      return map;
    },
  });

  const dbMap = dbQ.data ?? new Map<string, DbAccount>();

  const displayed = useMemo<DisplayAccount[]>(() => {
    const q = search.trim().toLowerCase();
    return LIST_ACCOUNTS
      .map((a) => {
        const norm = normalizeHandle(a.handle);
        const db = dbMap.get(norm);
        return {
          ...a,
          norm,
          raw: db?.raw ?? a.handle,
          count: db?.count ?? 0,
          inDb: !!db,
        };
      })
      .filter((a) => {
        if (selectedLists.length > 0 && !selectedLists.some((l) => a.lists.includes(l))) {
          return false;
        }
        if (q === '') return true;
        return (
          a.handle.toLowerCase().includes(q) ||
          a.lists.some((l) => l.toLowerCase().includes(q))
        );
      });
  }, [selectedLists, search, dbMap]);

  const toggleList = (name: string) => {
    setSelectedLists((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
    );
    setSelected(new Set());
  };

  const toggleAccount = (norm: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(norm)) next.delete(norm);
      else next.add(norm);
      return next;
    });
  };

  const selectAllVisible = () => {
    const next = new Set(selected);
    for (const a of displayed) {
      if (a.inDb) next.add(a.norm);
    }
    setSelected(next);
  };

  const clearSelected = () => setSelected(new Set());

  const selectedRaw = useMemo(() => {
    const handles: string[] = [];
    for (const norm of selected) {
      const db = dbMap.get(norm);
      if (db) handles.push(db.raw);
    }
    return handles;
  }, [selected, dbMap]);

  const viewTweets = () => {
    if (selectedRaw.length === 0) return;
    const filters = emptyFilterSet();
    filters.authors = selectedRaw;
    navigate({ pathname: '/tweets', search: paramsFromFilters(filters).toString() });
  };

  const selectedCount = selectedRaw.length;

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3">
        <div>
          <h1 className="h-display">List Accounts</h1>
          <p className="text-sm text-ink-500 dark:text-ink-300">
            {LIST_ACCOUNTS.length} accounts across {LIST_NAMES.length} lists.
            Filter by list or account, then view their tweets.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <input
            className="input"
            placeholder="Search accounts or lists"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {LIST_NAMES.map((name) => {
              const active = selectedLists.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleList(name)}
                  className={`chip ${
                    active
                      ? 'border-accent-500 bg-accent-100 text-accent-800 dark:border-accent-400 dark:bg-accent-500/20 dark:text-accent-100'
                      : ''
                  }`}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-ink-500 dark:text-ink-300">
          {displayed.length} shown
          {selectedCount > 0 && ` · ${selectedCount} selected`}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-outline text-xs" onClick={selectAllVisible}>
            Select all shown
          </button>
          <button
            type="button"
            className="btn-destructive text-xs"
            onClick={clearSelected}
            disabled={selected.size === 0}
          >
            Clear selection
          </button>
        </div>
      </div>

      {displayed.length === 0 ? (
        <EmptyState title="No accounts match" hint="Try a different list or search term." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {displayed.map((a) => {
            const isSelected = selected.has(a.norm);
            return (
              <button
                key={a.norm}
                type="button"
                onClick={() => toggleAccount(a.norm)}
                className={`card group flex flex-col gap-3 p-4 text-left transition-colors ${
                  isSelected
                    ? 'border-accent-500 bg-accent-50/60 dark:border-accent-400 dark:bg-accent-500/10'
                    : ''
                }`}
                disabled={!a.inDb}
                title={a.inDb ? 'Toggle selection' : 'No saved tweets from this account yet'}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div
                      className={`truncate font-medium ${
                        a.inDb ? 'text-ink-900 dark:text-ink-50' : 'text-ink-400'
                      }`}
                    >
                      {a.handle}
                    </div>
                    <div className="text-xs text-ink-500 dark:text-ink-300">
                      {a.inDb ? `${formatNumber(a.count)} liked` : 'Not in archive'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <a
                      href={`https://x.com/${a.handle.replace(/^@/, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-ink-500 hover:text-accent-600 hover:underline dark:text-ink-300 dark:hover:text-accent-400"
                      title="Open on x.com"
                    >
                      x.com
                    </a>
                    {isSelected && (
                      <span className="text-sm text-accent-600 dark:text-accent-300">✓</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {a.lists.map((l) => (
                    <span
                      key={l}
                      className="rounded-full border border-canvas-300 bg-canvas-100 px-2 py-0.5 text-[10px] text-ink-600 dark:border-white/10 dark:bg-white/5 dark:text-ink-300"
                    >
                      {l}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="sticky bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 flex justify-end md:bottom-4">
          <button
            type="button"
            className="btn-primary shadow-lg"
            onClick={viewTweets}
          >
            View tweets from {selectedCount} account{selectedCount === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </div>
  );
}
