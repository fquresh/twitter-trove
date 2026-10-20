// Parser for the enrichment pipeline's output (`enriched_tweets.json`,
// produced by enrich.py). Mirrors the conventions of classifierJson.ts:
//
//   - Tolerant: malformed rows are pushed to `errors` rather than aborting.
//   - Pure: no DB access; the importer in db/queries/enrichments.ts consumes
//     the parsed shape.
//   - Decodes `vector_b64` into a Uint8Array here so consumers don't have to
//     repeat the base64-to-bytes dance.
//
// Schema produced by enrich.py:
//   { metadata: { embed_model, embed_dim, embed_dtype, vision_model, generated_at, stats },
//     embeddings: [{ tweet_id, model, dim, dtype, scale, offset, vector_b64 }, ...],
//     url_enrichments: [{ tweet_id, source_ref, content, metadata }, ...],
//     image_enrichments: [{ tweet_id, source_ref, content, model, metadata }, ...] }

export interface EnrichedMetadata {
  embedModel: string;
  embedDim: number;
  embedDtype: string;
  visionModel: string | null;
  generatedAt: string | null;
  stats: {
    embeddings: number;
    urlEnrichments: number;
    imageEnrichments: number;
  };
}

export interface ParsedEmbedding {
  tweetId: string;
  model: string;
  dim: number;
  dtype: 'int8' | 'float32';
  scale: number | null;
  offset: number | null;
  vector: Uint8Array;
}

export interface ParsedUrlEnrichment {
  tweetId: string;
  sourceRef: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface ParsedImageEnrichment {
  tweetId: string;
  sourceRef: string;
  content: string;
  model: string | null;
  metadata: Record<string, unknown>;
}

export interface ParsedEnriched {
  metadata: EnrichedMetadata;
  embeddings: ParsedEmbedding[];
  urlEnrichments: ParsedUrlEnrichment[];
  imageEnrichments: ParsedImageEnrichment[];
  errors: Array<{
    section: 'metadata' | 'embeddings' | 'url_enrichments' | 'image_enrichments';
    index: number;
    reason: string;
  }>;
}

const EMPTY_METADATA: EnrichedMetadata = {
  embedModel: '',
  embedDim: 0,
  embedDtype: '',
  visionModel: null,
  generatedAt: null,
  stats: { embeddings: 0, urlEnrichments: 0, imageEnrichments: 0 },
};

// `atob` is available in jsdom (Vitest) and the browser; in Node 16+ it's
// also a global. We avoid Buffer here so the same code runs in the worker.
function base64ToBytes(b64: string): Uint8Array {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes;
}

/**
 * Cheap shape probe used by ImportRoute to pick the right parser when a `.json`
 * file lands. Returns true iff the JSON has a top-level `metadata.embed_model`
 * field - the canonical marker for an enriched export. Doesn't validate the
 * full payload; that's the parser's job.
 */
/** Cheap discriminator on an ALREADY-PARSED object (no re-parse). */
export function isEnrichedObject(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false;
  const meta = (o as Record<string, unknown>).metadata;
  return Boolean(meta && typeof meta === 'object' && 'embed_model' in (meta as object));
}

export function isEnrichedJson(text: string): boolean {
  try {
    return isEnrichedObject(JSON.parse(text));
  } catch {
    return false;
  }
}

export function parseEnrichedJson(text: string): ParsedEnriched {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      metadata: EMPTY_METADATA,
      embeddings: [],
      urlEnrichments: [],
      imageEnrichments: [],
      errors: [{ section: 'metadata', index: -1, reason: `Invalid JSON: ${(e as Error).message}` }],
    };
  }
  return parseEnrichedObject(raw);
}

// Parse from an already-deserialized object - lets the caller JSON.parse the
// (large) payload exactly once and route by `isEnrichedObject` without a second
// multi-MB parse on the main thread.
export function parseEnrichedObject(raw: unknown): ParsedEnriched {
  const result: ParsedEnriched = {
    metadata: EMPTY_METADATA,
    embeddings: [],
    urlEnrichments: [],
    imageEnrichments: [],
    errors: [],
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    result.errors.push({ section: 'metadata', index: -1, reason: 'top-level value is not an object' });
    return result;
  }
  const outer = raw as Record<string, unknown>;

  // ── metadata ──
  const meta = outer.metadata as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') {
    result.errors.push({ section: 'metadata', index: -1, reason: 'metadata missing or not an object' });
    return result;
  }
  const embedModel = typeof meta.embed_model === 'string' ? meta.embed_model : '';
  const embedDim = typeof meta.embed_dim === 'number' ? meta.embed_dim : 0;
  const embedDtype = typeof meta.embed_dtype === 'string' ? meta.embed_dtype : '';
  if (!embedModel) {
    result.errors.push({ section: 'metadata', index: -1, reason: 'metadata.embed_model required' });
  }

  const stats = (meta.stats && typeof meta.stats === 'object')
    ? (meta.stats as Record<string, unknown>)
    : {};
  result.metadata = {
    embedModel,
    embedDim,
    embedDtype,
    visionModel: typeof meta.vision_model === 'string' ? meta.vision_model : null,
    generatedAt: typeof meta.generated_at === 'string' ? meta.generated_at : null,
    stats: {
      embeddings: typeof stats.embeddings === 'number' ? stats.embeddings : 0,
      urlEnrichments: typeof stats.url_enrichments === 'number' ? stats.url_enrichments : 0,
      imageEnrichments: typeof stats.image_enrichments === 'number' ? stats.image_enrichments : 0,
    },
  };

  // ── embeddings ──
  const embeddingsIn = Array.isArray(outer.embeddings) ? (outer.embeddings as unknown[]) : [];
  for (let i = 0; i < embeddingsIn.length; i++) {
    const item = embeddingsIn[i] as Record<string, unknown>;
    const tweetId = typeof item.tweet_id === 'string' ? item.tweet_id : null;
    const model = typeof item.model === 'string' ? item.model : null;
    const dim = typeof item.dim === 'number' ? item.dim : null;
    const dtype = item.dtype;
    const vectorB64 = typeof item.vector_b64 === 'string' ? item.vector_b64 : null;
    if (!tweetId || !model || !dim || !vectorB64) {
      result.errors.push({ section: 'embeddings', index: i, reason: 'missing required fields' });
      continue;
    }
    if (dtype !== 'int8' && dtype !== 'float32') {
      result.errors.push({ section: 'embeddings', index: i, reason: `unsupported dtype: ${String(dtype)}` });
      continue;
    }
    let vector: Uint8Array;
    try {
      vector = base64ToBytes(vectorB64);
    } catch (e) {
      result.errors.push({
        section: 'embeddings', index: i,
        reason: `vector_b64 decode failed: ${(e as Error).message}`,
      });
      continue;
    }
    const expectedBytes = dtype === 'int8' ? dim : dim * 4;
    if (vector.byteLength !== expectedBytes) {
      result.errors.push({
        section: 'embeddings', index: i,
        reason: `dim mismatch: dtype=${dtype} dim=${dim} expected ${expectedBytes} bytes, got ${vector.byteLength}`,
      });
      continue;
    }
    result.embeddings.push({
      tweetId,
      model,
      dim,
      dtype,
      scale: typeof item.scale === 'number' ? item.scale : null,
      offset: typeof item.offset === 'number' ? item.offset : null,
      vector,
    });
  }

  // ── url_enrichments ──
  const urlsIn = Array.isArray(outer.url_enrichments) ? (outer.url_enrichments as unknown[]) : [];
  for (let i = 0; i < urlsIn.length; i++) {
    const item = urlsIn[i] as Record<string, unknown>;
    const tweetId = typeof item.tweet_id === 'string' ? item.tweet_id : null;
    const sourceRef = typeof item.source_ref === 'string' ? item.source_ref : null;
    const content = typeof item.content === 'string' ? item.content : null;
    if (!tweetId || !sourceRef || content === null) {
      result.errors.push({ section: 'url_enrichments', index: i, reason: 'missing required fields' });
      continue;
    }
    result.urlEnrichments.push({
      tweetId,
      sourceRef,
      content,
      metadata: (item.metadata && typeof item.metadata === 'object')
        ? (item.metadata as Record<string, unknown>)
        : {},
    });
  }

  // ── image_enrichments ──
  const imagesIn = Array.isArray(outer.image_enrichments) ? (outer.image_enrichments as unknown[]) : [];
  for (let i = 0; i < imagesIn.length; i++) {
    const item = imagesIn[i] as Record<string, unknown>;
    const tweetId = typeof item.tweet_id === 'string' ? item.tweet_id : null;
    const sourceRef = typeof item.source_ref === 'string' ? item.source_ref : null;
    const content = typeof item.content === 'string' ? item.content : null;
    if (!tweetId || !sourceRef || content === null) {
      result.errors.push({ section: 'image_enrichments', index: i, reason: 'missing required fields' });
      continue;
    }
    result.imageEnrichments.push({
      tweetId,
      sourceRef,
      content,
      model: typeof item.model === 'string' ? item.model : null,
      metadata: (item.metadata && typeof item.metadata === 'object')
        ? (item.metadata as Record<string, unknown>)
        : {},
    });
  }

  return result;
}
