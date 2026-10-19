import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';

import './index.css';
import { router } from './App';
import { DbProvider } from './lib/dbContext';
import { applyTheme, useUiStore } from './state/uiStore';

// Apply the persisted theme before React renders so the initial paint doesn't
// flicker. Zustand persist has already rehydrated by the time this runs.
applyTheme(useUiStore.getState().theme);

// Ask the browser to keep our IndexedDB durable. iOS Safari treats site storage
// as evictable by default and silently drops the SQLite snapshot under storage
// pressure / after inactivity - which reads as "the data vanished" or "sync
// never sticks". Best-effort: iOS may still ignore it, and it must never block
// startup, so we swallow any error.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage
    .persisted()
    .then((already) => (already ? true : navigator.storage.persist()))
    .then((granted) => console.info('[storage] persistent storage granted:', granted))
    .catch(() => {});
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // DB queries are cheap to rerun but we still want cache for UX.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DbProvider>
        <RouterProvider router={router} />
      </DbProvider>
    </QueryClientProvider>
  </StrictMode>,
);
