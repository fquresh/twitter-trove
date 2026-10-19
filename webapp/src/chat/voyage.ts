// Browser-side Voyage embedding client. Two routes:
//
// - LOCAL: calls https://api.voyageai.com/v1/embeddings directly with the
//   user's key from localStorage. Voyage allows browser-origin CORS.
//
// - PROXY (`VITE_USE_API_PROXY=true`): calls same-origin `/api/embed`, which
//   is a Cloudflare Pages Function that adds the server-side `VOYAGE_API_KEY` and
//   forwards. The browser key is unused / can be empty.

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const PROXY_MODE = import.meta.env.VITE_USE_API_PROXY === 'true';

export interface EmbedQueryOptions {
  apiKey?: string;           // unused in proxy mode
  model: string;             // 'voyage-3-large'
  dim?: number;              // default 1024
  inputType?: 'query' | 'document';
}

export async function embedQuery(
  text: string,
  { apiKey, model, dim = 1024, inputType = 'query' }: EmbedQueryOptions,
): Promise<Float32Array> {
  const url = PROXY_MODE ? '/api/embed' : VOYAGE_URL;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!PROXY_MODE) {
    if (!apiKey) throw new Error('Voyage API key required (or enable VITE_USE_API_PROXY).');
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const resp = await fetch(url, {
    method: 'POST',
    credentials: PROXY_MODE ? 'include' : 'omit',
    headers,
    body: JSON.stringify({
      input: [text],
      model,
      output_dimension: dim,
      output_dtype: 'float',
      input_type: inputType,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Voyage embed failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  const json = (await resp.json()) as {
    data: Array<{ embedding: number[] }>;
    usage: { total_tokens: number };
  };
  const arr = json.data?.[0]?.embedding;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('Voyage embed returned an empty embedding');
  }
  const v = new Float32Array(arr);
  // L2-normalize so cosine = dot. Stored vectors are normalized at index time
  // (see enrich.py); query must match.
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Smoke test - embed the literal "ping" and confirm dim=1024. */
export async function pingVoyage(
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const v = await embedQuery('ping', { apiKey, model });
    return { ok: true, message: `OK - ${model} returned ${v.length}-dim vector` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export const VOYAGE_PROXY_MODE = PROXY_MODE;
