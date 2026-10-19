// Tests for the streaming NDJSON embeddings importer.
// Covers: lines split across chunk boundaries, malformed line salvage,
// idempotent re-import (UPSERT), metadata header parsing.
// @vitest-environment node

import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import { EMBEDDINGS_SCHEMA } from '../db/schema';
import { streamImportEmbeddings } from '../lib/streamingEmbeddingsImport';
import type { SqliteHandle } from '../db/sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => WASM });
});

function makeHandle(): SqliteHandle {
  const db = new SQL.Database();
  applyMigrations(db);
  const embDb = new SQL.Database();
  EMBEDDINGS_SCHEMA.forEach((s) => embDb.exec(s));
  return {
    db,
    embDb,
    flush: async () => {},
    flushEmbeddings: async () => {},
    markDirty: () => {},
    replace: async () => {},
    export: () => db.export(),
    exportEmbeddings: () => embDb.export(),
    async close() {
      db.close();
      embDb.close();
    },
  };
}

/** Build a fake Response whose body is a ReadableStream that yields the
 *  given chunks (simulating network fragmentation). */
function makeResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** A valid embedding line for a known tweet id. */
function embLine(tweetId: string, dim = 4): string {
  // int8 vector of `dim` bytes, base64-encoded.
  const bytes = new Uint8Array(dim);
  for (let i = 0; i < dim; i++) bytes[i] = (i + 1) % 128;
  const b64 = btoa(String.fromCharCode(...bytes));
  return JSON.stringify({
    tweet_id: tweetId,
    model: 'voyage-3-large',
    dim,
    dtype: 'int8',
    scale: 0.1,
    offset: -0.2,
    vector_b64: b64,
  });
}

function metaLine(count: number): string {
  return JSON.stringify({
    _meta: true,
    embed_model: 'voyage-3-large',
    embed_dim: 4,
    embed_dtype: 'int8',
    count,
  });
}

function insertTweet(db: Database, id: string) {
  db.run(
    'INSERT INTO tweets (id, author_handle, content, created_at, imported_at) VALUES (?, ?, ?, ?, ?)',
    [id, 'h', 't', 1704067200, 1704067200],
  );
}

function countEmbeddings(embDb: Database): number {
  const r = embDb.exec('SELECT COUNT(*) FROM tweet_embeddings');
  return r[0]?.values[0]?.[0] as number;
}

describe('streamImportEmbeddings', () => {
  it('parses metadata header + embedding lines from a single chunk', async () => {
    const handle = makeHandle();
    insertTweet(handle.db, 't1');
    insertTweet(handle.db, 't2');
    const body = `${metaLine(2)}\n${embLine('t1')}\n${embLine('t2')}\n`;
    const resp = makeResponse([encode(body)]);
    const summary = await streamImportEmbeddings(handle, resp);
    expect(summary.meta).not.toBeNull();
    expect(summary.meta!.embedModel).toBe('voyage-3-large');
    expect(summary.meta!.count).toBe(2);
    expect(summary.embeddingsImported).toBe(2);
    expect(countEmbeddings(handle.embDb)).toBe(2);
  });

  it('handles lines split across chunk boundaries', async () => {
    const handle = makeHandle();
    insertTweet(handle.db, 't1');
    const body = `${metaLine(1)}\n${embLine('t1')}\n`;
    // Split at arbitrary points - including mid-line.
    const all = encode(body);
    const chunks = [all.slice(0, 10), all.slice(10, 25), all.slice(25)];
    const resp = makeResponse(chunks);
    const summary = await streamImportEmbeddings(handle, resp);
    expect(summary.embeddingsImported).toBe(1);
    expect(summary.errors.length).toBe(0);
    expect(countEmbeddings(handle.embDb)).toBe(1);
  });

  it('salvages valid lines around a malformed line', async () => {
    const handle = makeHandle();
    insertTweet(handle.db, 't1');
    insertTweet(handle.db, 't3');
    const body = `${metaLine(3)}\n${embLine('t1')}\n{not valid json\n${embLine('t3')}\n`;
    const resp = makeResponse([encode(body)]);
    const summary = await streamImportEmbeddings(handle, resp);
    expect(summary.embeddingsImported).toBe(2);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toContain('invalid JSON');
    expect(countEmbeddings(handle.embDb)).toBe(2);
  });

  it('skips embeddings for unknown tweet ids', async () => {
    const handle = makeHandle();
    insertTweet(handle.db, 't1');
    // t2 is NOT in the tweets table.
    const body = `${metaLine(2)}\n${embLine('t1')}\n${embLine('t2')}\n`;
    const resp = makeResponse([encode(body)]);
    const summary = await streamImportEmbeddings(handle, resp);
    expect(summary.embeddingsImported).toBe(1);
    expect(summary.embeddingsSkipped).toBe(1);
    expect(countEmbeddings(handle.embDb)).toBe(1);
  });

  it('idempotent re-import: UPSERT does not duplicate rows', async () => {
    const handle = makeHandle();
    insertTweet(handle.db, 't1');
    const body = `${metaLine(1)}\n${embLine('t1')}\n`;
    const resp1 = makeResponse([encode(body)]);
    await streamImportEmbeddings(handle, resp1);
    expect(countEmbeddings(handle.embDb)).toBe(1);
    // Re-import the same data.
    const resp2 = makeResponse([encode(body)]);
    await streamImportEmbeddings(handle, resp2);
    expect(countEmbeddings(handle.embDb)).toBe(1);
  });

  it('detects dim mismatch (vector byte length != dim)', async () => {
    const handle = makeHandle();
    insertTweet(handle.db, 't1');
    // dim=4 but we encode only 2 bytes.
    const bytes = new Uint8Array(2);
    bytes[0] = 1;
    bytes[1] = 2;
    const b64 = btoa(String.fromCharCode(...bytes));
    const line = JSON.stringify({
      tweet_id: 't1',
      model: 'voyage-3-large',
      dim: 4,
      dtype: 'int8',
      scale: 0.1,
      offset: 0,
      vector_b64: b64,
    });
    const body = `${metaLine(1)}\n${line}\n`;
    const resp = makeResponse([encode(body)]);
    const summary = await streamImportEmbeddings(handle, resp);
    expect(summary.embeddingsImported).toBe(0);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toContain('dim mismatch');
  });
});
