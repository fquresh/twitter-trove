// Hybrid retrieval algorithm - pure code, no Web Worker setup.
//
// Splits cleanly so Vitest can exercise the algorithm against a sql.js DB
// in node, while the Worker (`retrievalWorker.ts`) is just a thin wrapper
// that calls these functions across a postMessage boundary.
//
// Design (plan §hybrid retrieval):
//   1. buildCandidateSet - apply FilterSet (minus the FTS predicate, which
//      gates candidates *and* contributes a rank signal - we want both, not
//      just the rank).
//   2. ftsRank - sql.js FTS4 has no BM25; we use MATCH order as the rank.
//      We restrict to the candidate set after the fact rather than joining
//      twice, because FTS4 doesn't accept `WHERE id IN (...)` predicates
//      against the rowid alongside the MATCH efficiently.
//   3. vectorRank - for each candidate id, look up the int8 blob in the
//      pre-built embeddings Map, dequant + dot against the (L2-normalized)
//      query embedding. Linear scan is faster than min-heap insertion at
//      this scale (<100K candidates).
//   4. RRF fuse - score(id) = Σ 1/(k_RRF + rank). Standard k_RRF = 60.

import type { Database } from 'sql.js';
import { all } from '../db/exec';
import { buildFilterFragments, sanitizeFtsQuery } from '../filters/queryBuilder';
import type { FilterSet } from '../filters/types';

export interface EmbeddingRow {
  tweetId: string;
  dim: number;
  scale: number;
  offset: number;
  blob: Uint8Array;
}

export interface RetrievalHit {
  tweetId: string;
  ftsRank: number | null;
  vecRank: number | null;
  fusedScore: number;
  hasUrlEnrich: boolean;
  hasImgEnrich: boolean;
}

export interface EnrichmentLookup {
  url: Set<string>;
  img: Set<string>;
}

const RRF_K = 60;
const PER_LIST_LIMIT = 50; // top-50 from FTS and from vector before fusing.

// Reconstruct a float32 vector from int8 storage. Used by tests; the dot
// product hot path inlines this in `dotInt8Float` to skip the intermediate
// Float32Array allocation.
export function decodeInt8(
  blob: Uint8Array,
  scale: number,
  offset: number,
  dim: number,
): Float32Array {
  const view = new Int8Array(blob.buffer, blob.byteOffset, dim);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = view[i] * scale + offset;
  return out;
}

// Inline dequant + dot product. Both vectors are L2-normalized so the dot
// equals the cosine similarity. Hot path: offset=0 lets us hoist `scale`
// out of the loop, halving the per-iteration work.
export function dotInt8Float(
  blob: Uint8Array,
  scale: number,
  offset: number,
  q: Float32Array,
): number {
  const view = new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  const n = Math.min(view.length, q.length);
  if (offset === 0) {
    let s = 0;
    for (let i = 0; i < n; i++) s += view[i] * q[i];
    return s * scale;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (view[i] * scale + offset) * q[i];
  return acc;
}

// One-shot index build. Caller (the Worker) holds the Map across queries.
export function buildEmbeddingMap(
  db: Database,
  model: string,
): Map<string, EmbeddingRow> {
  const map = new Map<string, EmbeddingRow>();
  const stmt = db.prepare(
    'SELECT tweet_id, dim, scale, offset, vector FROM tweet_embeddings WHERE model = ?',
  );
  try {
    stmt.bind([model]);
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        tweet_id: string;
        dim: number;
        scale: number;
        offset: number;
        vector: Uint8Array;
      };
      // sql.js BLOBs reference WASM memory; copy so the buffer survives
      // subsequent statements / DB resets.
      const blob = new Uint8Array(row.vector.byteLength);
      blob.set(row.vector);
      map.set(row.tweet_id, {
        tweetId: row.tweet_id,
        dim: row.dim,
        scale: row.scale,
        offset: row.offset,
        blob,
      });
    }
  } finally {
    stmt.free();
  }
  return map;
}

// Look up which tweets have URL extractions or image descriptions, for the
// `has_*_enrich` flags on each retrieval hit. Built once at index time so the
// hot path is two Set membership checks per hit.
export function buildEnrichmentLookup(db: Database): EnrichmentLookup {
  const url = new Set<string>();
  const img = new Set<string>();
  const stmt = db.prepare('SELECT DISTINCT tweet_id, type FROM enrichments');
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { tweet_id: string; type: string };
      if (row.type === 'url_content') url.add(row.tweet_id);
      else if (row.type === 'image_description') img.add(row.tweet_id);
    }
  } finally {
    stmt.free();
  }
  return { url, img };
}

// Apply a FilterSet to get the candidate id set. `stripFts=true` removes the
// FTS join from the WHERE - used by hybridSearch which feeds FTS as a separate
// rank signal. With `stripFts=false` (default) you get the same behavior as
// listTweetsPage, FTS-restricted candidates included.
export function buildCandidateSet(
  db: Database,
  filters: FilterSet,
  opts: { stripFts?: boolean } = {},
): Set<string> {
  const f: FilterSet = opts.stripFts ? { ...filters, q: null } : filters;
  const { whereSql, joinSql, params } = buildFilterFragments(f);
  const rows = all<{ id: string }>(
    db,
    `SELECT t.id FROM tweets t ${joinSql} WHERE ${whereSql}`,
    params,
  );
  return new Set(rows.map((r) => r.id));
}

export function ftsRank(
  db: Database,
  candidates: Set<string>,
  rawQuery: string,
  limit: number = PER_LIST_LIMIT,
): Array<{ id: string; rank: number }> {
  const q = sanitizeFtsQuery(rawQuery);
  if (!q || q === '""') return [];
  // Overfetch and post-filter against the candidate set: FTS4 can't take a
  // JOIN on the candidate temp table efficiently in sql.js, and the candidate
  // set is usually a tight subset so the overfetch is cheap.
  const rows = all<{ id: string }>(
    db,
    `SELECT t.id FROM tweets t
     JOIN tweets_fts ON tweets_fts.docid = t.rowid
     WHERE tweets_fts MATCH ?
     LIMIT ?`,
    [q, Math.max(limit * 4, 200)],
  );
  const out: Array<{ id: string; rank: number }> = [];
  let rank = 1;
  for (const r of rows) {
    if (!candidates.has(r.id)) continue;
    out.push({ id: r.id, rank });
    rank++;
    if (out.length >= limit) break;
  }
  return out;
}

export function vectorRank(
  candidates: Set<string>,
  embeddings: Map<string, EmbeddingRow>,
  queryEmbedding: Float32Array,
  limit: number = PER_LIST_LIMIT,
): Array<{ id: string; score: number; rank: number }> {
  const scored: Array<{ id: string; score: number }> = [];
  for (const id of candidates) {
    const e = embeddings.get(id);
    if (!e) continue;
    const score = dotInt8Float(e.blob, e.scale, e.offset, queryEmbedding);
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  return top.map((s, i) => ({ id: s.id, score: s.score, rank: i + 1 }));
}

// Reciprocal Rank Fusion. `kRRF` smooths the long tail; 60 is the canonical
// constant from the original Cormack et al. paper.
export function rrf(
  rankedLists: Array<Array<{ id: string; rank: number }>>,
  k: number,
  kRRF: number = RRF_K,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const { id, rank } of list) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (kRRF + rank));
    }
  }
  const out: Array<{ id: string; score: number }> = [];
  for (const [id, score] of scores) out.push({ id, score });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

export interface HybridSearchInput {
  db: Database;
  embeddings: Map<string, EmbeddingRow>;
  enrichmentLookup: EnrichmentLookup;
  queryEmbedding: Float32Array;
  ftsQuery: string | null;
  filters: FilterSet;
  k?: number;
}

export function hybridSearchSync({
  db,
  embeddings,
  enrichmentLookup,
  queryEmbedding,
  ftsQuery,
  filters,
  k = 20,
}: HybridSearchInput): RetrievalHit[] {
  // Filters-first. Strip FilterSet.q so the FTS predicate doesn't double-apply
  // (we feed ftsQuery in as a separate rank signal in step 2).
  const candidates = buildCandidateSet(db, filters, { stripFts: true });
  if (candidates.size === 0) return [];

  const ftsHits = ftsQuery && ftsQuery.trim()
    ? ftsRank(db, candidates, ftsQuery)
    : [];
  const vecHits = embeddings.size > 0
    ? vectorRank(candidates, embeddings, queryEmbedding)
    : [];

  const lists: Array<Array<{ id: string; rank: number }>> = [];
  if (ftsHits.length > 0) lists.push(ftsHits);
  if (vecHits.length > 0) lists.push(vecHits);
  if (lists.length === 0) return [];

  const fused = rrf(lists, k);
  const ftsRankById = new Map(ftsHits.map((h) => [h.id, h.rank] as const));
  const vecRankById = new Map(vecHits.map((h) => [h.id, h.rank] as const));

  return fused.map(({ id, score }) => ({
    tweetId: id,
    ftsRank: ftsRankById.get(id) ?? null,
    vecRank: vecRankById.get(id) ?? null,
    fusedScore: score,
    hasUrlEnrich: enrichmentLookup.url.has(id),
    hasImgEnrich: enrichmentLookup.img.has(id),
  }));
}

// Plan §risk register #4: rebuild the in-memory index only when the
// underlying DB has changed. Cheap hash over (count, max created_at) - both
// values are O(1) lookups on indexed columns. Returns a string for direct
// equality compares.
export function computeIndexHash(db: Database): string {
  const r = db.exec(
    'SELECT COUNT(*), COALESCE(MAX(created_at), 0) FROM tweet_embeddings',
  );
  const count = (r[0]?.values[0]?.[0] as number) ?? 0;
  const maxCreated = (r[0]?.values[0]?.[1] as number) ?? 0;
  return `${count}:${maxCreated}`;
}
