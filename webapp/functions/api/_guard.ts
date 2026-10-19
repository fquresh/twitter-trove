// Shared request guards for the cost-bearing API proxies (/api/chat, /api/embed).
// Defense-in-depth so a captured CF Access session (or a fat-fingered request)
// can't run unbounded paid spend through the server-side DeepSeek/Voyage keys:
//   - a body-size cap (bounds input cost),
//   - a max_tokens clamp (bounds output cost) - model choice stays free-text,
//   - an optional D1-backed per-user frequency limiter (bounds sustained abuse).

import type { Env } from './_auth';

function guardJson(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...(extra ?? {}) },
  });
}

/** 413 if the request body exceeds maxBytes (by Content-Length), else null. */
export function rejectOversizedBody(request: Request, maxBytes: number): Response | null {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > maxBytes) {
    return guardJson({ error: 'payload_too_large', maxBytes }, 413);
  }
  return null;
}

/** Clamp body.max_tokens into [1, cap] in place (leaves it unset if absent). */
export function clampMaxTokens(body: Record<string, unknown>, cap: number): void {
  const mt = body.max_tokens;
  if (typeof mt === 'number' && Number.isFinite(mt)) {
    body.max_tokens = Math.min(Math.max(1, Math.trunc(mt)), cap);
  }
}

let rlReady = false;
async function ensureRateTable(db: D1Database): Promise<void> {
  if (rlReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS rate_limits (
         user_id      TEXT PRIMARY KEY,
         window_start INTEGER NOT NULL,
         count        INTEGER NOT NULL
       )`,
    )
    .run();
  rlReady = true;
}

/**
 * Fixed-window per-user limiter. Returns a 429 Response when over the limit,
 * else null. No-ops (allows) when D1 isn't bound or the limiter errors - it must
 * never take the app down on infra trouble. Limits are generous; the legit
 * tool-use loop (≤12 chat calls/turn) stays well under.
 */
export async function rateLimit(
  env: Env,
  userId: string,
  limit: number,
  windowSec: number,
): Promise<Response | null> {
  if (!env.DB) return null;
  try {
    await ensureRateTable(env.DB);
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (user_id, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         count        = CASE WHEN ?2 - window_start >= ?3 THEN 1   ELSE count + 1   END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2  ELSE window_start END
       RETURNING count, window_start`,
    )
      .bind(userId, now, windowSec)
      .first<{ count: number; window_start: number }>();
    if (row && row.count > limit) {
      const retry = Math.max(1, windowSec - (now - row.window_start));
      return guardJson({ error: 'rate_limited', retryAfterSeconds: retry }, 429, {
        'Retry-After': String(retry),
      });
    }
  } catch (e) {
    console.error('[rate-limit] limiter unavailable; allowing request', e);
    return null; // fail open on limiter error - don't break the app
  }
  return null;
}
