// /api/data/[name] - auth-gated R2 object streamer.
//
// Why this exists: the R2 bucket is private. Browsers can't fetch the JSONs
// directly. Every byte goes through this function, which verifies the CF
// Access JWT before streaming the R2 object back. That's the only privacy
// layer in front of the actual tweet data.
//
// Only the two derived JSONs are allowed (no path traversal, no HTML files).

import { requireAccess, type Env } from '../_auth';

const ALLOWED_FILES = new Set(['categorized_tweets.json', 'enriched_tweets.json', 'embeddings.ndjson']);

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const denied = await requireAccess(request, env);
  if (denied) return denied;

  const name = String(params.name ?? '');
  if (!ALLOWED_FILES.has(name)) {
    return Response.json({ error: 'not_found', name }, { status: 404 });
  }
  if (!env.DATA_BUCKET) {
    return Response.json(
      { error: 'server_misconfigured', reason: 'DATA_BUCKET binding not configured' },
      { status: 500 },
    );
  }

  // Pass through If-None-Match for ETag-based revalidation. The browser's
  // HTTP cache sends this on every refetch after max-age expires; a correct
  // 304 lets it serve the multi-MB cached copy instead of re-downloading.
  const ifNoneMatch = request.headers.get('If-None-Match') ?? undefined;
  const object = await env.DATA_BUCKET.get(name, {
    onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch.replace(/^"|"$/g, '') } : undefined,
  });

  if (!object) {
    return Response.json({ error: 'not_found', name }, { status: 404 });
  }

  // Precondition failed (the client's etag matched): R2 returns a METADATA-ONLY
  // object here - truthy, but with no `body`. It must become a real 304, or the
  // fallthrough below streams a 0-byte 200 that overwrites the browser's cached
  // copy and breaks every sync after the first.
  if (!('body' in object) || !object.body) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${object.etag}"`, 'Cache-Control': 'private, max-age=60' },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', `"${object.etag}"`);
  headers.set('Cache-Control', 'private, max-age=60');
  headers.set('Vary', 'Accept-Encoding');
  // The objects are stored pre-gzipped (Content-Encoding: gzip metadata set at
  // upload). Workers' default encodeBody: 'automatic' treats the body as
  // DEcompressed and re-encodes it per the Content-Encoding header we just
  // copied - double-gzipping the bytes, which the browser then fails to parse.
  // 'manual' declares the body already matches the header.
  return new Response(object.body, { status: 200, headers, encodeBody: 'manual' });
};
