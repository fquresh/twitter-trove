// Web Worker that owns its own sql.js DB mirror + the in-memory embeddings
// Map. Main-thread API in `retrieval.ts` posts messages here.
//
// Lifecycle:
//   - 'init' / 'reload': deserialize the dbBytes into sql.js, build the
//     embeddings Map (filtered to the requested model) and the enrichments
//     lookup. Post 'ready' with embeddingCount + indexHash.
//   - 'search': run hybridSearchSync against the live state. Post 'results'.
//
// We keep the worker alive across navigations (the App-level singleton in
// retrieval.ts), so re-init is rare. The plan's index-rebuild guard
// (computeIndexHash) means a no-op re-init returns ~instantly.

/// <reference lib="webworker" />
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import {
  buildEmbeddingMap,
  buildEnrichmentLookup,
  computeIndexHash,
  hybridSearchSync,
  type EmbeddingRow,
  type EnrichmentLookup,
  type RetrievalHit,
} from './retrievalCore';
import type { FilterSet } from '../filters/types';

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let embDb: Database | null = null;
let embeddings: Map<string, EmbeddingRow> = new Map();
let enrichmentLookup: EnrichmentLookup = { url: new Set(), img: new Set() };
let currentModel = '';
let lastIndexHash = '';

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: (file: string) => `/${file}` });
  }
  return SQL;
}

interface InitMessage {
  type: 'init' | 'reload';
  requestId: string;
  dbBytes: Uint8Array;
  embBytes: Uint8Array;
  model: string;
}

interface SearchMessage {
  type: 'search';
  requestId: string;
  queryEmbedding: Float32Array;
  ftsQuery: string | null;
  filters: FilterSet;
  k?: number;
}

type WorkerMessage = InitMessage | SearchMessage;

interface ReadyResponse {
  type: 'ready';
  requestId: string;
  embeddingCount: number;
  indexHash: string;
  rebuilt: boolean;
}

interface ResultsResponse {
  type: 'results';
  requestId: string;
  hits: RetrievalHit[];
  elapsedMs: number;
}

interface ErrorResponse {
  type: 'error';
  requestId: string;
  error: string;
}

self.onmessage = async (ev: MessageEvent<WorkerMessage>): Promise<void> => {
  const msg = ev.data;
  try {
    if (msg.type === 'init' || msg.type === 'reload') {
      const sql = await loadSqlJs();
      // Always swap in the new bytes - the caller knows when an import happened.
      // Main db holds tweets/FTS/enrichments; embDb holds the vectors (schema v4
      // split). The embedding index is built from embDb; FTS + filters run on db.
      if (db) db.close();
      db = new sql.Database(msg.dbBytes);
      if (embDb) embDb.close();
      embDb = new sql.Database(msg.embBytes);

      const newHash = computeIndexHash(embDb);
      const modelChanged = msg.model !== currentModel;
      const rebuild = msg.type === 'reload' || modelChanged || newHash !== lastIndexHash;
      if (rebuild) {
        embeddings = buildEmbeddingMap(embDb, msg.model);
        enrichmentLookup = buildEnrichmentLookup(db);
        currentModel = msg.model;
        lastIndexHash = newHash;
      }

      const reply: ReadyResponse = {
        type: 'ready',
        requestId: msg.requestId,
        embeddingCount: embeddings.size,
        indexHash: lastIndexHash,
        rebuilt: rebuild,
      };
      self.postMessage(reply);
      return;
    }

    if (msg.type === 'search') {
      if (!db) throw new Error('worker not initialized - call init first');
      const t0 = performance.now();
      const hits = hybridSearchSync({
        db,
        embeddings,
        enrichmentLookup,
        queryEmbedding: msg.queryEmbedding,
        ftsQuery: msg.ftsQuery,
        filters: msg.filters,
        k: msg.k,
      });
      const elapsedMs = performance.now() - t0;
      const reply: ResultsResponse = {
        type: 'results',
        requestId: msg.requestId,
        hits,
        elapsedMs,
      };
      self.postMessage(reply);
      return;
    }
  } catch (e) {
    const reply: ErrorResponse = {
      type: 'error',
      requestId: msg.requestId,
      error: (e as Error).message,
    };
    self.postMessage(reply);
  }
};

// Tell TS this file is a module so the global `self` declarations don't bleed.
export {};
