// Migrations + import paths are pure SQL - exercise them in node so sql.js
// loads its wasm via the filesystem (matches scripts/perf.ts).
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import { EMBEDDINGS_SCHEMA } from '../db/schema';
import { importEnrichedData } from '../db/queries/enrichments';
import type {
  ParsedEmbedding,
  ParsedUrlEnrichment,
  ParsedImageEnrichment,
} from '../parser/enrichedExport';

const __dirname = dirname(fileURLToPath(import.meta.url));
let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
});

function freshDb(): Database {
  const db = new SQL.Database();
  applyMigrations(db);
  return db;
}

// The embeddings-only db (schema v4 split). importEnrichedData writes vectors here.
function freshEmbDb(): Database {
  const db = new SQL.Database();
  for (const s of EMBEDDINGS_SCHEMA) db.exec(s);
  return db;
}

function insertTweet(db: Database, id: string, handle = 'alice'): void {
  db.exec(`
    INSERT INTO tweets (id, author_handle, content, created_at, imported_at)
    VALUES ('${id}', '${handle}', 'tweet ${id}', 1700000000, 1700000000);
  `);
}

function vec(dim: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(dim);
  const view = new Int8Array(bytes.buffer);
  for (let i = 0; i < dim; i++) view[i] = ((i + fill) % 255) - 127;
  return bytes;
}

function makeEmbedding(tweetId: string, model = 'voyage-3-large', fill = 0): ParsedEmbedding {
  return {
    tweetId,
    model,
    dim: 1024,
    dtype: 'int8',
    scale: 0.001,
    offset: 0,
    vector: vec(1024, fill),
  };
}

describe('importEnrichedData - embeddings (written to the separate embDb)', () => {
  it('inserts new embeddings for known tweets', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');
    insertTweet(db, '2');

    const summary = importEnrichedData(db, emb, {
      embeddings: [makeEmbedding('1'), makeEmbedding('2')],
      urlEnrichments: [],
      imageEnrichments: [],
    });

    expect(summary.embeddingsImported).toBe(2);
    expect(summary.embeddingsSkipped).toBe(0);

    // Vectors land in embDb, NOT the main db.
    expect(emb.exec('SELECT COUNT(*) FROM tweet_embeddings')[0]?.values[0]?.[0]).toBe(2);
    expect(db.exec('SELECT COUNT(*) FROM tweet_embeddings')[0]?.values[0]?.[0]).toBe(0);
    db.close();
    emb.close();
  });

  it('skips embeddings whose tweet_id is unknown (gated on main-db tweets)', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');
    // No tweet '2', so its embedding is dropped.

    const summary = importEnrichedData(db, emb, {
      embeddings: [makeEmbedding('1'), makeEmbedding('2')],
      urlEnrichments: [],
      imageEnrichments: [],
    });

    expect(summary.embeddingsImported).toBe(1);
    expect(summary.embeddingsSkipped).toBe(1);
    db.close();
    emb.close();
  });

  it('UPSERTs on (tweet_id, model) - re-import refreshes the row', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');

    importEnrichedData(db, emb, {
      embeddings: [makeEmbedding('1', 'voyage-3-large', 0)],
      urlEnrichments: [],
      imageEnrichments: [],
    });
    importEnrichedData(db, emb, {
      embeddings: [makeEmbedding('1', 'voyage-3-large', 7)], // different bytes
      urlEnrichments: [],
      imageEnrichments: [],
    });

    const r = emb.exec('SELECT COUNT(*) FROM tweet_embeddings WHERE tweet_id = ?', ['1']);
    expect(r[0]?.values[0]?.[0]).toBe(1);

    // Vector content was refreshed - the second-import bytes should be live.
    const stmt = emb.prepare('SELECT vector FROM tweet_embeddings WHERE tweet_id = ?');
    stmt.bind(['1']);
    stmt.step();
    const row = stmt.get();
    stmt.free();
    const buf = row[0] as Uint8Array;
    expect(new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength)[0]).toBe(((0 + 7) % 255) - 127);
    db.close();
    emb.close();
  });

  it('keeps a different model as a separate row (model is part of the PK)', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');

    importEnrichedData(db, emb, {
      embeddings: [
        makeEmbedding('1', 'voyage-3-large'),
        makeEmbedding('1', 'voyage-3.5'),
      ],
      urlEnrichments: [],
      imageEnrichments: [],
    });

    const r = emb.exec('SELECT COUNT(*) FROM tweet_embeddings WHERE tweet_id = ?', ['1']);
    expect(r[0]?.values[0]?.[0]).toBe(2);
    db.close();
    emb.close();
  });
});

describe('importEnrichedData - enrichments', () => {
  const url = (tid: string, ref: string, content: string): ParsedUrlEnrichment => ({
    tweetId: tid, sourceRef: ref, content, metadata: { status: 'ok' },
  });
  const img = (tid: string, ref: string, content: string): ParsedImageEnrichment => ({
    tweetId: tid, sourceRef: ref, content, model: 'claude-haiku-4-5', metadata: {},
  });

  it('inserts and idempotently re-imports url + image enrichments', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');

    const payload = {
      embeddings: [],
      urlEnrichments: [url('1', 'https://a.example/x', 'first body')],
      imageEnrichments: [img('1', 'https://pbs/x.jpg', 'a bar chart')],
    };
    importEnrichedData(db, emb, payload);
    importEnrichedData(db, emb, payload); // re-import - should be a no-op net-new

    const r = db.exec(`SELECT type, COUNT(*) FROM enrichments GROUP BY type ORDER BY type`);
    const counts = Object.fromEntries(r[0]?.values ?? []);
    expect(counts['image_description']).toBe(1);
    expect(counts['url_content']).toBe(1);
    db.close();
    emb.close();
  });

  it('refreshes the content of an existing enrichment on re-import', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');

    importEnrichedData(db, emb, {
      embeddings: [],
      urlEnrichments: [url('1', 'https://a/x', 'old body')],
      imageEnrichments: [],
    });
    importEnrichedData(db, emb, {
      embeddings: [],
      urlEnrichments: [url('1', 'https://a/x', 'new body')],
      imageEnrichments: [],
    });

    const r = db.exec(`SELECT content FROM enrichments WHERE tweet_id = '1' AND type = 'url_content'`);
    expect(r[0]?.values[0]?.[0]).toBe('new body');
    db.close();
    emb.close();
  });

  it('partial coverage - runs with some sections empty', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');

    const summary = importEnrichedData(db, emb, {
      embeddings: [makeEmbedding('1')],
      urlEnrichments: [],
      imageEnrichments: [],
    });
    expect(summary.embeddingsImported).toBe(1);
    expect(summary.urlEnrichmentsImported).toBe(0);
    expect(summary.imageEnrichmentsImported).toBe(0);
    db.close();
    emb.close();
  });

  it('skips enrichments whose tweet_id is unknown', () => {
    const db = freshDb();
    const emb = freshEmbDb();
    insertTweet(db, '1');

    const summary = importEnrichedData(db, emb, {
      embeddings: [],
      urlEnrichments: [url('1', 'https://a', 'body'), url('2', 'https://b', 'body')],
      imageEnrichments: [img('99', 'https://pbs/x', 'desc')],
    });
    expect(summary.urlEnrichmentsImported).toBe(1);
    expect(summary.urlEnrichmentsSkipped).toBe(1);
    expect(summary.imageEnrichmentsImported).toBe(0);
    expect(summary.imageEnrichmentsSkipped).toBe(1);
    db.close();
    emb.close();
  });
});
