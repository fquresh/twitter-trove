// /api/embed - Voyage embedding proxy.

import { verifyAccess, denyResponse, type Env } from './_auth';
import { rejectOversizedBody, rateLimit } from './_guard';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_BODY_BYTES = 262_144; // 256 KB - embed input is just query text
const RATE_LIMIT = 240;
const RATE_WINDOW_SEC = 60;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await verifyAccess(request, env);
  if (!auth.ok) return denyResponse(auth);

  if (!env.VOYAGE_API_KEY) {
    return Response.json(
      { error: 'server_misconfigured', reason: 'VOYAGE_API_KEY not set' },
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

  try {
    const upstream = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      },
    });
  } catch (e) {
    console.error('[api/embed] upstream error', e);
    return Response.json(
      { error: 'upstream_error', message: (e as Error).message },
      { status: 502 },
    );
  }
};

export const onRequest: PagesFunction<Env> = async () =>
  new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
