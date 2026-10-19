// Cross-device sync client (cloud / proxy mode only).
//
// Pairs with `functions/api/sync.ts` (D1-backed) to propagate user-generated
// state - favorites, notes, manual category assignments - across devices that
// share the same Cloudflare Access identity.
//
// Protocol, one `runSync` cycle:
//   1. PUSH  - drain the local `sync_outbox` to the server (batched). The
//              server merges last-write-wins on `updated_at` (unix ms). Pushed
//              rows are pruned from the outbox on success.
//   2. PULL  - GET every server mutation with `updated_at > cursor`, apply each
//              to the local tweet/category tables, then advance the cursor.
//
// Push-before-pull means the server already holds this device's latest values
// before we pull, so LWW resolves correctly. The pull-apply additionally skips
// any incoming mutation that a still-un-pushed local outbox row supersedes
// (the small window between push and pull), so a fast local toggle is never
// clobbered by a staler server value.
//
// Disabled outside proxy mode: local dev (`./trove go`) talks to wiki_server,
// which has no D1 backend, and local and cloud are separate IndexedDBs anyway.

import type { Database } from 'sql.js';
import { run, get } from '../db/exec';
import { upsertCategory } from '../db/queries/categories';
import {
  collectOutbox,
  pruneOutbox,
  getSyncState,
  setSyncState,
  deleteSyncState,
  latestOutboxTimestamp,
  onOutboxWrite,
  parseCategoryAssignTarget,
  type MutationKind,
  type OutboxRow,
} from '../db/queries/outbox';
import type { SqliteHandle } from '../db/sqlite';

const PROXY_MODE = import.meta.env.VITE_USE_API_PROXY === 'true';
const SYNC_URL = '/api/sync';
const PUSH_BATCH = 500;
const PUSH_DEBOUNCE_MS = 1500;
// Pagination cursor = the max server-assigned `seq` pulled so far (NOT a
// timestamp - see the seq rationale in functions/api/sync.ts).
const CURSOR_KEY = 'last_pulled_seq';
const DEVICE_KEY = 'device_id';
// Durable "do a full re-pull next sync" flag. Set after a data import (so
// user state re-applies onto freshly imported tweets) and cleared only once a
// full pull succeeds - so a transient failure self-heals on the next trigger.
const FULL_FLAG = 'needs_full_resync';

export interface WireMutation {
  kind: MutationKind;
  target_id: string;
  value: string | null;
  updated_at: number;
  // Server-assigned monotonic sequence. Present on pulled rows; absent on push.
  seq?: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  applied: number;
  ok: boolean;
  error?: string;
}

function toWire(rows: OutboxRow[]): WireMutation[] {
  return rows.map((r) => ({
    kind: r.kind,
    target_id: r.target_id,
    value: r.value,
    updated_at: r.updated_at,
  }));
}

function getDeviceId(db: Database): string {
  let id = getSyncState(db, DEVICE_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    setSyncState(db, DEVICE_KEY, id);
  }
  return id;
}

/**
 * Apply server mutations to the local tweet/category tables. Pure (no network).
 * Skips any mutation an un-pushed local outbox row supersedes, and skips
 * category links for tweets not yet imported (the FK would reject them - a
 * later full resync re-applies once the tweet exists). Returns applied count.
 */
export function applyPulledMutations(
  db: Database,
  mutations: WireMutation[],
  onError?: (message: string) => void,
): number {
  let applied = 0;
  for (const m of mutations) {
    // Isolate each mutation: a single malformed row (e.g. unparseable value)
    // must not abort the whole pull, or the cursor would never advance and the
    // bad row would be retried forever.
    try {
      const localTs = latestOutboxTimestamp(db, m.kind, m.target_id);
      if (localTs !== null && localTs >= m.updated_at) continue; // local is newer - keep it

      switch (m.kind) {
        case 'favorite': {
          const value: unknown = m.value == null ? false : JSON.parse(m.value);
          if (typeof value !== 'boolean') throw new Error('favorite value must be boolean');
          run(db, 'UPDATE tweets SET is_favorite = ? WHERE id = ?', [value ? 1 : 0, m.target_id]);
          applied++;
          break;
        }
        case 'notes': {
          const notes: unknown = m.value == null ? null : JSON.parse(m.value);
          if (notes !== null && typeof notes !== 'string') {
            throw new Error('notes value must be a string or null');
          }
          run(db, 'UPDATE tweets SET user_notes = ? WHERE id = ?', [notes, m.target_id]);
          applied++;
          break;
        }
        case 'category_assign': {
          const parsed = parseCategoryAssignTarget(m.target_id);
          if (!parsed) throw new Error('invalid category assignment target');
          // The tweet must exist locally or the FK insert throws. Missing means
          // not-yet-imported on this device; a full resync after import recovers.
          const exists = get<{ one: number }>(db, 'SELECT 1 AS one FROM tweets WHERE id = ?', [
            parsed.tweetId,
          ]);
          if (!exists) break;
          const value = JSON.parse(m.value ?? '{}') as { assigned?: unknown };
          if (typeof value.assigned !== 'boolean') {
            throw new Error('category assignment value must contain a boolean assigned field');
          }
          const assigned = value.assigned;
          const catId = upsertCategory(db, parsed.categoryName, 'manual');
          const assignedAt = Math.floor(m.updated_at / 1000);
          if (assigned) {
            run(
              db,
              `INSERT INTO tweet_categories (tweet_id, category_id, assigned_at, assigned_by)
               VALUES (?, ?, ?, 'user')
               ON CONFLICT(tweet_id, category_id) DO UPDATE SET assigned_by = 'user', assigned_at = excluded.assigned_at`,
              [parsed.tweetId, catId, assignedAt],
            );
          } else {
            run(db, 'DELETE FROM tweet_categories WHERE tweet_id = ? AND category_id = ?', [
              parsed.tweetId,
              catId,
            ]);
          }
          applied++;
          break;
        }
        default:
          throw new Error(`unsupported mutation kind: ${String(m.kind)}`);
      }
    } catch (e) {
      const message = `${m.kind}:${m.target_id}: ${(e as Error).message}`;
      if (onError) onError(message);
      else console.warn(`[sync] skipped malformed mutation ${message}`);
    }
  }
  return applied;
}

async function pushOutbox(db: Database, deviceId: string): Promise<number> {
  const rows = collectOutbox(db);
  if (rows.length === 0) return 0;

  let prunedTo = 0;
  let pushed = 0;
  let pushError: Error | null = null;
  for (let i = 0; i < rows.length; i += PUSH_BATCH) {
    const chunk = rows.slice(i, i + PUSH_BATCH);
    const resp = await fetch(SYNC_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, mutations: toWire(chunk) }),
    });
    if (!resp.ok) {
      pushError = new Error(`push failed: HTTP ${resp.status}`);
      break;
    }
    prunedTo = chunk[chunk.length - 1].id;
    pushed += chunk.length;
  }
  if (prunedTo > 0) pruneOutbox(db, prunedTo);
  if (pushError) throw pushError;
  return pushed;
}

async function pullMutations(
  db: Database,
  full: boolean,
): Promise<{ pulled: number; applied: number; errors: string[] }> {
  // Cursor is a server-assigned seq, not a timestamp. full → start from 0.
  const cursor = full ? 0 : Number(getSyncState(db, CURSOR_KEY) ?? 0) || 0;
  const resp = await fetch(`${SYNC_URL}?since=${cursor}`, { credentials: 'include' });
  if (!resp.ok) throw new Error(`pull failed: HTTP ${resp.status}`);
  const data = (await resp.json()) as { mutations?: WireMutation[] };
  const mutations = Array.isArray(data.mutations) ? data.mutations : [];
  if (mutations.length === 0) return { pulled: 0, applied: 0, errors: [] };

  const errors: string[] = [];
  const applied = applyPulledMutations(db, mutations, (message) => errors.push(message));
  // Advance past every row seen (applied or skipped). seq is strictly
  // increasing and assigned at write time, so this never skips a later write.
  const maxSeq = mutations.reduce((m, x) => Math.max(m, x.seq ?? 0), cursor);
  setSyncState(db, CURSOR_KEY, String(maxSeq));
  return { pulled: mutations.length, applied, errors };
}

// --- orchestration (serialized; coalesces overlapping triggers) ---
let inFlight: Promise<SyncResult> | null = null;
let rerunRequested = false;
let appliedCallback: (() => void) | null = null;
let errorCallback: ((msg: string) => void) | null = null;

export async function runSync(
  handle: SqliteHandle,
  opts: { full?: boolean } = {},
): Promise<SyncResult> {
  if (!PROXY_MODE) return { pushed: 0, pulled: 0, applied: 0, ok: true };
  if (inFlight) {
    // A sync is already running; schedule exactly one more afterward. A
    // full-resync request is carried by the durable FULL_FLAG (read below),
    // not this in-memory rerun, so it survives coalescing and even reloads.
    rerunRequested = true;
    return inFlight;
  }
  inFlight = (async (): Promise<SyncResult> => {
    try {
      const db = handle.db;
      // full when explicitly requested OR a prior import left the durable flag.
      const full = opts.full === true || getSyncState(db, FULL_FLAG) === '1';
      const deviceId = getDeviceId(db);
      const pushed = await pushOutbox(db, deviceId);
      const { pulled, applied, errors } = await pullMutations(db, full);
      // Only clear the durable flag once a full pull has actually succeeded.
      if (full) deleteSyncState(db, FULL_FLAG);
      if (pushed > 0 || applied > 0 || full) handle.markDirty();
      if (applied > 0) {
        await handle.flush();
        appliedCallback?.();
      }
      if (errors.length > 0) {
        const msg = `pull skipped ${errors.length} malformed mutation(s): ${errors[0]}`;
        console.warn(`[sync] ${msg}`);
        errorCallback?.(msg);
        return { pushed, pulled, applied, ok: false, error: msg };
      }
      return { pushed, pulled, applied, ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      console.warn('[sync] cycle failed:', msg);
      errorCallback?.(msg);
      return { pushed: 0, pulled: 0, applied: 0, ok: false, error: msg };
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
    if (rerunRequested) {
      rerunRequested = false;
      void runSync(handle);
    }
  }
}

/** Full re-pull (cursor reset) - call after a data import so mutations re-apply
 *  onto freshly imported tweets that earlier incremental pulls may have skipped.
 *  Sets a DURABLE flag so the full pull survives coalescing, transient failure,
 *  and even a page reload before it succeeds. */
export async function resyncAfterImport(handle: SqliteHandle): Promise<SyncResult> {
  if (!PROXY_MODE) return { pushed: 0, pulled: 0, applied: 0, ok: true };
  setSyncState(handle.db, FULL_FLAG, '1');
  // Persist the durable flag BEFORE the (failable) pull, so that if the pull
  // fails and the tab is reloaded within the snapshot debounce window, the
  // next sync still performs the full re-apply rather than losing it.
  await handle.flush();
  return runSync(handle, { full: true });
}

/**
 * Wire up automatic sync: debounced push on local mutation, pull on window
 * focus, and an initial pull. No-op outside proxy mode. Returns a teardown fn.
 */
export function initSync(
  handle: SqliteHandle,
  opts: { onApplied?: () => void; onError?: (msg: string) => void } = {},
): () => void {
  if (!PROXY_MODE) return () => {};
  appliedCallback = opts.onApplied ?? null;
  errorCallback = opts.onError ?? null;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedulePush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void runSync(handle), PUSH_DEBOUNCE_MS);
  };
  onOutboxWrite(schedulePush);

  const onFocus = () => void runSync(handle);
  const onVisible = () => {
    if (!document.hidden) onFocus();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisible);

  void runSync(handle); // initial pull

  return () => {
    onOutboxWrite(null);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) clearTimeout(timer);
    appliedCallback = null;
    errorCallback = null;
  };
}
