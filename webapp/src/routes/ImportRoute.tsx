import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDb } from '../lib/dbContext';
import { parseHtmlExportFiles } from '../parser/htmlExport';
import { parseClassifierJson } from '../parser/classifierJson';
import { isEnrichedJson, parseEnrichedJson } from '../parser/enrichedExport';
import { importHtmlTweets, importClassifierTweets } from '../db/queries/tweets';
import { replaceClassifierAssignments } from '../db/queries/categories';
import { importEnrichedData } from '../db/queries/enrichments';
import { resyncAfterImport } from '../sync/syncClient';
import { markRetrievalStale } from '../chat/retrieval';

interface ImportResult {
  filesProcessed: number;
  htmlTweetsInserted: number;
  htmlTweetsUpdated: number;
  classifierTweetsLinked: number;
  classifierCategoriesUpserted: number;
  embeddingsImported: number;
  urlEnrichmentsImported: number;
  imageEnrichmentsImported: number;
  errors: string[];
}

async function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsText(file);
  });
}

export function ImportRoute() {
  const handle = useDb();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('Drop files or click to select.');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setResult(null);
    const agg: ImportResult = {
      filesProcessed: 0,
      htmlTweetsInserted: 0,
      htmlTweetsUpdated: 0,
      classifierTweetsLinked: 0,
      classifierCategoriesUpserted: 0,
      embeddingsImported: 0,
      urlEnrichmentsImported: 0,
      imageEnrichmentsImported: 0,
      errors: [],
    };

    try {
      const htmlFiles = files.filter((f) => f.name.toLowerCase().endsWith('.html'));
      const jsonFiles = files.filter((f) => f.name.toLowerCase().endsWith('.json'));

      if (htmlFiles.length > 0) {
        setStatus(`Reading ${htmlFiles.length} HTML file(s)…`);
        const contents: Array<{ name: string; html: string }> = [];
        for (let i = 0; i < htmlFiles.length; i++) {
          setStatus(`Reading file ${i + 1} / ${htmlFiles.length}: ${htmlFiles[i].name}`);
          try {
            contents.push({ name: htmlFiles[i].name, html: await readFile(htmlFiles[i]) });
          } catch (e) {
            agg.errors.push((e as Error).message);
          }
        }

        setStatus('Parsing tweets…');
        const { tweets, errors } = parseHtmlExportFiles(contents);
        for (const e of errors) agg.errors.push(`${e.file}[${e.index}]: ${e.reason}`);

        setStatus(`Importing ${tweets.length} tweets…`);
        const summary = importHtmlTweets(handle.db, tweets);
        agg.htmlTweetsInserted = summary.inserted;
        agg.htmlTweetsUpdated = summary.updated;
        agg.errors.push(...summary.errors);
        agg.filesProcessed += contents.length;
      }

      if (jsonFiles.length > 0) {
        for (const jf of jsonFiles) {
          setStatus(`Reading ${jf.name}…`);
          const text = await readFile(jf);
          // Two valid JSON shapes share the .json extension: the enrichment
          // pipeline's output (has metadata.embed_model) and the classifier's
          // categorized_tweets.json. Probe before parsing so each file routes
          // to the right importer.
          if (isEnrichedJson(text)) {
            const parsed = parseEnrichedJson(text);
            for (const e of parsed.errors)
              agg.errors.push(`${jf.name}[${e.section}#${e.index}]: ${e.reason}`);
            const totalRows =
              parsed.embeddings.length +
              parsed.urlEnrichments.length +
              parsed.imageEnrichments.length;
            if (totalRows > 0) {
              setStatus(`Importing ${totalRows} enrichment row(s) from ${jf.name}…`);
              const summary = importEnrichedData(handle.db, handle.embDb, parsed);
              agg.embeddingsImported += summary.embeddingsImported;
              agg.urlEnrichmentsImported += summary.urlEnrichmentsImported;
              agg.imageEnrichmentsImported += summary.imageEnrichmentsImported;
              if (summary.embeddingsImported > 0) await handle.flushEmbeddings();
              const skipped =
                summary.embeddingsSkipped +
                summary.urlEnrichmentsSkipped +
                summary.imageEnrichmentsSkipped;
              if (skipped > 0) {
                agg.errors.push(
                  `${jf.name}: ${skipped} row(s) skipped - tweet not yet imported. ` +
                    `Drop the HTML export first, then re-import this enriched file.`,
                );
              }
              agg.filesProcessed += 1;
            }
          } else {
            const parsed = parseClassifierJson(text);
            for (const e of parsed.errors)
              agg.errors.push(`${jf.name}[${e.index}]: ${e.reason}`);
            if (parsed.tweets.length > 0) {
              // Create tweet rows from the classifier JSON's content FIRST. It
              // carries author/text/timestamp/engagement, so a JSON-only drop
              // (no HTML) still produces tweets - otherwise the category links
              // below would have nothing to attach to. Idempotent: existing
              // rows (from an HTML drop) only get engagement refreshed.
              setStatus(`Importing ${parsed.tweets.length} tweets from ${jf.name}…`);
              const created = importClassifierTweets(handle.db, parsed.tweets);
              agg.htmlTweetsInserted += created.inserted;
              agg.htmlTweetsUpdated += created.updated;
              agg.errors.push(...created.errors);

              setStatus(`Linking ${parsed.tweets.length} classifier assignments…`);
              const link = replaceClassifierAssignments(
                handle.db,
                parsed.tweets.map((t) => ({ tweetId: t.id, categories: t.categories })),
              );
              agg.classifierTweetsLinked += link.linked;
              if (link.skipped > 0) {
                agg.errors.push(`${jf.name}: ${link.skipped} assignment(s) skipped - tweet not found`);
              }
              agg.classifierCategoriesUpserted += parsed.categories.length;
              agg.filesProcessed += 1;
            }
          }
        }
      }

      handle.markDirty();
      await handle.flush();
      queryClient.invalidateQueries();

      if (agg.filesProcessed === 0) {
        setStatus('No .html or .json files found in the drop.');
      } else {
        // The chat retrieval worker holds its own DB copy - mark it stale so the
        // next search re-syncs against the freshly imported tweets.
        markRetrievalStale();
        // Re-pull cross-device user state (favorites/notes/categories) onto the
        // freshly imported tweets. No-op outside cloud/proxy mode.
        const sync = await resyncAfterImport(handle);
        if (!sync.ok) {
          agg.errors.push(`Cross-device resync failed: ${sync.error ?? 'unknown error'}`);
        }
        setStatus(agg.errors.length > 0 ? 'Import completed with errors.' : 'Import complete.');
      }
    } catch (e) {
      agg.errors.push((e as Error).message);
      setStatus('Import failed.');
    } finally {
      setBusy(false);
      setResult(agg);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    void handleFiles(files);
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    void handleFiles(files);
    e.target.value = '';
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="h-display">Import</h1>
        <p className="text-sm text-ink-500 dark:text-ink-300">
          Drop one or more HTML exports from the Chrome extension. Optionally
          include <code className="font-mono text-accent-400">categorized_tweets.json</code> to
          load classifier categories. The app dedupes by tweet ID and preserves
          your favorites, notes, and manual tags/categories on re-import.
        </p>
        <p className="rounded-md border border-accent-500/30 bg-accent-500/5 px-3 py-2 text-xs text-ink-700 dark:text-ink-200">
          <span className="font-semibold text-accent-400">Tip:</span> click the{' '}
          <span className="font-mono text-accent-400">⟳</span> button in the top
          nav to pull the latest HTML + classifier + enrichment files from disk
          in one shot - no drag-drop needed. (Requires{' '}
          <code className="font-mono">./trove start</code> or{' '}
          <code className="font-mono">./trove go</code> to be running.)
        </p>
      </header>

      <div
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className={`card flex flex-col items-center justify-center gap-3 border-dashed px-6 py-10 text-center md:px-10 md:py-14 ${busy ? 'pointer-events-none opacity-60' : ''}`}
        aria-busy={busy}
      >
        <div className="text-4xl">📥</div>
        <div className="text-sm text-ink-700 dark:text-ink-200">
          Drag &amp; drop files here, or
          <label className="ml-1 cursor-pointer text-accent-600 underline dark:text-accent-400">
            click to select
            <input
              type="file"
              multiple
              accept=".html,.json,application/json,text/html"
              className="hidden"
              disabled={busy}
              onChange={onFileInput}
            />
          </label>
        </div>
        <div className="text-xs text-ink-400">{status}</div>
        {busy && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-canvas-200 dark:bg-white/5">
            <div className="h-full w-1/3 animate-pulse bg-accent-500" />
          </div>
        )}
      </div>

      {result && (
        <div className="card space-y-2 p-5">
          <h2 className="text-lg font-semibold">Import summary</h2>
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-ink-500 dark:text-ink-300">Files processed</dt>
            <dd>{result.filesProcessed}</dd>
            <dt className="text-ink-500 dark:text-ink-300">Tweets inserted</dt>
            <dd>{result.htmlTweetsInserted}</dd>
            <dt className="text-ink-500 dark:text-ink-300">Tweets updated</dt>
            <dd>{result.htmlTweetsUpdated}</dd>
            <dt className="text-ink-500 dark:text-ink-300">Classifier assignments</dt>
            <dd>{result.classifierTweetsLinked}</dd>
            <dt className="text-ink-500 dark:text-ink-300">Categories upserted</dt>
            <dd>{result.classifierCategoriesUpserted}</dd>
            <dt className="text-ink-500 dark:text-ink-300">Embeddings imported</dt>
            <dd>{result.embeddingsImported}</dd>
            <dt className="text-ink-500 dark:text-ink-300">URL extractions imported</dt>
            <dd>{result.urlEnrichmentsImported}</dd>
            <dt className="text-ink-500 dark:text-ink-300">Image descriptions imported</dt>
            <dd>{result.imageEnrichmentsImported}</dd>
          </dl>
          {result.errors.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-ink-500 dark:text-ink-300">
                {result.errors.length} error{result.errors.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 max-h-60 overflow-auto rounded-md bg-canvas-100 p-3 font-mono text-xs text-ink-700 dark:bg-black/30 dark:text-ink-200">
                {result.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
