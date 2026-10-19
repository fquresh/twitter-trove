import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { useDbStatus } from '../lib/dbContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { applyTheme, useUiStore } from '../state/uiStore';
import { FilterChips } from '../filters/FilterChips';
import { DateRangePopover } from './DateRangePopover';
import { FilterToolbar } from './FilterToolbar';
import { filteredTweetCount, totalTweetCount } from '../db/queries/tweets';
import { formatNumber } from '../lib/format';
import { useEffect, useMemo, useRef, useState } from 'react';
import { filtersFromParams } from '../filters/urlSync';
import { isEmptyFilterSet } from '../filters/types';
import { FloatingChatButton } from './chat/FloatingChatButton';
import { ChatPopup } from './chat/ChatPopup';
import { usePopupChat } from '../state/popupChatStore';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { MobileTabBar } from './MobileTabBar';
import { MobileMoreSheet } from './MobileMoreSheet';
import { useIsMobile } from '../lib/useIsMobile';
import { syncFromDisk, PROXY_MODE, shouldSkipEnriched, shouldFetchEmbeddingsOnly } from '../lib/syncFromDisk';
import { resyncAfterImport } from '../sync/syncClient';
import { markRetrievalStale } from '../chat/retrieval';

export function Layout() {
  const { handle, error } = useDbStatus();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const [params] = useSearchParams();
  const popupOpen = usePopupChat((s) => s.open);
  const popupPrompt = usePopupChat((s) => s.initialPrompt);
  const popupHide = usePopupChat((s) => s.hide);
  const isMobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  // The full chat surface owns /chat; the floating panel must never sit on top
  // of it (that is what "ask" used to do from inside the conversation).
  const onChatRoute = useLocation().pathname.startsWith('/chat');

  useEffect(() => {
    if (onChatRoute) popupHide();
  }, [onChatRoute, popupHide]);

  const filters = useMemo(() => filtersFromParams(params), [params]);

  const totalQ = useQuery({
    queryKey: ['total-tweets', !!handle],
    queryFn: () => (handle ? totalTweetCount(handle.db) : 0),
    enabled: !!handle,
  });

  const filtered = !isEmptyFilterSet(filters);
  const matchingQ = useQuery({
    queryKey: ['filtered-tweets', params.toString(), !!handle],
    queryFn: () => (handle ? filteredTweetCount(handle.db, filters) : 0),
    enabled: !!handle && filtered,
  });

  const queryClient = useQueryClient();
  const [syncState, setSyncState] = useState<
    | { kind: 'idle' }
    | { kind: 'busy'; message: string }
    | { kind: 'done'; message: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const runSync = async () => {
    if (!handle || syncState.kind === 'busy') return;
    setSyncState({ kind: 'busy', message: 'Starting…' });
    try {
      const nav = navigator as Navigator & { deviceMemory?: number };
      const skipEnriched = shouldSkipEnriched(
        nav.userAgent,
        nav.deviceMemory,
        useUiStore.getState().enrichedImport,
        nav.maxTouchPoints,
      );
      const summary = await syncFromDisk(handle, {
        onProgress: (m) => setSyncState({ kind: 'busy', message: m }),
        onCheckpoint: () => handle.flush(),
        skipEnriched,
        fetchEmbeddingsOnly: shouldFetchEmbeddingsOnly(useUiStore.getState().enrichedImport),
      });
      handle.markDirty();
      await handle.flush();
      queryClient.invalidateQueries();
      // The chat retrieval worker holds its own DB copy - mark it stale so the
      // next search re-syncs against the freshly imported tweets.
      markRetrievalStale();
      // Re-pull cross-device user state (favorites/notes/categories) onto the
      // freshly imported tweets. No-op outside cloud/proxy mode.
      // Awaited, not fire-and-forget: a failed resync used to vanish silently.
      // It is reported as a warning rather than thrown, because the import
      // itself already succeeded and the counts below are still worth showing.
      const cloudSync = await resyncAfterImport(handle);
      const errors = cloudSync.ok
        ? summary.errors
        : [...summary.errors, `Cross-device resync failed: ${cloudSync.error ?? 'unknown error'}`];
      const inserted = summary.htmlTweetsInserted;
      const updated = summary.htmlTweetsUpdated;
      const errCount = errors.length;
      if (errCount > 0) console.error('[sync] completed with errors:', errors);
      if (inserted === 0 && updated === 0 && errCount > 0) {
        // Nothing imported AND there were errors → surface the real failure
        // instead of a misleading "Already up to date". (These per-file errors
        // used to be collected but never shown - invisible on mobile.)
        setSyncState({
          kind: 'error',
          message: `Sync failed - ${errors[0]}${errCount > 1 ? ` (+${errCount - 1} more)` : ''}`,
        });
      } else {
        // Tweets landed. If some files (typically the enriched payload) errored,
        // report success WITH a warning count rather than hiding the partial
        // failure behind a plain ✓.
        const base =
          inserted === 0 && updated === 0
            ? 'Already up to date'
            : `+${inserted} new, ${updated} updated`;
        setSyncState({
          kind: 'done',
          message: errCount > 0 ? `${base} (+${errCount} warning${errCount > 1 ? 's' : ''})` : base,
        });
      }
    } catch (e) {
      console.error('[sync] threw:', e);
      setSyncState({ kind: 'error', message: (e as Error).message });
    }
  };

  // Auto-clear the success pill after a few seconds. Errors STAY until the next
  // sync attempt so they're actually readable (esp. on mobile, where the pill
  // is small and there's no hover-title).
  useEffect(() => {
    if (syncState.kind === 'done') {
      const t = window.setTimeout(() => setSyncState({ kind: 'idle' }), 3500);
      return () => window.clearTimeout(t);
    }
  }, [syncState]);

  // First-load auto-sync (cloud/proxy mode only). The cloud app has no
  // server-side tweet DB - tweets are materialized into this browser's
  // IndexedDB by ⟳. On a fresh device the DB is empty and the user would see a
  // blank app with no idea they must hit ⟳; auto-fire the sync once so the app
  // populates itself. Guards:
  //   - PROXY_MODE only: locally the wiki server + /import cover this.
  //   - totalQ.data === 0: never auto-sync when tweets already exist; the manual
  //     ⟳ + ETag fast-path (syncFromDisk) stays the update path.
  //   - useRef once-per-mount: prevents an auto-retry loop if the sync fails
  //     (the error pill shows; the user retries via ⟳). runSync already
  //     early-returns while busy, so this shares the one in-flight guard.
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (
      PROXY_MODE &&
      !autoSyncedRef.current &&
      totalQ.isSuccess &&
      totalQ.data === 0
    ) {
      autoSyncedRef.current = true;
      void runSync();
    }
    // runSync is intentionally omitted: the ref guarantees a single fire, so we
    // don't want the effect re-running when runSync's closure identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalQ.isSuccess, totalQ.data]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="card p-6">
          <h1 className="text-xl font-semibold">Failed to open database</h1>
          <p className="mt-2 text-sm text-ink-400 dark:text-ink-300">{error}</p>
        </div>
      </div>
    );
  }
  if (!handle) {
    return (
      <div className="flex h-screen items-center justify-center text-ink-400">
        Loading database…
      </div>
    );
  }

  const tabs = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/tweets', label: 'Tweets' },
    { to: '/articles', label: 'Articles' },
    { to: '/accounts', label: 'Accounts' },
    { to: '/list-accounts', label: 'List Accounts' },
    { to: '/chat', label: 'Chat' },
    { to: '/categories', label: 'Categories' },
    { to: '/import', label: 'Import' },
    { to: '/settings', label: 'Settings' },
  ];

  return (
    <div className="relative flex h-[100dvh] flex-col bg-grid pb-[calc(4rem+env(safe-area-inset-bottom))] md:h-auto md:min-h-screen md:pb-0">
      {/* Floating pill navbar.  Centered, dark on light, with a violet CTA. */}
      <header className="sticky top-0 z-20 px-4 pt-[env(safe-area-inset-top)] md:top-4 md:pt-0">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between py-2 md:py-0">
          {/* Left: brand mark */}
          <NavLink
            to={{ pathname: '/dashboard', search: params.toString() }}
            className="flex min-h-11 items-center gap-2 rounded-full bg-ink-900/95 py-1.5 pl-2 pr-4 text-white shadow-nav backdrop-blur-md md:min-h-0"
            title="Home"
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">
              <span className="block h-3 w-3 rounded-full border-2 border-accent-300" />
            </span>
            <span className="text-sm font-semibold tracking-tight">Trove</span>
          </NavLink>

          {/* Center: pill tab bar */}
          <nav className="nav-pill mx-auto hidden md:inline-flex">
            {tabs.map((t) => {
              const showScoped = t.to === '/tweets' && filtered && matchingQ.data !== undefined;
              return (
                <NavLink
                  key={t.to}
                  to={{ pathname: t.to, search: params.toString() }}
                  className={({ isActive }) =>
                    `nav-pill-link ${isActive ? 'nav-pill-link-active' : ''}`
                  }
                  title={
                    showScoped
                      ? `${matchingQ.data?.toLocaleString()} tweets match your current filters`
                      : undefined
                  }
                >
                  <span className="inline-flex items-center gap-1.5">
                    {t.label}
                    {showScoped && (
                      <span className="rounded-full bg-accent-600/90 px-1.5 py-[1px] text-[10px] font-semibold leading-none text-white">
                        {formatNumber(matchingQ.data ?? 0)}
                      </span>
                    )}
                  </span>
                </NavLink>
              );
            })}
          </nav>

          {/* Right: tweet count + sync + theme toggle + CTA */}
          <div className="flex items-center gap-2">
            {syncState.kind !== 'idle' && (
              <span
                className={`inline-block min-w-0 max-w-[55vw] whitespace-normal break-words rounded-2xl px-3 py-1.5 text-xs font-medium shadow-soft backdrop-blur md:max-w-none ${
                  syncState.kind === 'error'
                    ? 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200'
                    : syncState.kind === 'done'
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
                      : 'bg-white/80 text-ink-700 dark:bg-ink-800/80 dark:text-ink-200'
                }`}
                title={syncState.message}
              >
                {syncState.kind === 'busy' ? '⟳ ' : syncState.kind === 'done' ? '✓ ' : '✗ '}
                {/* errors show in full (they're the diagnosis); busy/done stay short */}
                {syncState.kind === 'error' || syncState.message.length <= 38
                  ? syncState.message
                  : syncState.message.slice(0, 35) + '…'}
              </span>
            )}
            {syncState.kind === 'idle' && (
              <span
                className={`hidden rounded-full px-3 py-1.5 text-xs font-medium shadow-soft backdrop-blur md:inline ${
                  filtered
                    ? 'bg-accent-100 text-accent-800 dark:bg-accent-500/15 dark:text-accent-200'
                    : 'bg-white/80 text-ink-700 dark:bg-ink-800/80 dark:text-ink-200'
                }`}
                title={
                  filtered
                    ? `${formatNumber(matchingQ.data ?? 0)} of ${formatNumber(totalQ.data ?? 0)} tweets match`
                    : 'Total tweets in archive'
                }
              >
                {filtered
                  ? `${formatNumber(matchingQ.data ?? 0)} / ${formatNumber(totalQ.data ?? 0)}`
                  : `${formatNumber(totalQ.data ?? 0)} tweets`}
              </span>
            )}
            <button
              type="button"
              onClick={runSync}
              disabled={syncState.kind === 'busy'}
              aria-label="Sync latest data from disk"
              title="Pull latest HTML + classifier + enrichment files from disk"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/80 text-base text-ink-700 shadow-soft backdrop-blur transition-colors hover:bg-white disabled:opacity-50 dark:bg-ink-800/80 dark:text-ink-200 dark:hover:bg-ink-700"
            >
              <span className={syncState.kind === 'busy' ? 'inline-block animate-spin' : ''}>
                ⟳
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                const next = theme === 'dark' ? 'light' : 'dark';
                setTheme(next);
                applyTheme(next);
              }}
              aria-label="Toggle theme"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/80 text-base text-ink-700 shadow-soft backdrop-blur transition-colors hover:bg-white dark:bg-ink-800/80 dark:text-ink-200 dark:hover:bg-ink-700"
            >
              {theme === 'dark' ? '☾' : '☀'}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 pt-3 md:flex-row md:flex-wrap md:items-center md:gap-2 md:px-6 md:pt-6">
        {/* Row 1: date-range + Favorites/Threads - always fully visible, no clipping */}
        <div className="flex flex-wrap items-center gap-2 md:contents">
          <DateRangePopover filters={filters} />
          <FilterToolbar />
        </div>
        {/* Row 2: horizontally scrollable chip strip (mobile); wraps inline on desktop */}
        <FilterChips filters={filters} />
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 min-h-0 overflow-auto px-4 py-4 md:overflow-visible md:px-6 md:py-6">
        <Outlet />
      </main>

      {isMobile ? (
        <>
          <MobileTabBar onMore={() => setMoreOpen(true)} />
          <MobileMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
        </>
      ) : (
        <>
          <FloatingChatButton />
          {!onChatRoute && <ChatPopup open={popupOpen} onClose={popupHide} initialPrompt={popupPrompt} />}
        </>
      )}
      <KeyboardShortcuts />
    </div>
  );
}
