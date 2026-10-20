// Main-thread API to the retrieval worker. App-level singleton: one worker,
// kept alive across route changes, lazily initialized on first call. The
// worker's index-hash guard means re-init after an import is cheap.

import type { FilterSet } from '../filters/types';
import type { RetrievalHit } from './retrievalCore';
import { getDb } from '../db/sqlite';

export type { RetrievalHit } from './retrievalCore';

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<string, PendingEntry>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./retrievalWorker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; requestId: string; error?: string };
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      pending.delete(msg.requestId);
      if (msg.type === 'error') {
        entry.reject(new Error(msg.error ?? 'worker error'));
      } else {
        entry.resolve(msg);
      }
    };
    worker.onerror = (ev) => {
      // Reject every pending request - the worker is dead.
      for (const [, entry] of pending) entry.reject(new Error(`worker crashed: ${ev.message}`));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function rpc<T>(req: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
  const id = String(nextRequestId++);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    getWorker().postMessage({ ...req, requestId: id }, transfer ?? []);
  });
}

let initialized = false;
let lastModel = '';
let lastReady: ReadyState | null = null;
// Set by import paths (⟳ sync, /import) that mutate the DB while a chat surface
// may stay mounted. The worker holds its OWN copy of the DB, so without this it
// would keep answering from the pre-import index. `hybridSearch` honors the flag
// and re-syncs before querying, so retrieval self-heals without a remount.
let staleSinceImport = false;

export interface ReadyState {
  embeddingCount: number;
  indexHash: string;
  rebuilt: boolean;
}

/** Mark the worker's DB copy stale after an in-place import. */
export function markRetrievalStale(): void {
  staleSinceImport = true;
}

/**
 * Initialize (or re-initialize) the retrieval worker against the current DB
 * snapshot. Call after every import that may have changed embeddings.
 * Returns the embedding count so callers can gate UI on availability.
 */
export async function ensureWorkerReady(model: string): Promise<ReadyState> {
  // No-op fast path: the worker already holds the current DB for this model and
  // nothing was imported since. Skip the tens-of-MB export + postMessage that a
  // ChatRoute/ChatPopup remount would otherwise repeat on every navigation.
  if (initialized && lastModel === model && !staleSinceImport && lastReady) {
    return lastReady;
  }
  const handle = await getDb();
  // export() is sync and returns a standalone copy (not a view into WASM
  // memory), so we transfer the buffers to the worker zero-copy instead of
  // structured-cloning. The worker opens the main db (FTS + filters) and the
  // embeddings db (vector index) separately. Neither array is used again here.
  const dbBytes = handle.export();
  const embBytes = handle.exportEmbeddings();
  const result = await rpc<{ embeddingCount: number; indexHash: string; rebuilt: boolean }>(
    {
      type: initialized && lastModel === model ? 'reload' : 'init',
      dbBytes,
      embBytes,
      model,
    },
    [dbBytes.buffer, embBytes.buffer],
  );
  initialized = true;
  lastModel = model;
  staleSinceImport = false;
  lastReady = result;
  return result;
}

export async function hybridSearch(
  queryEmbedding: Float32Array,
  ftsQuery: string | null,
  filters: FilterSet,
  k = 20,
): Promise<RetrievalHit[]> {
  // If an import happened while this surface stayed mounted, re-sync the worker
  // with the current DB before querying so new tweets are visible to RAG.
  if (staleSinceImport && initialized) {
    await ensureWorkerReady(lastModel);
  }
  const result = await rpc<{ hits: RetrievalHit[]; elapsedMs: number }>({
    type: 'search',
    queryEmbedding,
    ftsQuery,
    filters,
    k,
  });
  return result.hits;
}

/** Reset the worker singleton - used by tests + Settings → Reset. */
export function disposeWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  initialized = false;
  lastModel = '';
  lastReady = null;
  staleSinceImport = false;
  pending.clear();
}
