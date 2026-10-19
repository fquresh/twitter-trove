// /api/manifest - R2 file listing via the native R2 binding (no S3 SDK).
// Returns the shape `wiki_server.py:/api/data/manifest` returns locally so the
// webapp's syncFromDisk doesn't have to branch on response shape.

import { requireAccess, type Env } from './_auth';

const DATA_FILES = ['categorized_tweets.json', 'enriched_tweets.json'];

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const denied = await requireAccess(request, env);
  if (denied) return denied;

  if (!env.DATA_BUCKET) {
    return Response.json(
      { error: 'server_misconfigured', reason: 'DATA_BUCKET binding not configured' },
      { status: 500 },
    );
  }

  const root_files: Record<string, { mtime: number; size: number; etag: string }> = {};
  for (const name of DATA_FILES) {
    const head = await env.DATA_BUCKET.head(name);
    if (head) {
      root_files[name] = {
        mtime: Math.floor(head.uploaded.getTime() / 1000),
        size: head.size,
        etag: head.etag,
      };
    }
  }

  return new Response(JSON.stringify({ root_files, html_files: [] }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=10',
    },
  });
};
