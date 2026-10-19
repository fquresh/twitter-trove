// /api/chat - DeepSeek proxy (Pages Function on Workers runtime).
// Holds DEEPSEEK_API_KEY server-side. Forwards the body the webapp's
// client.ts adapter builds to DeepSeek's native OpenAI-compatible endpoint;
// returns the response unchanged. Auth-gated by Cloudflare Access.

import { verifyAccess, denyResponse, type Env } from './_auth';
import { rejectOversizedBody, clampMaxTokens, rateLimit } from './_guard';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MAX_BODY_BYTES = 1_048_576; // 1 MB - generous for RAG context + history
const MAX_OUTPUT_TOKENS = 16_384; // bounds output cost (agent default is 8192)
const RATE_LIMIT = 240; // requests per window per user
const RATE_WINDOW_SEC = 60;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await verifyAccess(request, env);
  if (!auth.ok) return denyResponse(auth);

  if (!env.DEEPSEEK_API_KEY) {
    return Response.json(
      { error: 'server_misconfigured', reason: 'DEEPSEEK_API_KEY not set' },
      { status: 500 },
    );
  }

  const tooBig = rejectOversizedBody(request, MAX_BODY_BYTES);
  if (tooBig) return tooBig;
  const limited = await rateLimit(env, auth.sub || auth.email || 'unknown', RATE_LIMIT, RATE_WINDOW_SEC);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  clampMaxTokens(body as Record<string, unknown>, MAX_OUTPUT_TOKENS);

  try {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    // Stream the upstream body through unchanged. DeepSeek returns JSON;
    // copying the response preserves status, content-type, encoding.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      },
    });
  } catch (e) {
    console.error('[api/chat] upstream error', e);
    return Response.json(
      { error: 'upstream_error', message: (e as Error).message },
      { status: 502 },
    );
  }
};

// 405 on any other method.
export const onRequest: PagesFunction<Env> = async () =>
  new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
