// Imports the parsed output of enrich.py into SQLite.
//
// Idempotency contract (mirrors replaceClassifierAssignments in categories.ts):
//
//   - tweet_embeddings: UPSERT on (tweet_id, model). Re-importing the same
//     enriched.json refreshes scale/offset/vector but keeps prior model rows
//     so an A/B between embedding models doesn't lose work.
//   - enrichments (url_content, image_description): UPSERT on
//     (tweet_id, type, source_ref, model). url_content rows have a non-null
//     model literal ('trafilatura') because SQLite's UNIQUE treats NULL as
//     distinct, which would block re-import idempotency otherwise.
//
// Inserts are chunked at CHUNK_SIZE rows per BEGIN/COMMIT to keep sql.js
// WASM memory steady - the full corpus (26K embeddings + ~10K image desc +
// few hundred url contents) completes in ~30 transactions, seconds total.

import type { Database } from 'sql.js';
import { transaction } from '../exec';
import type {
  ParsedEnriched,
  ParsedEmbedding,
  ParsedUrlEnrichment,
  ParsedImageEnrichment,
} from '../../parser/enrichedExport';

const CHUNK_SIZE = 1000;

// SQLite stores model = NULL as distinct under UNIQUE, so url_content rows
// get a literal sentinel that names the extractor instead.
const URL_EXTRACTOR_MODEL = 'trafilatura';

export interface ImportEnrichedSummary {
  embeddingsImported: number;
  urlEnrichmentsImported: number;
  imageEnrichmentsImported: number;
  embeddingsSkipped: number;
  urlEnrichmentsSkipped: number;
  imageEnrichmentsSkipped: number;
  errors: string[];
}

export function importEnrichedData(
  db: Database,
  embDb: Database,
  payload: Pick<ParsedEnriched, 'embeddings' | 'urlEnrichments' | 'imageEnrichments'>,
): ImportEnrichedSummary {
  const summary: ImportEnrichedSummary = {
    embeddingsImported: 0,
    urlEnrichmentsImported: 0,
    imageEnrichmentsImported: 0,
    embeddingsSkipped: 0,
    urlEnrichmentsSkipped: 0,
    imageEnrichmentsSkipped: 0,
    errors: [],
  };

  // The known-id set comes from the MAIN db (where tweets live). url/image
  // enrichments FK-reference tweets, so they're gated on it. Embeddings now
  // live in their own db (no FK), but we still gate them on the same set so a
  // device only stores vectors for tweets it actually has.
  const knownIds = collectTweetIds(db);

  importEmbeddings(embDb, payload.embeddings, knownIds, summary);
  importUrlEnrichments(db, payload.urlEnrichments, knownIds, summary);
  importImageEnrichments(db, payload.imageEnrichments, knownIds, summary);

  return summary;
}

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

function importEmbeddings(
  db: Database,
  rows: ParsedEmbedding[],
  knownIds: Set<string>,
  summary: ImportEnrichedSummary,
): void {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    transaction(db, () => {
      const stmt = db.prepare(`
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
        for (const e of slice) {
          if (!knownIds.has(e.tweetId)) {
            summary.embeddingsSkipped++;
            continue;
          }
          stmt.bind([
            e.tweetId,
            e.model,
            e.dim,
            e.dtype,
            e.scale,
            e.offset,
            e.vector,
            now,
          ]);
          while (stmt.step()) {
            // no-op
          }
          stmt.reset();
          summary.embeddingsImported++;
        }
      } finally {
        stmt.free();
      }
    });
  }
}

function importUrlEnrichments(
  db: Database,
  rows: ParsedUrlEnrichment[],
  knownIds: Set<string>,
  summary: ImportEnrichedSummary,
): void {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    transaction(db, () => {
      const stmt = db.prepare(`
        INSERT INTO enrichments
          (tweet_id, type, source_ref, content, model, metadata_json, created_at)
        VALUES (?, 'url_content', ?, ?, ?, ?, ?)
        ON CONFLICT(tweet_id, type, source_ref, model) DO UPDATE SET
          content = excluded.content,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at
      `);
      const now = Math.floor(Date.now() / 1000);
      try {
        for (const u of slice) {
          if (!knownIds.has(u.tweetId)) {
            summary.urlEnrichmentsSkipped++;
            continue;
          }
          const meta = JSON.stringify(u.metadata ?? {});
          stmt.bind([u.tweetId, u.sourceRef, u.content, URL_EXTRACTOR_MODEL, meta, now]);
          while (stmt.step()) {
            // no-op
          }
          stmt.reset();
          summary.urlEnrichmentsImported++;
        }
      } finally {
        stmt.free();
      }
    });
  }
}

function importImageEnrichments(
  db: Database,
  rows: ParsedImageEnrichment[],
  knownIds: Set<string>,
  summary: ImportEnrichedSummary,
): void {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const slice = rows.slice(i, i + CHUNK_SIZE);
    transaction(db, () => {
      const stmt = db.prepare(`
        INSERT INTO enrichments
          (tweet_id, type, source_ref, content, model, metadata_json, created_at)
        VALUES (?, 'image_description', ?, ?, ?, ?, ?)
        ON CONFLICT(tweet_id, type, source_ref, model) DO UPDATE SET
          content = excluded.content,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at
      `);
      const now = Math.floor(Date.now() / 1000);
      try {
        for (const e of slice) {
          if (!knownIds.has(e.tweetId)) {
            summary.imageEnrichmentsSkipped++;
            continue;
          }
          // model nullability: image_description always carries a model name
          // (the Vision model used). Empty string falls back to the same
          // sentinel logic, but in practice this is always populated.
          const model = e.model ?? URL_EXTRACTOR_MODEL;
          const meta = JSON.stringify(e.metadata ?? {});
          stmt.bind([e.tweetId, e.sourceRef, e.content, model, meta, now]);
          while (stmt.step()) {
            // no-op
          }
          stmt.reset();
          summary.imageEnrichmentsImported++;
        }
      } finally {
        stmt.free();
      }
    });
  }
}
