import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import {
  bulkAssignToFiltered,
  deleteManualCategory,
  listCategories,
  recolorCategory,
  renameCategory,
  upsertCategory,
} from '../db/queries/categories';
import { filtersFromParams } from '../filters/urlSync';
import { scalar } from '../db/exec';
import { buildFilterFragments } from '../filters/queryBuilder';
import { RowSkeleton } from '../components/LoadingSkeleton';
import { EmptyState } from '../components/EmptyState';

export function CategoriesRoute() {
  const handle = useDb();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);

  const categoriesQ = useQuery({
    queryKey: ['categories-list'],
    queryFn: () => listCategories(handle.db),
  });

  const filteredCountQ = useQuery({
    queryKey: ['filtered-count', params.toString()],
    queryFn: () => {
      const { whereSql, joinSql, params: p } = buildFilterFragments(filters);
      return (
        scalar<number>(
          handle.db,
          `SELECT COUNT(*) FROM tweets t ${joinSql} WHERE ${whereSql}`,
          p,
        ) ?? 0
      );
    },
  });

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#06b6d4');
  const [bulkCategoryId, setBulkCategoryId] = useState<number | null>(null);

  const createMut = useMutation({
    mutationFn: async () => {
      if (!newName.trim()) return;
      upsertCategory(handle.db, newName.trim(), 'manual', newColor);
      handle.markDirty();
      await handle.flush();
    },
    onSuccess: () => {
      setNewName('');
      queryClient.invalidateQueries({ queryKey: ['categories-list'] });
    },
  });

  const renameMut = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      renameCategory(handle.db, id, name);
      handle.markDirty();
      await handle.flush();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['categories-list'] }),
  });

  const recolorMut = useMutation({
    mutationFn: async ({ id, color }: { id: number; color: string }) => {
      recolorCategory(handle.db, id, color);
      handle.markDirty();
      await handle.flush();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['categories-list'] }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      deleteManualCategory(handle.db, id);
      handle.markDirty();
      await handle.flush();
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const bulkMut = useMutation({
    mutationFn: async () => {
      if (bulkCategoryId === null) return 0;
      const inserted = bulkAssignToFiltered(handle.db, bulkCategoryId, filters);
      handle.markDirty();
      await handle.flush();
      return inserted;
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="h-display">Categories</h1>
        <p className="text-sm text-ink-500 dark:text-ink-300">
          Classifier-sourced categories come from <code className="font-mono">categorized_tweets.json</code> re-imports.
          Manual categories are yours. Renaming and recoloring work on both.
          Deletion is allowed only for manual categories so re-imports don't resurrect classifier rows.
        </p>
      </header>

      <section className="card space-y-3 p-5">
        <h2 className="text-lg font-semibold">Create manual category</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-full sm:w-64"
            placeholder="Name (e.g. Worth re-reading)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="h-11 w-12 cursor-pointer rounded-md border border-white/10 bg-transparent md:h-9"
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!newName.trim()}
            onClick={() => createMut.mutate()}
          >
            Create
          </button>
        </div>
      </section>

      <section className="card space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Bulk-assign to current filter</h2>
          <div className="text-xs text-ink-500 dark:text-ink-300">
            {filteredCountQ.data ?? 0} tweet(s) match
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input w-full sm:w-80"
            value={bulkCategoryId ?? ''}
            onChange={(e) =>
              setBulkCategoryId(e.target.value === '' ? null : Number(e.target.value))
            }
          >
            <option value="">- choose a category -</option>
            {(categoriesQ.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.source})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-outline"
            disabled={bulkCategoryId === null || (filteredCountQ.data ?? 0) === 0}
            onClick={() => bulkMut.mutate()}
          >
            Assign to {filteredCountQ.data ?? 0} tweets
          </button>
          {bulkMut.data !== undefined && (
            <span className="text-xs text-ink-500 dark:text-ink-300">+{bulkMut.data} new assignments</span>
          )}
        </div>
      </section>

      {categoriesQ.isPending ? (
        <RowSkeleton rows={8} />
      ) : (categoriesQ.data ?? []).length === 0 ? (
        <EmptyState
          title="No categories yet"
          hint="Create a manual category above, or import categorized_tweets.json to load classifier categories."
        />
      ) : (
      <section className="card overflow-x-auto p-0">
        <table className="w-full min-w-[32rem] text-sm">
          <thead className="bg-canvas-100 text-xs uppercase tracking-wide text-ink-500 dark:bg-white/[0.03] dark:text-ink-300">
            <tr>
              <th className="px-3 py-2 text-left">Color</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-right">Tweets</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(categoriesQ.data ?? []).map((c) => (
              <tr key={c.id} className="border-t border-canvas-200 hover:bg-canvas-100 dark:border-white/5 dark:hover:bg-white/[0.03]">
                <td className="px-3 py-2">
                  <input
                    type="color"
                    value={c.color ?? '#06b6d4'}
                    onChange={(e) => recolorMut.mutate({ id: c.id, color: e.target.value })}
                    className="h-8 w-10 cursor-pointer rounded border border-white/10 bg-transparent md:h-6 md:w-8"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    className="input w-full"
                    defaultValue={c.name}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== c.name) renameMut.mutate({ id: c.id, name: v });
                    }}
                  />
                </td>
                <td className="px-3 py-2 text-ink-500 dark:text-ink-300">{c.source}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {(c.tweet_count ?? 0).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right">
                  {c.source === 'manual' ? (
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete "${c.name}"? This will remove all user assignments. (${
                              c.tweet_count ?? 0
                            } tweets)`,
                          )
                        )
                          deleteMut.mutate(c.id);
                      }}
                    >
                      Delete
                    </button>
                  ) : (
                    <span className="text-xs text-ink-400">classifier</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      )}
    </div>
  );
}
