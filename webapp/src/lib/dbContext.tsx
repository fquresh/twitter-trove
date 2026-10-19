import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getDb, type SqliteHandle } from '../db/sqlite';
import { initSync } from '../sync/syncClient';

interface DbCtx {
  handle: SqliteHandle | null;
  error: string | null;
  reload: () => void;
}

const Ctx = createContext<DbCtx>({ handle: null, error: null, reload: () => undefined });

export function DbProvider({ children }: { children: ReactNode }) {
  const [handle, setHandle] = useState<SqliteHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;
    getDb()
      .then((h) => {
        if (cancelled) return;
        setHandle(h);
        // Start cross-device sync (no-op outside cloud/proxy mode). When a pull
        // applies remote changes, refresh the React Query cache so the UI shows
        // the synced favorites/notes/categories.
        teardown = initSync(h, { onApplied: () => queryClient.invalidateQueries() });
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [tick, queryClient]);

  return (
    <Ctx.Provider
      value={{
        handle,
        error,
        reload: () => setTick((t) => t + 1),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useDb(): SqliteHandle {
  const { handle } = useContext(Ctx);
  if (!handle) {
    throw new Error('Database not ready - wrap children in <DbReady />');
  }
  return handle;
}

export function useDbStatus(): DbCtx {
  return useContext(Ctx);
}
