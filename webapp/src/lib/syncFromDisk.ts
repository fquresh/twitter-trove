// One-click data refresh.
//
// Two modes:
//
// - LOCAL (default in dev): fetch from wiki_server.py at http://localhost:8765
//   via `/api/data/manifest` and `/api/data/file?name=…`. Pulls HTML files +
//   derived JSONs.
//
// - PROXY/cloud (`VITE_USE_API_PROXY=true` at build time): fetch the manifest
//   from same-origin `/api/manifest` (Cloudflare Pages Function backed by R2 HEADs) and
//   fetch each JSON directly from `VITE_DATA_BASE_URL/<name>` (the R2 bucket).
//   No HTML files in the cloud - only the derived JSONs.
//
// Both modes feed the same parsers + DB writers as the drag-drop /import path.

import type { SqliteHandle } from '../db/sqlite';
import { parseHtmlExportFiles } from '../parser/htmlExport';
import { parseClassifierObject } from '../parser/classifierJson';
import { isEnrichedObject, parseEnrichedObject } from '../parser/enrichedExport';
import { importHtmlTweets, importClassifierTweets } from '../db/queries/tweets';
import { replaceClassifierAssignments } from '../db/queries/categories';
import { importEnrichedData } from '../db/queries/enrichments';
import { getSyncState, setSyncState } from '../db/queries/outbox';
import { streamImportEmbeddings } from './streamingEmbeddingsImport';
import type { EnrichedImport } from '../state/uiStore';

/** True in the deployed cloud build (`VITE_USE_API_PROXY=true`). Exported so the
 *  UI can decide cloud-only behaviors (e.g. first-load auto-sync, skipping the
 *  heavy embeddings payload on constrained mobile devices). */
export const PROXY_MODE = import.meta.env.VITE_USE_API_PROXY === 'true';
const DEFAULT_LOCAL_BASE = 'http://localhost:8765';

const ENRICHED_FILE = 'enriched_tweets.json';

/**
 * Decide whether to skip the FULL enriched_tweets.json payload (~40 MB) on
 * this device. The full file includes embeddings + url/image enrichments, and
 * on iOS Safari JSON.parse of it OOMs the tab uncatchably. When this returns
 * true, the caller should still try the streaming embeddings.ndjson path
 * (see `shouldFetchEmbeddingsOnly`) - embeddings power chat RAG and are
 * importable in a memory-safe streaming parse; only the url/image enrichments
 * (nice-to-have context) are skipped.
 *
 * Pure so it can be unit-tested. `maxTouchPoints` is needed only to unmask an
 * iPad running iPadOS 13+, which reports a desktop-Mac UA and is otherwise
 * indistinguishable from a real Mac.
 *
 * - 'always' -> on desktop: don't skip (full enriched includes everything).
 *               on mobile: skip (can't monolithic-parse without OOM; the
 *               streaming NDJSON path still delivers embeddings).
 * - 'never'  -> always skip (this device won't do chat RAG at all).
 * - 'auto'   -> skip only in cloud mode on a phone/tablet or low-memory device.
 */
export function shouldSkipEnriched(
  ua: string,
  deviceMemory: number | undefined,
  override: EnrichedImport,
  maxTouchPoints = 0,
): boolean {
  if (override === 'never') return true;

  // 'auto' / 'always': only cloud-mode devices ever skip the full file.
  // Locally the full corpus is cheap to re-read and chat is expected to work.
  if (!PROXY_MODE) return false;

  const isPhoneOrTablet = /iPhone|iPad|iPod|Android/i.test(ua);
  const isMacUA = /Macintosh|Mac OS X/i.test(ua);
  const isIpadAsMac = isMacUA && maxTouchPoints > 1; // iPadOS 13+ masquerading as a Mac
  const isLowMemory = typeof deviceMemory === 'number' && deviceMemory <= 4;

  return isPhoneOrTablet || isIpadAsMac || isLowMemory;
}

/** When the full enriched file is skipped, should we still fetch the streaming
 *  embeddings.ndjson artifact? Embeddings power chat RAG and are memory-safe to
 *  stream-import; only the 'never' setting skips them entirely. */
export function shouldFetchEmbeddingsOnly(override: EnrichedImport): boolean {
  return override !== 'never';
}

export interface DataManifest {
  root_files: Record<string, { mtime: number; size: number; etag?: string }>;
  html_files: Array<{ name: string; mtime: number; size: number }>;
}

export interface SyncSummary {
  htmlFilesFetched: number;
  htmlTweetsInserted: number;
  htmlTweetsUpdated: number;
  classifierTweetsLinked: number;
  embeddingsImported: number;
  urlEnrichmentsImported: number;
  imageEnrichmentsImported: number;
  errors: string[];
}

function manifestUrl(base: string): string {
  return PROXY_MODE ? '/api/manifest' : `${base}/api/data/manifest`;
}

function dataFileUrl(name: string, base: string): string {
  if (PROXY_MODE) {
    // Auth-gated streaming proxy in front of the (private) R2 bucket. We
    // intentionally do NOT go direct-to-R2: that would expose the data to
    // anyone with the bucket URL.
    return `/api/data/${encodeURIComponent(name)}`;
  }
  return `${base}/api/data/file?name=${encodeURIComponent(name)}`;
}

function htmlFileUrl(name: string, base: string): string {
  // HTMLs are local-only - they only exist in `exports/` on the local machine.
  return `${base}/api/data/file?html=${encodeURIComponent(name)}`;
}

/** `include` only for the same-origin Pages proxy (CF Access cookie). The local
 *  wiki server does not allow credentialed CORS, so `include` would break it. */
export function fetchCredentials(): RequestCredentials {
  return PROXY_MODE ? 'include' : 'omit';
}

export async function fetchManifest(base = DEFAULT_LOCAL_BASE): Promise<DataManifest> {
  const url = manifestUrl(base);
  const resp = await fetch(url, { credentials: fetchCredentials() });
  if (!resp.ok) {
    const where = PROXY_MODE ? 'the deployed /api/manifest endpoint' : `wiki server at ${base}`;
    throw new Error(`Couldn't reach ${where} (HTTP ${resp.status}).`);
  }
  return resp.json();
}

interface SyncOpts {
  base?: string;
  onProgress?: (msg: string) => void;
  /** Persist the DB mid-sync (called after tweets are created, before the heavy
   *  embeddings import) so a memory-constrained device keeps the tweets even if
   *  a later step fails. */
  onCheckpoint?: () => Promise<void>;
  /** Skip fetching the FULL `enriched_tweets.json` (its ~40 MB monolithic
   *  JSON.parse OOMs constrained mobile devices). When true, the caller should
   *  also set `fetchEmbeddingsOnly` to control whether the streaming NDJSON
   *  artifact is fetched instead. The ETag token is left unset so enabling
   *  the full import later re-fetches it naturally. */
  skipEnriched?: boolean;
  /** When the full enriched file is skipped, fetch the streaming
   *  `embeddings.ndjson` artifact instead. This delivers embeddings (chat RAG)
   *  without the url/image enrichments that bloat the full file. */
  fetchEmbeddingsOnly?: boolean;
}

export async function syncFromDisk(handle: SqliteHandle, opts: SyncOpts = {}): Promise<SyncSummary> {
  const db = handle.db;
  const base = opts.base ?? DEFAULT_LOCAL_BASE;
  const progress = opts.onProgress ?? (() => {});

  const summary: SyncSummary = {
    htmlFilesFetched: 0,
    htmlTweetsInserted: 0,
    htmlTweetsUpdated: 0,
    classifierTweetsLinked: 0,
    embeddingsImported: 0,
    urlEnrichmentsImported: 0,
    imageEnrichmentsImported: 0,
    errors: [],
  };

  progress('Fetching manifest…');
  let manifest: DataManifest;
  try {
    manifest = await fetchManifest(base);
  } catch (e) {
    if ((e as Error).message.includes('Failed to fetch')) {
      throw new Error(
        PROXY_MODE
          ? 'Network error reaching /api/manifest. Check your connection or the Cloudflare Access session.'
          : `Couldn't reach wiki server at ${base}. Run ./trove start (or ./trove go) first.`,
      );
    }
    throw e;
  }
  console.info('[sync] manifest ok:', {
    root_files: Object.keys(manifest.root_files ?? {}),
    html_files: manifest.html_files?.length ?? 0,
    proxyMode: PROXY_MODE,
  });

  // 1. HTML files (the source of truth for tweet content). Skipped in proxy
  // mode - only the derived JSONs ship to the cloud.
  const htmlContents: Array<{ name: string; html: string }> = [];
  for (let i = 0; i < manifest.html_files.length; i++) {
    const f = manifest.html_files[i];
    progress(`Fetching ${f.name} (${i + 1}/${manifest.html_files.length})…`);
    try {
      const r = await fetch(htmlFileUrl(f.name, base));
      if (!r.ok) {
        summary.errors.push(`${f.name}: HTTP ${r.status}`);
        continue;
      }
      htmlContents.push({ name: f.name, html: await r.text() });
      summary.htmlFilesFetched += 1;
    } catch (e) {
      summary.errors.push(`${f.name}: ${(e as Error).message}`);
    }
  }

  if (htmlContents.length > 0) {
    progress(`Parsing ${htmlContents.length} HTML file(s)…`);
    const { tweets, errors: parseErrors } = parseHtmlExportFiles(htmlContents);
    for (const e of parseErrors) summary.errors.push(`${e.file}[${e.index}]: ${e.reason}`);

    progress(`Importing ${tweets.length} tweets…`);
    const imp = importHtmlTweets(db, tweets);
    summary.htmlTweetsInserted = imp.inserted;
    summary.htmlTweetsUpdated = imp.updated;
    summary.errors.push(...imp.errors);
  }

  // 2. JSON files (classifier output, then enrichments). Order matters:
  //    enrichments reference tweet_ids; classifier replaces assignments.
  const jsonOrder = ['categorized_tweets.json', ENRICHED_FILE];
  for (const name of jsonOrder) {
    const entry = manifest.root_files[name];
    if (!entry) continue;

    // Skip the full enriched payload on constrained devices. The streaming
    // NDJSON path below handles embeddings separately. Do NOT record the ETag
    // token, so flipping the setting later re-fetches it naturally.
    if (name === ENRICHED_FILE && opts.skipEnriched) {
      console.info('[sync] skipping enriched_tweets.json (constrained device / setting) - will try streaming NDJSON');
      progress('Skipping full chat data (~40 MB) - trying streaming embeddings instead');
      continue;
    }

    // Skip the download+parse entirely when the file is byte-identical to what
    // we last imported. The version token is the R2 ETag (cloud) or mtime:size
    // (local). Stored in sync_state, so it lives in the DB snapshot and resets
    // with the DB - avoids re-fetching + re-parsing the ~56 MB embeddings file
    // on every ⟳ when nothing changed (the dominant cost, esp. on mobile).
    const token = entry.etag ?? `${entry.mtime}:${entry.size}`;
    const tokenKey = `import_etag:${name}`;
    if (getSyncState(db, tokenKey) === token) {
      console.info(`[sync] ${name} unchanged (token ${token}) - skipped`);
      progress(`${name} unchanged - skipped`);
      continue;
    }

    progress(`Fetching ${name}…`);
    try {
      // cache: 'no-store' - the app's own token check above is the caching
      // layer (we only get here when the manifest says the file CHANGED), so
      // the browser HTTP cache can only hurt: a cached 0-byte 200 from the
      // July 2026 proxy bug kept re-serving itself via If-None-Match/304
      // revalidation even after the server was fixed.
      const r = await fetch(dataFileUrl(name, base), { credentials: fetchCredentials(), cache: 'no-store' });
      console.info(`[sync] ${name}: HTTP ${r.status} (${r.headers.get('content-length') ?? '?'} bytes)`);
      if (!r.ok) {
        summary.errors.push(`${name}: HTTP ${r.status}`);
        continue;
      }
      let raw: unknown;
      try {
        // Parse the response stream directly instead of `await r.text()` +
        // JSON.parse(): that avoids simultaneously holding the full decoded
        // string AND the parsed object graph, which roughly halves peak memory
        // for the multi-MB payloads. iOS Safari was OOM-ing here and failing
        // the import silently (the tweets never landed on the phone).
        raw = await r.json();
      } catch (e) {
        // A transport/encoding bug (wrong Content-Encoding, truncated body)
        // surfaces here as a JSON parse error. Include the response headers so
        // the failure is diagnosable from the toast/console alone.
        const diag = `type=${r.headers.get('content-type') ?? '?'} encoding=${r.headers.get('content-encoding') ?? 'none'} length=${r.headers.get('content-length') ?? '?'}`;
        summary.errors.push(`${name}: invalid JSON (${diag}): ${(e as Error).message}`);
        continue;
      }
      if (isEnrichedObject(raw)) {
        const parsed = parseEnrichedObject(raw);
        for (const e of parsed.errors)
          summary.errors.push(`${name}[${e.section}#${e.index}]: ${e.reason}`);
        progress(`Importing enrichments from ${name}…`);
        const imp = importEnrichedData(db, handle.embDb, parsed);
        summary.embeddingsImported += imp.embeddingsImported;
        summary.urlEnrichmentsImported += imp.urlEnrichmentsImported;
        summary.imageEnrichmentsImported += imp.imageEnrichmentsImported;
        // Embeddings live in their own db with its own snapshot - persist it now
        // (the main-db markDirty/flush won't).
        if (imp.embeddingsImported > 0) await handle.flushEmbeddings();
      } else {
        const parsed = parseClassifierObject(raw);
        for (const e of parsed.errors)
          summary.errors.push(`${name}[${e.index}]: ${e.reason}`);

        // In cloud mode there are no HTML files, so the categorized JSON is the
        // ONLY source of tweet content - create the rows from it. Create-only,
        // so it never clobbers tweets/engagement from an HTML import or a .db
        // restore. Then checkpoint, so the tweets survive even if the heavy
        // enriched/embeddings import below runs the device out of memory.
        if (htmlContents.length === 0) {
          progress(`Importing ${parsed.tweets.length} tweets from ${name}…`);
          const imp = importClassifierTweets(db, parsed.tweets);
          summary.htmlTweetsInserted += imp.inserted;
          summary.htmlTweetsUpdated += imp.updated;
          summary.errors.push(...imp.errors);
          if (imp.inserted > 0) await opts.onCheckpoint?.();
        }

        progress(`Linking ${parsed.tweets.length} classifier assignments…`);
        const link = replaceClassifierAssignments(
          db,
          parsed.tweets.map((t) => ({ tweetId: t.id, categories: t.categories })),
        );
        summary.classifierTweetsLinked += link.linked;
        if (link.skipped > 0) {
          summary.errors.push(`${name}: ${link.skipped} assignment(s) skipped - tweet not found`);
        }
      }
      // Import of this file succeeded - record the version token so the next
      // sync can skip it if unchanged.
      setSyncState(db, tokenKey, token);
    } catch (e) {
      console.error(`[sync] ${name} failed:`, e);
      summary.errors.push(`${name}: ${(e as Error).message}`);
    }
  }

  // 3. Streaming embeddings fallback. When the full enriched file was skipped
  //    (mobile/constrained device), try the streaming NDJSON artifact instead.
  //    This delivers embeddings (chat RAG) without the url/image enrichments
  //    that bloat the full file, and without the monolithic JSON.parse that
  //    OOMs iOS Safari. Peak JS heap stays flat: we parse one line at a time.
  if (opts.skipEnriched && opts.fetchEmbeddingsOnly) {
    const ndjsonName = 'embeddings.ndjson';
    const ndEntry = manifest.root_files[ndjsonName];
    if (ndEntry) {
      const ndToken = ndEntry.etag ?? `${ndEntry.mtime}:${ndEntry.size}`;
      const ndTokenKey = `import_etag:${ndjsonName}`;
      if (getSyncState(db, ndTokenKey) === ndToken) {
        console.info(`[sync] ${ndjsonName} unchanged (token ${ndToken}) - skipped`);
        progress(`${ndjsonName} unchanged - skipped`);
      } else {
        progress(`Fetching ${ndjsonName} (streaming)…`);
        try {
          const r = await fetch(dataFileUrl(ndjsonName, base), {
            credentials: fetchCredentials(),
            cache: 'no-store',
          });
          console.info(`[sync] ${ndjsonName}: HTTP ${r.status} (${r.headers.get('content-length') ?? '?'} bytes)`);
          if (!r.ok) {
            summary.errors.push(`${ndjsonName}: HTTP ${r.status}`);
          } else {
            const streamSummary = await streamImportEmbeddings(
              handle,
              r,
              opts.onProgress,
              opts.onCheckpoint,
            );
            summary.embeddingsImported += streamSummary.embeddingsImported;
            summary.errors.push(...streamSummary.errors);
            if (streamSummary.embeddingsImported > 0) {
              setSyncState(db, ndTokenKey, ndToken);
            }
          }
        } catch (e) {
          console.error(`[sync] ${ndjsonName} failed:`, e);
          summary.errors.push(`${ndjsonName}: ${(e as Error).message}`);
        }
      }
    } else {
      console.info('[sync] embeddings.ndjson not in manifest - skipping streaming import');
    }
  }
  return summary;
}
