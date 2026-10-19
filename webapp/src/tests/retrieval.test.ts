// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import {
  decodeInt8,
  dotInt8Float,
  rrf,
  vectorRank,
  hybridSearchSync,
  buildEmbeddingMap,
  buildEnrichmentLookup,
  computeIndexHash,
} from '../chat/retrievalCore';
import { emptyFilterSet } from '../filters/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
});

// L2-normalize a Float32Array in place (also returns it for convenience).
function l2Normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Quantize a (L2-normalized) Float32 vector to int8 with offset=0, matching
// enrich.py's quantize_int8.
function quantizeInt8(v: Float32Array): { blob: Uint8Array; scale: number } {
  let absMax = 0;
  for (let i = 0; i < v.length; i++) absMax = Math.max(absMax, Math.abs(v[i]));
  if (absMax === 0) return { blob: new Uint8Array(v.length), scale: 0 };
  const scale = absMax / 127;
  const blob = new Uint8Array(v.length);
  const view = new Int8Array(blob.buffer);
  for (let i = 0; i < v.length; i++) {
    view[i] = Math.max(-127, Math.min(127, Math.round(v[i] / scale)));
  }
  return { blob, scale };
}

describe('decodeInt8 / dotInt8Float', () => {
  it('round-trips a vector through int8 within tight tolerance', () => {
    const v = l2Normalize(new Float32Array([0.1, -0.5, 0.8, 0.3, -0.2]));
    const { blob, scale } = quantizeInt8(v);
    const recon = decodeInt8(blob, scale, 0, v.length);
    let cos = 0;
    for (let i = 0; i < v.length; i++) cos += v[i] * recon[i];
    // L2-normalized recon ≠ v exactly because of int8 rounding, but cosine
    // should still be very near 1.0.
    expect(cos).toBeGreaterThan(0.998);
  });

  it('dotInt8Float matches decode-then-dot exactly', () => {
    const v = l2Normalize(new Float32Array([0.4, 0.1, -0.7, 0.2, 0.3]));
    const q = l2Normalize(new Float32Array([0.5, -0.3, 0.6, 0.1, 0.0]));
    const { blob, scale } = quantizeInt8(v);
    const recon = decodeInt8(blob, scale, 0, v.length);
    let viaDecode = 0;
    for (let i = 0; i < v.length; i++) viaDecode += recon[i] * q[i];
    const viaInline = dotInt8Float(blob, scale, 0, q);
    expect(viaInline).toBeCloseTo(viaDecode, 6);
  });

  it('handles a non-zero offset', () => {
    const dim = 4;
    const blob = new Uint8Array(dim);
    const view = new Int8Array(blob.buffer);
    view[0] = 10; view[1] = -5; view[2] = 3; view[3] = 0;
    const scale = 0.01;
    const offset = 0.5;
    const q = new Float32Array([1, 1, 1, 1]);
    const got = dotInt8Float(blob, scale, offset, q);
    const want = (10 * scale + offset) + (-5 * scale + offset) + (3 * scale + offset) + (0 * scale + offset);
    expect(got).toBeCloseTo(want, 6);
  });

  it('zero-vector path returns zero', () => {
    const dim = 8;
    const blob = new Uint8Array(dim);
    const q = new Float32Array(dim).fill(0.5);
    expect(dotInt8Float(blob, 0, 0, q)).toBe(0);
  });
});

describe('rrf', () => {
  it('ranks the union with the standard 1/(60+rank) score', () => {
    const fts = [
      { id: 'a', rank: 1 },
      { id: 'b', rank: 2 },
      { id: 'c', rank: 3 },
    ];
    const vec = [
      { id: 'b', rank: 1 },
      { id: 'a', rank: 2 },
      { id: 'd', rank: 3 },
    ];
    const fused = rrf([fts, vec], 4);
    expect(fused.map((h) => h.id)).toEqual(['a', 'b', 'c', 'd']);
    // a: 1/61 + 1/62 ≈ 0.03253
    // b: 1/62 + 1/61 ≈ 0.03253 - actually identical to a numerically; tie order is sort-stable
    // c: 1/63 ≈ 0.01587
    // d: 1/63 ≈ 0.01587
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 8);
    expect(fused[2].score).toBeCloseTo(1 / 63, 8);
  });

  it('handles a single ranked list (FTS-only or vector-only)', () => {
    const fused = rrf([[
      { id: 'x', rank: 1 },
      { id: 'y', rank: 2 },
    ]], 5);
    expect(fused).toHaveLength(2);
    expect(fused[0].id).toBe('x');
    expect(fused[1].id).toBe('y');
  });

  it('clamps to k', () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, rank: i + 1 }));
    const fused = rrf([list], 3);
    expect(fused).toHaveLength(3);
  });

  it('returns empty for empty input lists', () => {
    expect(rrf([], 5)).toEqual([]);
    expect(rrf([[], []], 5)).toEqual([]);
  });
});

// ── DB-backed end-to-end hybrid search tests ──────────────────────────────
function freshDb(): Database {
  const db = new SQL.Database();
  applyMigrations(db);
  return db;
}

function insertTweetWithEmbedding(
  db: Database,
  id: string,
  content: string,
  vec: Float32Array,
  model = 'voyage-3-large',
): void {
  db.exec(`
    INSERT INTO tweets (id, author_handle, content, created_at, imported_at)
    VALUES ('${id}', 'alice', '${content.replace(/'/g, "''")}', 1700000000, 1700000000);
  `);
  const { blob, scale } = quantizeInt8(l2Normalize(new Float32Array(vec)));
  const stmt = db.prepare(`
    INSERT INTO tweet_embeddings (tweet_id, model, dim, dtype, scale, offset, vector, created_at)
    VALUES (?, ?, ?, 'int8', ?, 0, ?, 1700000000)
  `);
  stmt.bind([id, model, vec.length, scale, blob]);
  while (stmt.step()) { /* no-op */ }
  stmt.free();
}

describe('vectorRank - DB-backed', () => {
  it('returns candidates ordered by cosine similarity', () => {
    const db = freshDb();
    const dim = 16;
    // Build three tweets with carefully placed vectors:
    // tweet A: matches the query
    // tweet B: semi-matches (≈45° off)
    // tweet C: nearly orthogonal
    const queryRaw = new Float32Array(dim);
    queryRaw[0] = 1; queryRaw[1] = 0.5;
    const query = l2Normalize(queryRaw);

    const aRaw = new Float32Array(dim);
    aRaw[0] = 1; aRaw[1] = 0.6;
    const bRaw = new Float32Array(dim);
    bRaw[0] = 0.5; bRaw[1] = 0.4; bRaw[2] = 0.3;
    const cRaw = new Float32Array(dim);
    cRaw[3] = 1; cRaw[4] = 1;

    insertTweetWithEmbedding(db, '1', 'alpha', aRaw);
    insertTweetWithEmbedding(db, '2', 'beta', bRaw);
    insertTweetWithEmbedding(db, '3', 'gamma', cRaw);

    const embeddings = buildEmbeddingMap(db, 'voyage-3-large');
    const candidates = new Set(['1', '2', '3']);
    const ranked = vectorRank(candidates, embeddings, query, 10);

    expect(ranked.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
    db.close();
  });
});

describe('hybridSearchSync', () => {
  function buildCorpus(db: Database, dim = 16) {
    // Two clusters: AI tweets + crypto tweets.
    const aiCenter = new Float32Array(dim); aiCenter[0] = 1; aiCenter[1] = 1;
    const cryptoCenter = new Float32Array(dim); cryptoCenter[5] = 1; cryptoCenter[6] = 1;

    const make = (base: Float32Array, jitter: number) => {
      const v = new Float32Array(base);
      for (let i = 0; i < dim; i++) v[i] += (Math.random() - 0.5) * jitter;
      return v;
    };

    insertTweetWithEmbedding(db, '1', 'agents are autonomous', make(aiCenter, 0.05));
    insertTweetWithEmbedding(db, '2', 'agents need scaffolding', make(aiCenter, 0.05));
    insertTweetWithEmbedding(db, '3', 'transformers scale well', make(aiCenter, 0.05));
    insertTweetWithEmbedding(db, '4', 'btc on chain volume', make(cryptoCenter, 0.05));
    insertTweetWithEmbedding(db, '5', 'ethereum gas spike', make(cryptoCenter, 0.05));
    return { aiCenter, cryptoCenter };
  }

  it('returns vector-only results when ftsQuery is null', () => {
    const db = freshDb();
    const { aiCenter } = buildCorpus(db);
    const embeddings = buildEmbeddingMap(db, 'voyage-3-large');
    const enrichmentLookup = buildEnrichmentLookup(db);

    const query = l2Normalize(new Float32Array(aiCenter));
    const hits = hybridSearchSync({
      db, embeddings, enrichmentLookup,
      queryEmbedding: query,
      ftsQuery: null,
      filters: emptyFilterSet(),
      k: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    // Top results should be AI tweets.
    const top3 = hits.slice(0, 3).map((h) => h.tweetId);
    for (const id of top3) expect(['1', '2', '3']).toContain(id);
    // None of these have URL/img enrichments yet.
    expect(hits.every((h) => h.hasUrlEnrich === false && h.hasImgEnrich === false)).toBe(true);
    // ftsRank is null for every hit since we passed null ftsQuery.
    expect(hits.every((h) => h.ftsRank === null && h.vecRank !== null)).toBe(true);
    db.close();
  });

  it('blends FTS with vector via RRF when both signals are present', () => {
    const db = freshDb();
    buildCorpus(db);
    const embeddings = buildEmbeddingMap(db, 'voyage-3-large');
    const enrichmentLookup = buildEnrichmentLookup(db);

    // Query is in the AI cluster; FTS is also "agents".
    const aiQuery = l2Normalize(new Float32Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const hits = hybridSearchSync({
      db, embeddings, enrichmentLookup,
      queryEmbedding: aiQuery,
      ftsQuery: 'agents',
      filters: emptyFilterSet(),
      k: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    // Tweets 1 and 2 contain "agents" so they should appear in both lists,
    // surfacing via RRF as the top hits.
    const topIds = hits.slice(0, 2).map((h) => h.tweetId).sort();
    expect(topIds).toEqual(['1', '2']);
    // Each top hit has both ranks populated.
    expect(hits.find((h) => h.tweetId === '1')?.ftsRank).not.toBeNull();
    expect(hits.find((h) => h.tweetId === '1')?.vecRank).not.toBeNull();
    db.close();
  });

  it('respects the filter set (filters-first)', () => {
    const db = freshDb();
    buildCorpus(db);
    const embeddings = buildEmbeddingMap(db, 'voyage-3-large');
    const enrichmentLookup = buildEnrichmentLookup(db);

    // Filter to a date range that excludes everything.
    const filters = emptyFilterSet();
    filters.from = 9_999_999_999; // 2286
    filters.to = 9_999_999_999;

    const aiQuery = l2Normalize(new Float32Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const hits = hybridSearchSync({
      db, embeddings, enrichmentLookup,
      queryEmbedding: aiQuery,
      ftsQuery: 'agents',
      filters,
      k: 10,
    });
    expect(hits).toEqual([]);
    db.close();
  });

  it('flags has_url_enrich / has_img_enrich on each hit', () => {
    const db = freshDb();
    buildCorpus(db);
    db.exec(`
      INSERT INTO enrichments
        (tweet_id, type, source_ref, content, model, metadata_json, created_at)
      VALUES ('1', 'image_description', 'https://x', 'a chart', 'haiku', '{}', 1700000000);
    `);
    db.exec(`
      INSERT INTO enrichments
        (tweet_id, type, source_ref, content, model, metadata_json, created_at)
      VALUES ('2', 'url_content', 'https://y', 'an article', 'trafilatura', '{}', 1700000000);
    `);
    const embeddings = buildEmbeddingMap(db, 'voyage-3-large');
    const enrichmentLookup = buildEnrichmentLookup(db);

    const aiQuery = l2Normalize(new Float32Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const hits = hybridSearchSync({
      db, embeddings, enrichmentLookup,
      queryEmbedding: aiQuery,
      ftsQuery: null,
      filters: emptyFilterSet(),
      k: 10,
    });

    const h1 = hits.find((h) => h.tweetId === '1');
    const h2 = hits.find((h) => h.tweetId === '2');
    expect(h1?.hasImgEnrich).toBe(true);
    expect(h1?.hasUrlEnrich).toBe(false);
    expect(h2?.hasImgEnrich).toBe(false);
    expect(h2?.hasUrlEnrich).toBe(true);
    db.close();
  });
});

describe('computeIndexHash', () => {
  it('changes when embeddings are added', () => {
    const db = freshDb();
    const before = computeIndexHash(db);
    insertTweetWithEmbedding(db, '1', 'hi', new Float32Array(16).fill(0.5));
    const after = computeIndexHash(db);
    expect(before).not.toBe(after);
    db.close();
  });
});
