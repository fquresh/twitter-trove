// /api/sync - cross-device user-state sync (Pages Function on Workers runtime).
//
// Backed by a D1 (serverless SQLite) `mutations` table. Stores one row per
// (user_id, kind, target_id) and merges last-write-wins on `updated_at` (unix
// ms, client clock). Partitioned by the Cloudflare Access `sub` so state is
// tied to the authenticated identity.
//
//   POST { device_id, mutations: [{kind, target_id, value, updated_at}] }
//        → upsert each (LWW). Returns { accepted }.
//   GET  ?since=<seq>
//        → { mutations: [{kind, target_id, value, updated_at, seq}] } for rows
//          with seq > cursor.
//
// PAGINATION USES A SERVER-ASSIGNED MONOTONIC `seq`, NOT the client timestamp.
// Each winning upsert stamps seq = MAX(seq)+1 for that user (D1 serializes
// writers, so this is monotonic). The client cursor is the max seq it has
// pulled. This is the load-bearing correctness property: a delayed or
// clock-skewed push gets a fresh high seq when it lands, so no peer's cursor
// can ever skip past it (which a timestamp high-water cursor would do).
// `updated_at` is kept only as the LWW tiebreaker and is clamped to a sane
// window so a bad clock can't permanently win.
//
// The schema self-provisions (CREATE TABLE IF NOT EXISTS) so there's no manual
// migration step. The D1 database itself must be created once and bound as
// `DB` in wrangler.toml (see wrangler.example.toml).

import { verifyAccess, denyResponse, type Env } from './_auth';

const VALID_KINDS = new Set(['favorite', 'notes', 'category_assign']);
const D1_BATCH = 50; // keep each D1 batch() well under platform statement limits
const PULL_LIMIT = 50000; // generous bound for a single-user archive
const MAX_MUTATIONS = 5000; // per POST; the client chunks at 500
const MAX_TARGET_LEN = 1024;
const MAX_VALUE_LEN = 65536;
const FUTURE_SKEW_MS = 5 * 60 * 1000; // tolerate small clock lead; clamp beyond

interface WireMutation {
  kind: string;
  target_id: string;
  value: string | null;
  updated_at: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Sync payloads are per-user and must never be cached by the edge/browser.
      'Cache-Control': 'private, no-store',
    },
  });
}

// Per-isolate guard. CREATE ... IF NOT EXISTS is idempotent, so re-running on a
// cold isolate is harmless; the flag just skips redundant DDL on warm ones.
let schemaReady = false;
async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS mutations (
         user_id    TEXT NOT NULL,
         kind       TEXT NOT NULL,
         target_id  TEXT NOT NULL,
         value      TEXT,
         updated_at INTEGER NOT NULL,
         device_id  TEXT,
         seq        INTEGER NOT NULL,
         PRIMARY KEY (user_id, kind, target_id)
       )`,
    )
    .run();
  // Drives both pagination (seq > cursor) and the MAX(seq) lookup per upsert.
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_mutations_user_seq ON mutations(user_id, seq)`)
    .run();
  schemaReady = true;
}

// The sync partition key. Returns null when there is no stable identity - we
// fail CLOSED rather than co-mingling everyone into a shared 'unknown' bucket.
function userIdOf(auth: { sub?: string; email?: string }): string | null {
  return auth.sub || auth.email || null;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await verifyAccess(request, env);
  if (!auth.ok) return denyResponse(auth);
  const userId = userIdOf(auth);
  if (!userId) return json({ error: 'unauthorized', reason: 'no_identity' }, 401);
  if (!env.DB)
    return json({ error: 'server_misconfigured', reason: 'DB binding not configured' }, 500);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  const b = (body ?? {}) as { device_id?: unknown; mutations?: unknown };
  const deviceId = typeof b.device_id === 'string' ? b.device_id : null;
  const incoming = Array.isArray(b.mutations) ? (b.mutations as WireMutation[]) : [];
  if (incoming.length > MAX_MUTATIONS) {
    return json({ error: 'too_many_mutations', max: MAX_MUTATIONS }, 413);
  }

  await ensureSchema(env.DB);

  // seq = MAX(seq)+1 for this user, computed inline. The index makes MAX a
  // single rightmost-entry lookup. Within a batch (one D1 transaction) each
  // statement sees the prior statement's insert, so seq is monotonic; across
  // requests D1's single-writer serializes them. A stale write (older
  // updated_at) fails the WHERE and does NOT bump seq, so pullers aren't churned.
  const upsertSql = `INSERT INTO mutations (user_id, kind, target_id, value, updated_at, device_id, seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6,
             (SELECT COALESCE(MAX(seq), 0) + 1 FROM mutations WHERE user_id = ?1))
     ON CONFLICT(user_id, kind, target_id) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       device_id = excluded.device_id,
       seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM mutations WHERE user_id = ?1)
     WHERE excluded.updated_at > mutations.updated_at`;

  const serverNow = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const m of incoming) {
    if (!m || !VALID_KINDS.has(m.kind)) continue;
    if (typeof m.target_id !== 'string' || m.target_id.length === 0 || m.target_id.length > MAX_TARGET_LEN)
      continue;
    if (!(m.value === null || typeof m.value === 'string')) continue;
    if (typeof m.value === 'string' && m.value.length > MAX_VALUE_LEN) continue;
    if (typeof m.updated_at !== 'number' || !Number.isFinite(m.updated_at)) continue;
    // Clamp to [0, now+skew] so a forward-skewed/hostile clock can't write a
    // far-future timestamp that wins LWW forever.
    const ts = Math.min(Math.max(0, Math.trunc(m.updated_at)), serverNow + FUTURE_SKEW_MS);
    stmts.push(env.DB.prepare(upsertSql).bind(userId, m.kind, m.target_id, m.value, ts, deviceId));
  }

  for (let i = 0; i < stmts.length; i += D1_BATCH) {
    await env.DB.batch(stmts.slice(i, i + D1_BATCH));
  }
  return json({ accepted: stmts.length }, 200);
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await verifyAccess(request, env);
  if (!auth.ok) return denyResponse(auth);
  const userId = userIdOf(auth);
  if (!userId) return json({ error: 'unauthorized', reason: 'no_identity' }, 401);
  if (!env.DB)
    return json({ error: 'server_misconfigured', reason: 'DB binding not configured' }, 500);

  await ensureSchema(env.DB);

  const sinceRaw = Number(new URL(request.url).searchParams.get('since') ?? '0');
  const since = Number.isFinite(sinceRaw) ? Math.max(0, Math.trunc(sinceRaw)) : 0;
  const res = await env.DB.prepare(
    `SELECT kind, target_id, value, updated_at, seq
       FROM mutations
      WHERE user_id = ?1 AND seq > ?2
      ORDER BY seq ASC
      LIMIT ${PULL_LIMIT}`,
  )
    .bind(userId, since)
    .all();

  return json({ mutations: res.results ?? [] }, 200);
};

// 405 on any other method.
export const onRequest: PagesFunction<Env> = async () =>
  json({ error: 'method_not_allowed' }, 405);
