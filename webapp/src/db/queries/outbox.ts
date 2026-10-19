// Local mutation outbox - the client half of cross-device sync.
//
// Every user-generated mutation that should propagate across devices (favorite
// toggles, notes edits, manual category assign/unassign) appends one row here
// at the DB layer, so *every* call site is covered without threading a sync
// handle through the UI. The sync client (`src/sync/syncClient.ts`) drains this
// log to the D1-backed `/api/sync` endpoint and prunes pushed rows.
//
// Design notes:
//   - Append-only with an autoincrement `id`. The push cursor is "max id sent";
//     new mutations arriving mid-push get higher ids and survive the prune.
//   - `updated_at` is unix **milliseconds** (client clock). The server merges
//     last-write-wins on this value, so ms precision matters for rapid toggles.
//   - Category assignments are keyed by category **name**, not the local
//     autoincrement id (which differs per device). The apply path re-resolves
//     the name to a local id, creating the category if needed.

import type { Database } from 'sql.js';
import { run, all, get } from '../exec';

export type MutationKind = 'favorite' | 'notes' | 'category_assign';

export interface OutboxRow {
  id: number;
  kind: MutationKind;
  target_id: string;
  value: string | null;
  updated_at: number;
}

// Category-assign targets pack (tweetId, categoryName) into one string using
// the ASCII unit separator, which never appears in a tweet id or category name.
const SEP = '\u001f';

export function categoryAssignTarget(tweetId: string, categoryName: string): string {
  return `${tweetId}${SEP}${categoryName}`;
}

export function parseCategoryAssignTarget(
  target: string,
): { tweetId: string; categoryName: string } | null {
  const i = target.indexOf(SEP);
  if (i < 0) return null;
  return { tweetId: target.slice(0, i), categoryName: target.slice(i + 1) };
}

// --- pub/sub: notify the sync client of new local mutations without a circular
// import (outbox lives in the db layer; syncClient imports outbox). ---
let writeListener: (() => void) | null = null;

export function onOutboxWrite(cb: (() => void) | null): void {
  writeListener = cb;
}

/**
 * Append a mutation to the outbox and notify any registered listener.
 * `value` is the already-serialized payload (JSON string) or null.
 * Pass `notify=false` for bulk loops where the caller fires one sync afterward.
 */
export function recordMutation(
  db: Database,
  kind: MutationKind,
  targetId: string,
  value: string | null,
  notify = true,
): void {
  run(
    db,
    'INSERT INTO sync_outbox (kind, target_id, value, updated_at) VALUES (?, ?, ?, ?)',
    [kind, targetId, value, Date.now()],
  );
  if (notify && writeListener) writeListener();
}

/** All outbox rows with id greater than `sinceId`, in insertion order. */
export function collectOutbox(db: Database, sinceId = 0): OutboxRow[] {
  return all<OutboxRow>(
    db,
    'SELECT id, kind, target_id, value, updated_at FROM sync_outbox WHERE id > ? ORDER BY id ASC',
    [sinceId],
  );
}

/** Delete pushed rows (id <= maxId). New rows have larger ids and survive. */
export function pruneOutbox(db: Database, maxId: number): void {
  run(db, 'DELETE FROM sync_outbox WHERE id <= ?', [maxId]);
}

/**
 * Newest local outbox timestamp for a (kind, target) pair, or null if none.
 * Used by the pull-apply guard: never overwrite a local value that has an
 * un-pushed mutation newer than the incoming server value.
 */
export function latestOutboxTimestamp(
  db: Database,
  kind: MutationKind,
  targetId: string,
): number | null {
  return (
    get<{ ts: number }>(
      db,
      'SELECT MAX(updated_at) AS ts FROM sync_outbox WHERE kind = ? AND target_id = ?',
      [kind, targetId],
    )?.ts ?? null
  );
}

// --- sync_state key/value bag (device id + pull cursor) ---
export function getSyncState(db: Database, key: string): string | null {
  return get<{ value: string | null }>(
    db,
    'SELECT value FROM sync_state WHERE key = ?',
    [key],
  )?.value ?? null;
}

export function setSyncState(db: Database, key: string, value: string): void {
  run(
    db,
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export function deleteSyncState(db: Database, key: string): void {
  run(db, 'DELETE FROM sync_state WHERE key = ?', [key]);
}
