// Floating action bar that appears at the top of /tweets whenever the user
// has selected one or more tweets. Houses the four bulk actions: Export
// (Obsidian-friendly .md), Star, Tag (with autocomplete popover), and Chat
// (pre-fills whichever chat surface is on screen with the selection's tweet
// IDs as citations).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDb } from '../lib/dbContext';
import { setFavorite } from '../db/queries/tweets';
import {
  assignUserCategory,
  listCategories,
  upsertCategory,
} from '../db/queries/categories';
import type { TweetRow } from '../db/queries/tweets';
import { exportTweetsToMarkdown, exportFilename } from '../lib/exportTweetsMd';
import { tweetUrl } from '../lib/tweetLinks';
import { useAskAgent } from './chat/useAskAgent';

interface Props {
  selection: Set<string>;
  /** Rows currently visible on the page - used for "Select all on page" and
   *  to resolve the export to the actual TweetRow objects. */
  pageRows: TweetRow[];
  onClear: () => void;
  onSelectPage: () => void;
  /** Optional resolver for tweets NOT on the current page (e.g. the pinned
   *  card). Falls back to pageRows.find. */
  resolveTweet?: (id: string) => TweetRow | undefined;
}

export function TweetSelectionBar({
  selection,
  pageRows,
  onClear,
  onSelectPage,
  resolveTweet,
}: Props) {
  const handle = useDb();
  const queryClient = useQueryClient();
  const askAgent = useAskAgent();
  const [flash, setFlash] = useState<string | null>(null);

  const selectedRows = useMemo(() => {
    const out: TweetRow[] = [];
    for (const id of selection) {
      const t =
        resolveTweet?.(id) ?? pageRows.find((r) => r.id === id);
      if (t) out.push(t);
    }
    return out;
  }, [selection, pageRows, resolveTweet]);

  const allOnPageSelected =
    pageRows.length > 0 && pageRows.every((r) => selection.has(r.id));

  // Auto-clear the flash message after a moment.
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const onExportMd = () => {
    if (selectedRows.length === 0) return;
    const md = exportTweetsToMarkdown(selectedRows);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilename(selectedRows.length);
    a.click();
    URL.revokeObjectURL(a.href);
    setFlash(`Exported ${selectedRows.length} to Markdown`);
    setExportOpen(false);
  };

  const onCopyUrls = async () => {
    if (selectedRows.length === 0) return;
    const urls = selectedRows.map(tweetUrl).join('\n');
    try {
      await navigator.clipboard.writeText(urls);
      setFlash(`Copied ${selectedRows.length} URL${selectedRows.length === 1 ? '' : 's'}`);
    } catch {
      setFlash('Could not copy to clipboard');
    }
    setExportOpen(false);
  };

  // ── Export menu ────────────────────────────────────────────────────────
  const [exportOpen, setExportOpen] = useState(false);
  const exportBtnRef = useRef<HTMLButtonElement | null>(null);
  const exportPopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (exportPopRef.current?.contains(t)) return;
      if (exportBtnRef.current?.contains(t)) return;
      setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [exportOpen]);

  const onChat = () => {
    if (selection.size === 0) return;
    const ids = Array.from(selection);
    const cites = ids.map((id) => `[^${id}]`).join(' ');
    const verb =
      ids.length === 1 ? 'this tweet' : `these ${ids.length} tweets`;
    askAgent(
      `What's the through-line in ${verb}? Summarize what I was saving these for, and call out any disagreements or recurring threads.\n\n${cites}`,
    );
  };

  // ── Star ───────────────────────────────────────────────────────────────
  // If every selected tweet is already favorited, toggle them all off.
  // Otherwise turn them all on. Predictable bulk semantics.
  const allStarred = selectedRows.length > 0 && selectedRows.every((r) => r.is_favorite === 1);
  const starMut = useMutation({
    mutationFn: async () => {
      const target = !allStarred;
      for (const r of selectedRows) {
        setFavorite(handle.db, r.id, target);
      }
      handle.markDirty();
      return { target, count: selectedRows.length };
    },
    onSuccess: ({ target, count }) => {
      queryClient.invalidateQueries();
      setFlash(target ? `Starred ${count}` : `Unstarred ${count}`);
    },
  });

  // ── Tag ────────────────────────────────────────────────────────────────
  const [tagOpen, setTagOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const tagPopRef = useRef<HTMLDivElement | null>(null);
  const tagBtnRef = useRef<HTMLButtonElement | null>(null);

  const catsQ = useQuery({
    enabled: tagOpen,
    queryKey: ['categories-list-for-tag-picker'],
    queryFn: () => listCategories(handle.db),
  });

  const tagMatches = useMemo(() => {
    const q = tagDraft.trim().toLowerCase();
    const all = catsQ.data ?? [];
    if (!q) return all.slice(0, 8);
    return all
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [catsQ.data, tagDraft]);

  const exactMatch = useMemo(() => {
    const q = tagDraft.trim().toLowerCase();
    return (catsQ.data ?? []).find((c) => c.name.toLowerCase() === q);
  }, [catsQ.data, tagDraft]);

  useEffect(() => {
    if (tagOpen) {
      // Defer to next frame so the input is mounted.
      requestAnimationFrame(() => tagInputRef.current?.focus());
    } else {
      setTagDraft('');
    }
  }, [tagOpen]);

  useEffect(() => {
    if (!tagOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (tagPopRef.current?.contains(t)) return;
      if (tagBtnRef.current?.contains(t)) return;
      setTagOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTagOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [tagOpen]);

  const applyTag = (name: string) => {
    const clean = name.trim();
    if (!clean || selectedRows.length === 0) return;
    const id = upsertCategory(handle.db, clean, 'manual');
    for (const r of selectedRows) {
      assignUserCategory(handle.db, r.id, id);
    }
    handle.markDirty();
    queryClient.invalidateQueries();
    setTagOpen(false);
    setFlash(`Tagged ${selectedRows.length} with "${clean}"`);
  };

  if (selection.size === 0) return null;

  return (
    <div className="sticky top-[5.5rem] z-10 -mx-1 mb-2">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-accent-300 bg-gradient-to-r from-accent-50 to-white px-3 py-2 shadow-soft dark:border-accent-500/40 dark:from-accent-500/15 dark:to-white/[0.02]">
        <div className="inline-flex items-center gap-2 pr-1">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-600 text-xs font-bold text-white shadow-soft">
            {selection.size}
          </span>
          <span className="text-xs font-medium text-ink-700 dark:text-ink-100">
            {selection.size === 1 ? 'tweet selected' : 'tweets selected'}
          </span>
        </div>

        <span className="hidden h-5 w-px bg-canvas-200 dark:bg-white/10 sm:block" />

        <div className="relative inline-block">
          <button
            ref={exportBtnRef}
            type="button"
            onClick={() => setExportOpen((o) => !o)}
            aria-expanded={exportOpen}
            aria-haspopup="dialog"
            className="inline-flex items-center gap-1.5 rounded-full bg-accent-600 px-3 py-1 text-xs font-semibold text-white shadow-soft transition-colors hover:bg-accent-700"
            title="Export or copy selected tweets"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2v9" />
              <path d="M4 7l4 4 4-4" />
              <path d="M3 13h10" />
            </svg>
            Export
            <span className="text-[10px] opacity-80">{exportOpen ? '▴' : '▾'}</span>
          </button>
          {exportOpen && (
            <div
              ref={exportPopRef}
              role="dialog"
              className="absolute left-0 top-full z-20 mt-2 w-[14rem] rounded-2xl border border-canvas-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-ink-900"
            >
              <button
                type="button"
                onClick={onExportMd}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-800 hover:bg-canvas-100 dark:text-ink-100 dark:hover:bg-white/5"
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 2v9" />
                  <path d="M4 7l4 4 4-4" />
                  <path d="M3 13h10" />
                </svg>
                Download Markdown
              </button>
              <button
                type="button"
                onClick={onCopyUrls}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-800 hover:bg-canvas-100 dark:text-ink-100 dark:hover:bg-white/5"
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <path d="M11 6h2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-2" />
                </svg>
                Copy URLs
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => starMut.mutate()}
          className="inline-flex items-center gap-1.5 rounded-full border border-canvas-300 bg-white px-3 py-1 text-xs font-medium text-ink-800 transition-colors hover:border-accent-300 hover:bg-accent-50 dark:border-white/10 dark:bg-white/5 dark:text-ink-100 dark:hover:bg-white/10"
          title={allStarred ? 'Unstar all' : 'Star all'}
        >
          <span className="text-amber-500">{allStarred ? '★' : '☆'}</span>
          {allStarred ? 'Unstar' : 'Star'}
        </button>

        <div className="relative inline-block">
          <button
            ref={tagBtnRef}
            type="button"
            onClick={() => setTagOpen((o) => !o)}
            aria-expanded={tagOpen}
            aria-haspopup="dialog"
            className="inline-flex items-center gap-1.5 rounded-full border border-canvas-300 bg-white px-3 py-1 text-xs font-medium text-ink-800 transition-colors hover:border-accent-300 hover:bg-accent-50 dark:border-white/10 dark:bg-white/5 dark:text-ink-100 dark:hover:bg-white/10"
            title="Apply a tag/category"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 7.5L7.5 2.5h6v6L8 14l-5.5-5.5z" />
              <circle cx="10" cy="6" r="1" />
            </svg>
            Tag…
          </button>
          {tagOpen && (
            <div
              ref={tagPopRef}
              role="dialog"
              className="absolute left-0 top-full z-20 mt-2 w-[18rem] rounded-2xl border border-canvas-200 bg-white p-3 shadow-xl dark:border-white/10 dark:bg-ink-900"
            >
              <div className="label mb-1.5">
                Tag {selection.size} {selection.size === 1 ? 'tweet' : 'tweets'}
              </div>
              <input
                ref={tagInputRef}
                type="text"
                className="input text-xs"
                placeholder="Type a tag name…"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (tagDraft.trim()) applyTag(tagDraft);
                  }
                }}
              />
              <div className="mt-2 space-y-0.5">
                {tagMatches.length === 0 && tagDraft.trim() === '' && (
                  <div className="px-1 py-1 text-[11px] text-ink-400">
                    No tags yet. Type one above to create.
                  </div>
                )}
                {tagMatches.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => applyTag(c.name)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-canvas-100 dark:hover:bg-white/5"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: c.color ?? '#7c3aed' }}
                    />
                    <span className="flex-1 line-clamp-2 break-words text-ink-800 dark:text-ink-100">
                      {c.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-ink-400">
                      {c.tweet_count ?? 0}
                    </span>
                  </button>
                ))}
                {tagDraft.trim() && !exactMatch && (
                  <button
                    type="button"
                    onClick={() => applyTag(tagDraft)}
                    className="flex w-full items-center gap-2 rounded-lg border border-dashed border-accent-300 px-2 py-1 text-left text-xs text-accent-700 hover:bg-accent-50 dark:border-accent-500/50 dark:text-accent-200 dark:hover:bg-accent-500/10"
                  >
                    <span>+</span>
                    <span>
                      Create &amp; apply <span className="font-semibold">{tagDraft.trim()}</span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onChat}
          className="hidden items-center gap-1.5 rounded-full border border-canvas-300 bg-white px-3 py-1 text-xs font-medium text-ink-800 transition-colors hover:border-accent-300 hover:bg-accent-50 md:inline-flex dark:border-white/10 dark:bg-white/5 dark:text-ink-100 dark:hover:bg-white/10"
          title="Ask the agent about the selected tweets"
        >
          <span className="text-accent-600 dark:text-accent-400">✦</span>
          Ask agent
        </button>

        <span className="ml-auto inline-flex items-center gap-2">
          {flash && (
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
              {flash}
            </span>
          )}
          <button
            type="button"
            onClick={onSelectPage}
            className="text-[11px] font-medium text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline dark:text-ink-300 dark:hover:text-ink-50"
            title={allOnPageSelected ? 'Deselect this page' : 'Select all tweets on this page'}
          >
            {allOnPageSelected ? 'Deselect page' : 'Select page'}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="grid h-11 w-11 place-items-center rounded-full text-lg text-ink-400 transition-colors hover:bg-canvas-200 hover:text-ink-800 dark:hover:bg-white/10 dark:hover:text-ink-50"
            aria-label="Clear selection"
            title="Clear selection (Esc)"
          >
            ×
          </button>
        </span>
      </div>
    </div>
  );
}
