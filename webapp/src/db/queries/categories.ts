import type { Database } from 'sql.js';
import { all, run, transaction, scalar } from '../exec';
import { buildFilterFragments } from '../../filters/queryBuilder';
import type { FilterSet } from '../../filters/types';
import { recordMutation, categoryAssignTarget } from './outbox';

// Manual category assignments sync by category NAME (the local autoincrement id
// differs per device). Resolve it once per mutation so the outbox row is
// device-portable.
function categoryNameById(db: Database, categoryId: number): string | null {
  return scalar<string>(db, 'SELECT name FROM categories WHERE id = ?', [categoryId]);
}

export interface CategoryRow {
  id: number;
  name: string;
  color: string | null;
  source: 'classifier' | 'manual';
  created_at: number;
  tweet_count?: number;
}

// Deterministic but varied colors for classifier categories that don't have
// one set yet. Anchored on the category name for stability.
function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const palette = [
    '#06b6d4', '#0ea5e9', '#22d3ee', '#38bdf8', '#818cf8',
    '#a855f7', '#ec4899', '#f43f5e', '#f97316', '#eab308',
    '#22c55e', '#10b981', '#14b8a6', '#6366f1',
  ];
  return palette[h % palette.length];
}

export function upsertCategory(
  db: Database,
  name: string,
  source: 'classifier' | 'manual',
  color?: string,
): number {
  const now = Math.floor(Date.now() / 1000);
  run(
    db,
    `INSERT INTO categories (name, color, source, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO NOTHING`,
    [name, color ?? hashColor(name), source, now],
  );
  return scalar<number>(db, 'SELECT id FROM categories WHERE name = ?', [name]) as number;
}

// Replaces all classifier-assigned categories for the given tweets, without
// touching user-assigned rows. Called per classifier re-import.
//
// Skips assignments for tweets that don't exist locally: the FK on
// tweet_categories.tweet_id is NOT swallowed by INSERT OR IGNORE (only
// UNIQUE/NOT NULL/CHECK are), so a single missing id would otherwise throw and
// roll back the WHOLE transaction - silently discarding every category. We
// pre-filter against the existing ids and report how many were skipped.
export function replaceClassifierAssignments(
  db: Database,
  assignments: Array<{ tweetId: string; categories: string[] }>,
): { linked: number; skipped: number } {
  const now = Math.floor(Date.now() / 1000);
  const known = new Set<string>();
  const idStmt = db.prepare('SELECT id FROM tweets');
  try {
    while (idStmt.step()) known.add(idStmt.get()[0] as string);
  } finally {
    idStmt.free();
  }

  let linked = 0;
  let skipped = 0;
  transaction(db, () => {
    const clear = db.prepare(
      `DELETE FROM tweet_categories WHERE tweet_id = ? AND assigned_by = 'classifier'`,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO tweet_categories
         (tweet_id, category_id, confidence, assigned_at, assigned_by)
       VALUES (?, ?, NULL, ?, 'classifier')`,
    );
    for (const { tweetId, categories } of assignments) {
      if (!known.has(tweetId)) {
        skipped++;
        continue;
      }
      clear.bind([tweetId]);
      while (clear.step()) {
        // no-op
      }
      clear.reset();
      for (const cat of categories) {
        const id = upsertCategory(db, cat, 'classifier');
        insert.bind([tweetId, id, now]);
        while (insert.step()) {
          // no-op
        }
        insert.reset();
      }
      linked++;
    }
    clear.free();
    insert.free();
  });
  return { linked, skipped };
}

export function listCategories(db: Database): CategoryRow[] {
  return all<CategoryRow>(
    db,
    `SELECT c.id, c.name, c.color, c.source, c.created_at,
       (SELECT COUNT(*) FROM tweet_categories tc WHERE tc.category_id = c.id) AS tweet_count
     FROM categories c
     ORDER BY c.name ASC`,
  );
}

export function renameCategory(db: Database, id: number, newName: string): void {
  run(db, 'UPDATE categories SET name = ? WHERE id = ?', [newName, id]);
}

export function recolorCategory(db: Database, id: number, color: string): void {
  run(db, 'UPDATE categories SET color = ? WHERE id = ?', [color, id]);
}

export function deleteManualCategory(db: Database, id: number): void {
  run(db, `DELETE FROM categories WHERE id = ? AND source = 'manual'`, [id]);
}

export function assignUserCategory(
  db: Database,
  tweetId: string,
  categoryId: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  run(
    db,
    `INSERT INTO tweet_categories (tweet_id, category_id, assigned_at, assigned_by)
     VALUES (?, ?, ?, 'user')
     ON CONFLICT(tweet_id, category_id) DO UPDATE SET assigned_by = 'user', assigned_at = excluded.assigned_at`,
    [tweetId, categoryId, now],
  );
  const name = categoryNameById(db, categoryId);
  if (name)
    recordMutation(db, 'category_assign', categoryAssignTarget(tweetId, name), '{"assigned":true}');
}

export function unassignUserCategory(
  db: Database,
  tweetId: string,
  categoryId: number,
): void {
  const name = categoryNameById(db, categoryId);
  run(
    db,
    `DELETE FROM tweet_categories WHERE tweet_id = ? AND category_id = ?`,
    [tweetId, categoryId],
  );
  if (name)
    recordMutation(db, 'category_assign', categoryAssignTarget(tweetId, name), '{"assigned":false}');
}

// Bulk-assign: apply a category to every tweet matching the current filter.
// Used from the category management UI. Returns the number of rows inserted.
export function bulkAssignToFiltered(
  db: Database,
  categoryId: number,
  filters: FilterSet,
): number {
  const { whereSql, joinSql, params } = buildFilterFragments(filters);
  const now = Math.floor(Date.now() / 1000);
  // One transaction so the assignment INSERT and the per-tweet outbox rows
  // commit atomically (otherwise a failure mid-loop leaves the outbox partially
  // populated, and each statement was its own auto-commit).
  return transaction(db, () => {
    const before = scalar<number>(db, 'SELECT COUNT(*) FROM tweet_categories') ?? 0;
    run(
      db,
      `INSERT OR IGNORE INTO tweet_categories (tweet_id, category_id, assigned_at, assigned_by)
       SELECT t.id, ?, ?, 'user' FROM tweets t ${joinSql} WHERE ${whereSql}`,
      [categoryId, now, ...params],
    );
    const after = scalar<number>(db, 'SELECT COUNT(*) FROM tweet_categories') ?? 0;

    // Record one sync mutation per matching tweet (re-asserting an existing
    // assignment is idempotent under last-write-wins). Notify only on the last
    // row so a bulk apply triggers a single sync push, not one per tweet.
    const name = categoryNameById(db, categoryId);
    if (name) {
      const ids = all<{ id: string }>(
        db,
        `SELECT t.id FROM tweets t ${joinSql} WHERE ${whereSql}`,
        params,
      );
      for (let i = 0; i < ids.length; i++) {
        recordMutation(
          db,
          'category_assign',
          categoryAssignTarget(ids[i].id, name),
          '{"assigned":true}',
          i === ids.length - 1,
        );
      }
    }
    return after - before;
  });
}

export function categoriesForTweet(db: Database, tweetId: string): CategoryRow[] {
  return all<CategoryRow>(
    db,
    `SELECT c.id, c.name, c.color, c.source, c.created_at
     FROM categories c
     JOIN tweet_categories tc ON tc.category_id = c.id
     WHERE tc.tweet_id = ?
     ORDER BY c.name ASC`,
    [tweetId],
  );
}
