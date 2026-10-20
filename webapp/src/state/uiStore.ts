import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'dark' | 'light';

/** Whether to pull the heavy enriched/embeddings payload (tens of MB, powers chat
 *  RAG) onto THIS device when syncing. 'auto' skips it on constrained mobile
 *  devices (see shouldSkipEnriched); 'always'/'never' force the choice. Persisted
 *  per-device, which is correct for a device-capability setting. */
type EnrichedImport = 'auto' | 'always' | 'never';

interface UiState {
  theme: Theme;
  entityTab: 'ticker' | 'hashtag' | 'mention';
  pageSize: number;
  accountsLimit: number;
  enrichedImport: EnrichedImport;
  setTheme: (t: Theme) => void;
  setEntityTab: (t: 'ticker' | 'hashtag' | 'mention') => void;
  setPageSize: (n: number) => void;
  setAccountsLimit: (n: number) => void;
  setEnrichedImport: (v: EnrichedImport) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      entityTab: 'ticker',
      pageSize: 100,
      accountsLimit: 25,
      enrichedImport: 'auto',
      setTheme: (theme) => set({ theme }),
      setEntityTab: (entityTab) => set({ entityTab }),
      setPageSize: (pageSize) => set({ pageSize }),
      setAccountsLimit: (accountsLimit) => set({ accountsLimit }),
      setEnrichedImport: (enrichedImport) => set({ enrichedImport }),
    }),
    {
      name: 'trove-ui',
      partialize: (s) => ({
        theme: s.theme,
        entityTab: s.entityTab,
        pageSize: s.pageSize,
        accountsLimit: s.accountsLimit,
        enrichedImport: s.enrichedImport,
      }),
    },
  ),
);

export type { EnrichedImport };

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'light') {
    root.classList.add('light');
    root.classList.remove('dark');
  } else {
    root.classList.add('dark');
    root.classList.remove('light');
  }
  // Keep the PWA theme-color in sync with the mobile palette.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#4a90ff');
  }
}
