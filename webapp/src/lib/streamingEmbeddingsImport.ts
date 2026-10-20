// Streaming importer for the embeddings-only NDJSON artifact.
//
// The full enriched_tweets.json (tens of MB) OOMs iOS Safari when JSON.parse'd
// monolithically - the tab is jetsamed at peak heap. This module streams the
// smaller embeddings.ndjson artifact line-by-line from a fetch Response,
// parses each line individually, and INSERTs into tweet_embeddings in
// batched transactions. Peak JS heap stays flat regardless of corpus size:
// we hold at most one decoded vector + one transaction buffer at a time.
//
// Format (see scripts/build_embeddings_ndjson.py):
//   Line 1: {"_meta":true,"embed_model":"...","embed_dim":1024,"embed_dtype":"int8","count":<N>}
//   Line 2+: {"tweet_id":"...","model":"...","dim":1024,"dtype":"int8","scale":...,"offset":...,"vector_b64":"..."}

import type { Database } from 'sql.js';
import { transaction } from '../db/exec';
import type { SqliteHandle } from '../db/sqlite';

/** Metadata extracted from the first NDJSON line. */
export interface EmbeddingsMeta {
  embedModel: string;
  embedDim: number;
  embedDtype: string;
  count: number;
}

export interface StreamingImportSummary {
  embeddingsImported: number;
  embeddingsSkipped: number;
  errors: string[];
  meta: EmbeddingsMeta | null;
}

const BATCH_SIZE = 500;
const TEXT_DECODER = new TextDecoder();

interface PendingEmbedding {
  tweetId: string;
  model: string;
  dim: number;
  dtype: 'int8' | 'float32';
  scale: number | null;
  offset: number | null;
  vector: Uint8Array;
}

/** atob is available in browsers and Node 16+. We avoid Buffer so the same
 *  code runs in the worker. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Parse a single NDJSON line into a PendingEmbedding, or null if it's a
 *  metadata line or malformed (error pushed to `errors`). */
function parseLine(
  line: string,
  errors: string[],
  lineNum: number,
): PendingEmbedding | 'meta' | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    errors.push(`line ${lineNum}: invalid JSON (${(e as Error).message})`);
    return null;
  }
  if (obj._meta === true) return 'meta';
  const tweetId = typeof obj.tweet_id === 'string' ? obj.tweet_id : null;
  const model = typeof obj.model === 'string' ? obj.model : null;
  const dim = typeof obj.dim === 'number' ? obj.dim : null;
  const dtype = obj.dtype;
  const vectorB64 = typeof obj.vector_b64 === 'string' ? obj.vector_b64 : null;
  if (!tweetId || !model || !dim || !vectorB64) {
    errors.push(`line ${lineNum}: missing required fields`);
    return null;
  }
  if (dtype !== 'int8' && dtype !== 'float32') {
    errors.push(`line ${lineNum}: unsupported dtype ${String(dtype)}`);
    return null;
  }
  let vector: Uint8Array;
  try {
    vector = base64ToBytes(vectorB64);
  } catch (e) {
    errors.push(`line ${lineNum}: vector_b64 decode failed (${(e as Error).message})`);
    return null;
  }
  const expectedBytes = dtype === 'int8' ? dim : dim * 4;
  if (vector.byteLength !== expectedBytes) {
    errors.push(`line ${lineNum}: dim mismatch (expected ${expectedBytes} bytes, got ${vector.byteLength})`);
    return null;
  }
  return {
    tweetId,
    model,
    dim,
    dtype,
    scale: typeof obj.scale === 'number' ? obj.scale : null,
    offset: typeof obj.offset === 'number' ? obj.offset : null,
    vector,
  };
}

/** Flush a batch of embeddings into embDb in a single transaction. */
function flushBatch(
  embDb: Database,
  batch: PendingEmbedding[],
  knownIds: Set<string>,
  summary: StreamingImportSummary,
): void {
  if (batch.length === 0) return;
  transaction(embDb, () => {
    const stmt = embDb.prepare(`
      INSERT INTO tweet_embeddings (tweet_id, model, dim, dtype, scale, offset, vector, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tweet_id, model) DO UPDATE SET
        dim = excluded.dim,
        dtype = excluded.dtype,
        scale = excluded.scale,
        offset = excluded.offset,
        vector = excluded.vector,
        created_at = excluded.created_at
    `);
    const now = Math.floor(Date.now() / 1000);
    try {
      for (const e of batch) {
        if (!knownIds.has(e.tweetId)) {
          summary.embeddingsSkipped++;
          continue;
        }
        stmt.bind([e.tweetId, e.model, e.dim, e.dtype, e.scale, e.offset, e.vector, now]);
        while (stmt.step()) { /* no-op */ }
        stmt.reset();
        summary.embeddingsImported++;
      }
    } finally {
      stmt.free();
    }
  });
}

/** Yield to the event loop so the UI can paint and a killed tab can be
 *  resumed on the next sync. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Collect known tweet IDs from the main db. Embeddings are gated on this
 *  set so a device only stores vectors for tweets it actually has. */
function collectTweetIds(db: Database): Set<string> {
  const out = new Set<string>();
  const stmt = db.prepare('SELECT id FROM tweets');
  try {
    while (stmt.step()) {
      const row = stmt.get();
      if (typeof row[0] === 'string') out.add(row[0]);
    }
  } finally {
    stmt.free();
  }
  return out;
}

/** Stream-import embeddings from a fetch Response.
 *
 *  Caller provides the Response (already fetched with credentials). This
 *  function reads body chunks, parses NDJSON lines, and inserts in batches.
 *  Between batches it yields to the event loop and periodically calls
 *  onCheckpoint so the embDb is persisted to IndexedDB - a killed tab
 *  resumes on the next sync because the version token is only recorded
 *  after the full import completes.
 */
export async function streamImportEmbeddings(
  handle: SqliteHandle,
  response: Response,
  onProgress?: (msg: string) => void,
  onCheckpoint?: () => Promise<void>,
): Promise<StreamingImportSummary> {
  const summary: StreamingImportSummary = {
    embeddingsImported: 0,
    embeddingsSkipped: 0,
    errors: [],
    meta: null,
  };

  if (!response.body) {
    summary.errors.push('response has no body stream');
    return summary;
  }

  const knownIds = collectTweetIds(handle.db);
  const reader = response.body.getReader();
  const batch: PendingEmbedding[] = [];
  let buffer = '';
  let lineNum = 0;
  let batchesFlushed = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += TEXT_DECODER.decode(value, { stream: true });

      // Process complete lines from the buffer.
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        lineNum++;
        const parsed = parseLine(line, summary.errors, lineNum);
        if (parsed === 'meta') {
          // Parse metadata from the first line.
          try {
            const meta = JSON.parse(line.trim());
            summary.meta = {
              embedModel: typeof meta.embed_model === 'string' ? meta.embed_model : '',
              embedDim: typeof meta.embed_dim === 'number' ? meta.embed_dim : 0,
              embedDtype: typeof meta.embed_dtype === 'string' ? meta.embed_dtype : '',
              count: typeof meta.count === 'number' ? meta.count : 0,
            };
          } catch {
            // Already counted as an error in parseLine if it was malformed.
          }
          continue;
        }
        if (parsed) {
          batch.push(parsed);
          if (batch.length >= BATCH_SIZE) {
            flushBatch(handle.embDb, batch, knownIds, summary);
            batch.length = 0;
            batchesFlushed++;
            // Persist + yield every few batches so a kill resumes cleanly.
            if (batchesFlushed % 4 === 0) {
              await handle.flushEmbeddings();
              await onCheckpoint?.();
              onProgress?.(`Importing embeddings… ${summary.embeddingsImported} loaded`);
              await yieldToEventLoop();
            }
          }
        }
      }
    }

    // Flush any remaining rows in the final partial batch.
    if (batch.length > 0) {
      flushBatch(handle.embDb, batch, knownIds, summary);
    }

    // Final persist.
    await handle.flushEmbeddings();
    await onCheckpoint?.();
    onProgress?.(`Embeddings import complete: ${summary.embeddingsImported} loaded`);
  } finally {
    reader.releaseLock();
  }

  return summary;
}
