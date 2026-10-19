// Device-capability logic for the ⟳ sync + the enriched/embeddings skip. Runs
// in the node env so sql.js resolves its wasm from the filesystem (like
// sqlite.test / sync.test).
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// shouldSkipEnriched's 'auto' branch is gated on PROXY_MODE, which is captured
// at module load from import.meta.env.VITE_USE_API_PROXY. Stub it TRUE before
// importing the module so the cloud-mode auto path is what we test.
vi.stubEnv('VITE_USE_API_PROXY', 'true');
const { shouldSkipEnriched, shouldFetchEmbeddingsOnly, syncFromDisk } = await import('../lib/syncFromDisk');
const { applyMigrations } = await import('../db/sqlite');
const { getSyncState } = await import('../db/queries/outbox');
import type { SqliteHandle } from '../db/sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

describe('shouldSkipEnriched', () => {
  it('skips on an iPhone (auto)', () => {
    expect(shouldSkipEnriched(IPHONE_UA, undefined, 'auto')).toBe(true);
  });

  it('skips on an Android phone (auto)', () => {
    expect(shouldSkipEnriched(ANDROID_UA, undefined, 'auto')).toBe(true);
  });

  it('does NOT skip on a real desktop Mac (auto)', () => {
    // No touch, plenty of memory → a real Mac. maxTouchPoints defaults to 0.
    expect(shouldSkipEnriched(MAC_UA, 8, 'auto')).toBe(false);
  });

  it('skips an iPad masquerading as a Mac (maxTouchPoints > 1)', () => {
    // iPadOS 13+ reports a Mac UA; only maxTouchPoints unmasks it.
    expect(shouldSkipEnriched(MAC_UA, undefined, 'auto', 5)).toBe(true);
    // Same UA without touch is a real Mac → keep the download.
    expect(shouldSkipEnriched(MAC_UA, undefined, 'auto', 0)).toBe(false);
  });

  it('skips a low-memory device (deviceMemory <= 4)', () => {
    expect(shouldSkipEnriched(MAC_UA, 4, 'auto')).toBe(true);
    expect(shouldSkipEnriched(MAC_UA, 2, 'auto')).toBe(true);
    expect(shouldSkipEnriched(MAC_UA, 8, 'auto')).toBe(false);
  });

  it("'always' skips the full file on an iPhone (streaming NDJSON handles embeddings)", () => {
    expect(shouldSkipEnriched(IPHONE_UA, 1, 'always', 5)).toBe(true);
  });

  it("'always' does NOT skip on a real desktop Mac (full file is fine)", () => {
    expect(shouldSkipEnriched(MAC_UA, 8, 'always', 0)).toBe(false);
  });
});
describe('shouldFetchEmbeddingsOnly', () => {
  it('returns true for auto', () => {
    expect(shouldFetchEmbeddingsOnly('auto')).toBe(true);
  });

  it('returns true for always', () => {
    expect(shouldFetchEmbeddingsOnly('always')).toBe(true);
  });

  it('returns false for never', () => {
    expect(shouldFetchEmbeddingsOnly('never')).toBe(false);
  });
});

// --- Integration: skipEnriched: true never fetches the enriched URL ----------

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeHandle(): SqliteHandle {
  const db = new SQL.Database();
  applyMigrations(db);
  const embDb = new SQL.Database();
  return {
    db,
    embDb,
    flush: async () => {},
    flushEmbeddings: async () => {},
    markDirty: () => {},
    replace: async () => {},
    export: () => new Uint8Array(),
    exportEmbeddings: () => new Uint8Array(),
    close: async () => {},
  };
}

describe('syncFromDisk skipEnriched', () => {
  it('never fetches enriched_tweets.json and leaves its ETag unset when skipEnriched=true', async () => {
    const handle = makeHandle();
    // Only the enriched file in the manifest - so the ONLY thing that could be
    // fetched beyond the manifest itself is the enriched payload.
    const manifest = {
      root_files: {
        'enriched_tweets.json': { mtime: 1, size: 10, etag: 'abc' },
      },
      html_files: [],
    };

    const fetched: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      fetched.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => manifest,
        text: async () => JSON.stringify(manifest),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await syncFromDisk(handle, { skipEnriched: true });

    // Only the manifest was fetched - never the enriched payload.
    expect(fetched.some((u) => u.includes('enriched_tweets.json'))).toBe(false);
    expect(summary.errors).toEqual([]);
    // The ETag token was NOT recorded, so a later sync (with the setting flipped)
    // will re-fetch the file.
    expect(getSyncState(handle.db, 'import_etag:enriched_tweets.json')).toBeNull();
  });
});
