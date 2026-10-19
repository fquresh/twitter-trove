import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDbStatus } from '../lib/dbContext';
import { resetDb } from '../db/sqlite';
import {
  earliestTweetTime,
  latestTweetTime,
  totalTweetCount,
} from '../db/queries/tweets';
import { formatDate } from '../lib/format';
import { scalar } from '../db/exec';
import { maskKey, useChatStore } from '../state/chatStore';
import { useUiStore, type EnrichedImport } from '../state/uiStore';
import { PROXY_MODE, pingDeepseek } from '../chat/client';
import { pingVoyage } from '../chat/voyage';
import { makeWikiClient } from '../chat/wikiClient';
import { McpSection } from '../components/McpSection';

export function SettingsRoute() {
  const { handle, reload } = useDbStatus();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('');

  // Chat-store fields. Read each slice individually so React only re-renders
  // when the relevant value changes.
  const enrichedImport = useUiStore((s) => s.enrichedImport);
  const setEnrichedImport = useUiStore((s) => s.setEnrichedImport);

  const deepseekApiKey = useChatStore((s) => s.deepseekApiKey);
  const voyageApiKey = useChatStore((s) => s.voyageApiKey);
  const chatModel = useChatStore((s) => s.chatModel);
  const embedModel = useChatStore((s) => s.embedModel);
  const acknowledgedKeyRisk = useChatStore((s) => s.acknowledgedKeyRisk);
  const wikiServerUrl = useChatStore((s) => s.wikiServerUrl);
  const setDeepseekApiKey = useChatStore((s) => s.setDeepseekApiKey);
  const setVoyageApiKey = useChatStore((s) => s.setVoyageApiKey);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const setEmbedModel = useChatStore((s) => s.setEmbedModel);
  const setAcknowledgedKeyRisk = useChatStore((s) => s.setAcknowledgedKeyRisk);
  const setWikiServerUrl = useChatStore((s) => s.setWikiServerUrl);
  const clearKeys = useChatStore((s) => s.clearKeys);

  // Local edit buffers for the API keys so the user can type without each
  // keystroke triggering persist/re-render storms.
  const [deepseekDraft, setDeepseekDraft] = useState('');
  const [voyageDraft, setVoyageDraft] = useState('');
  const [wikiDraft, setWikiDraft] = useState(wikiServerUrl);
  const [modelDraft, setModelDraft] = useState(chatModel);
  const [pingResult, setPingResult] = useState<{
    deepseek?: { ok: boolean; message: string };
    voyage?: { ok: boolean; message: string };
    wiki?: { ok: boolean; message: string };
  }>({});

  useEffect(() => {
    setModelDraft(chatModel);
  }, [chatModel]);

  // "Load keys from .env" state - fetches from wiki_server's /api/keys/load.
  const [loadingEnvKeys, setLoadingEnvKeys] = useState(false);
  const [envKeyMsg, setEnvKeyMsg] = useState<string | null>(null);
  // Save buttons used to be silent; this flashes a confirmation and the
  // `testing` map keeps the Test buttons out of reach while a ping is running.
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  const markSaved = (section: string) => {
    setSavedFlash(section);
    window.setTimeout(() => setSavedFlash((cur) => (cur === section ? null : cur)), 1800);
  };

  const loadKeysFromEnv = async () => {
    setLoadingEnvKeys(true);
    setEnvKeyMsg(null);
    try {
      const base = wikiServerUrl.replace(/\/$/, '');
      const r = await fetch(`${base}/api/keys/load`);
      if (!r.ok) throw new Error(`HTTP ${r.status} from wiki server`);
      const keys: { deepseek?: string; voyage?: string; openrouter?: string } = await r.json();
      const loaded: string[] = [];
      const missing: string[] = [];
      if (keys.deepseek) {
        setDeepseekApiKey(keys.deepseek);
        setDeepseekDraft('');
        loaded.push('DeepSeek');
      } else {
        missing.push('DeepSeek');
      }
      if (keys.voyage) {
        setVoyageApiKey(keys.voyage);
        setVoyageDraft('');
        loaded.push('Voyage');
      } else {
        missing.push('Voyage');
      }
      setPingResult({});  // clear stale ping results
      const parts: string[] = [];
      if (loaded.length) parts.push(`✓ loaded ${loaded.join(' + ')}`);
      if (missing.length) parts.push(`(${missing.join(', ')} not in .env)`);
      setEnvKeyMsg(parts.join(' ') || 'no keys found in .env');
    } catch (e) {
      setEnvKeyMsg(
        `✗ ${(e as Error).message}. Make sure ./trove start (or ./trove go) is running.`,
      );
    } finally {
      setLoadingEnvKeys(false);
    }
  };

  useEffect(() => {
    setWikiDraft(wikiServerUrl);
  }, [wikiServerUrl]);

  if (!handle) return null;

  const total = totalTweetCount(handle.db);
  const earliest = earliestTweetTime(handle.db);
  const latest = latestTweetTime(handle.db);
  const catCount = scalar<number>(handle.db, 'SELECT COUNT(*) FROM categories') ?? 0;
  const entCount = scalar<number>(handle.db, 'SELECT COUNT(*) FROM entities') ?? 0;
  // Embeddings live in their own db (schema v4 split).
  const embeddingCount =
    scalar<number>(handle.embDb, 'SELECT COUNT(*) FROM tweet_embeddings') ?? 0;
  const urlCount =
    scalar<number>(
      handle.db,
      "SELECT COUNT(*) FROM enrichments WHERE type='url_content'",
    ) ?? 0;
  const imgCount =
    scalar<number>(
      handle.db,
      "SELECT COUNT(*) FROM enrichments WHERE type='image_description'",
    ) ?? 0;

  const download = () => {
    const bytes = handle.export();
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const blob = new Blob([buffer], { type: 'application/vnd.sqlite3' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trove-${new Date().toISOString().slice(0, 10)}.db`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Snapshot downloaded (${(bytes.length / 1024 / 1024).toFixed(2)} MB).`);
  };

  const onImportSnapshot = async (file: File) => {
    setStatus('Replacing DB with snapshot…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await handle.replace(bytes);
      queryClient.invalidateQueries();
      reload();
      setStatus('Snapshot loaded.');
    } catch (e) {
      setStatus(`Snapshot import failed: ${(e as Error).message}`);
    }
  };

  const onReset = async () => {
    if (
      !confirm(
        'This will delete every tweet, category, tag, and entity from your browser. Continue?',
      )
    )
      return;
    await resetDb();
    queryClient.invalidateQueries();
    reload();
    setStatus('Database reset.');
  };

  const saveDeepseek = () => {
    if (!deepseekDraft) return;
    setDeepseekApiKey(deepseekDraft);
    setDeepseekDraft('');
    setPingResult((r) => ({ ...r, deepseek: undefined }));
    markSaved('deepseek');
  };
  const saveVoyage = () => {
    if (!voyageDraft) return;
    setVoyageApiKey(voyageDraft);
    setVoyageDraft('');
    setPingResult((r) => ({ ...r, voyage: undefined }));
    markSaved('voyage');
  };

  const saveModel = () => {
    if (!modelDraft) return;
    setChatModel(modelDraft);
    setPingResult((r) => ({ ...r, deepseek: undefined }));
    markSaved('model');
  };

  const testDeepseek = async () => {
    if (!deepseekApiKey || testing.deepseek) return;
    setTesting((t) => ({ ...t, deepseek: true }));
    setPingResult((r) => ({ ...r, deepseek: { ok: false, message: 'Testing…' } }));
    try {
      const r = await pingDeepseek(deepseekApiKey, chatModel);
      setPingResult((s) => ({ ...s, deepseek: r }));
    } finally {
      setTesting((t) => ({ ...t, deepseek: false }));
    }
  };
  const testVoyage = async () => {
    if (!voyageApiKey || testing.voyage) return;
    setTesting((t) => ({ ...t, voyage: true }));
    setPingResult((r) => ({ ...r, voyage: { ok: false, message: 'Testing…' } }));
    try {
      const r = await pingVoyage(voyageApiKey, embedModel);
      setPingResult((s) => ({ ...s, voyage: r }));
    } finally {
      setTesting((t) => ({ ...t, voyage: false }));
    }
  };

  const saveWiki = () => {
    setWikiServerUrl(wikiDraft);
    setPingResult((r) => ({ ...r, wiki: undefined }));
    markSaved('wiki');
  };
  const testWiki = async () => {
    if (testing.wiki) return;
    setTesting((t) => ({ ...t, wiki: true }));
    setPingResult((r) => ({ ...r, wiki: { ok: false, message: 'Probing…' } }));
    try {
      const client = makeWikiClient(wikiDraft);
      const r = await client.health();
      if ('error' in r) {
        setPingResult((s) => ({ ...s, wiki: { ok: false, message: r.error } }));
      } else {
        setPingResult((s) => ({
          ...s,
          wiki: { ok: true, message: `OK - ${r.page_count} pages (${r.status})` },
        }));
      }
    } finally {
      setTesting((t) => ({ ...t, wiki: false }));
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="h-display">Settings</h1>
        <p className="text-sm text-ink-500 dark:text-ink-300">All data is stored in your browser.</p>
      </header>

      <section className="card grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
        <Stat label="Tweets" value={total.toLocaleString()} />
        <Stat label="Categories" value={catCount.toLocaleString()} />
        <Stat label="Entities" value={entCount.toLocaleString()} />
        <Stat
          label="Date range"
          value={
            earliest && latest
              ? `${formatDate(earliest)} → ${formatDate(latest)}`
              : '-'
          }
        />
      </section>

      <section className="card grid grid-cols-2 gap-4 p-5 md:grid-cols-3">
        <Stat label="Embeddings" value={embeddingCount.toLocaleString()} />
        <Stat label="URL content" value={urlCount.toLocaleString()} />
        <Stat label="Image descriptions" value={imgCount.toLocaleString()} />
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-lg font-semibold">AI / Chat</h2>

        {PROXY_MODE ? (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-900 dark:text-emerald-100">
            <strong>Keys are managed server-side.</strong> This deployment proxies chat
            and embeddings through Cloudflare Functions; the DeepSeek and Voyage keys live
            in Cloudflare env vars and never touch this browser. Just pick a model below.
          </div>
        ) : (
          <>
            <div className="rounded-md border border-accent-500/40 bg-accent-500/10 p-3 text-xs text-ink-800 dark:text-ink-200">
              <p className="mb-2">
                <strong>How chat is wired:</strong> the agent goes through{' '}
                <span className="font-mono">DeepSeek</span> (one key, native API at
                api.deepseek.com - models deepseek-v4-flash / deepseek-v4-pro).{' '}
                <span className="font-mono">Voyage</span> handles query embeddings
                for retrieval. Both keys are already in your{' '}
                <span className="font-mono">.env</span> - click below to load them.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => void loadKeysFromEnv()}
                  disabled={loadingEnvKeys}
                >
                  {loadingEnvKeys ? 'Loading…' : 'Load keys from .env'}
                </button>
                {envKeyMsg && (
                  <span
                    className={`text-xs ${
                      envKeyMsg.startsWith('✓')
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : envKeyMsg.startsWith('✗')
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-ink-500 dark:text-ink-300'
                    }`}
                  >
                    {envKeyMsg}
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-yellow-700/50 dark:bg-yellow-900/20 dark:text-yellow-200">
              <strong>Security note:</strong> API keys are stored in your browser's
              localStorage. Any compromised script on this origin (extension, third-party
              dependency) could read them. Don't paste keys you can't quickly rotate.
              {!acknowledgedKeyRisk && (
                <button
                  type="button"
                  className="ml-3 inline-flex min-h-8 items-center rounded border border-yellow-500/60 px-2 py-0.5 text-yellow-100"
                  onClick={() => setAcknowledgedKeyRisk(true)}
                >
                  I understand
                </button>
              )}
            </div>
          </>
        )}

        {!PROXY_MODE && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="label">DeepSeek API key</label>
            <div className="text-xs text-ink-400">
              Currently: <span className="font-mono">{maskKey(deepseekApiKey)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="password"
                className="input min-w-0 flex-1"
                placeholder="sk-…"
                value={deepseekDraft}
                onChange={(e) => setDeepseekDraft(e.target.value)}
              />
              <button type="button" className="btn-outline" onClick={saveDeepseek} disabled={!deepseekDraft}>
                Save
              </button>
              {savedFlash === 'deepseek' && (
                <span className="self-center text-xs text-emerald-600 dark:text-emerald-400">Saved ✓</span>
              )}
              <button
                type="button"
                className="btn-outline"
                onClick={() => void testDeepseek()}
                disabled={!deepseekApiKey || testing.deepseek}
                title={`Test the current model (${chatModel}) with an 8-token ping`}
              >
                Test
              </button>
            </div>
            {pingResult.deepseek && (
              <div
                className={`text-xs ${
                  pingResult.deepseek.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                }`}
              >
                {pingResult.deepseek.message}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="label">Voyage API key</label>
            <div className="text-xs text-ink-400">
              Currently: <span className="font-mono">{maskKey(voyageApiKey)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="password"
                className="input min-w-0 flex-1"
                placeholder="pa-…"
                value={voyageDraft}
                onChange={(e) => setVoyageDraft(e.target.value)}
              />
              <button type="button" className="btn-outline" onClick={saveVoyage} disabled={!voyageDraft}>
                Save
              </button>
              {savedFlash === 'voyage' && (
                <span className="self-center text-xs text-emerald-600 dark:text-emerald-400">Saved ✓</span>
              )}
              <button
                type="button"
                className="btn-outline"
                onClick={() => void testVoyage()}
                disabled={!voyageApiKey || testing.voyage}
              >
                Test
              </button>
            </div>
            {pingResult.voyage && (
              <div
                className={`text-xs ${
                  pingResult.voyage.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                }`}
              >
                {pingResult.voyage.message}
              </div>
            )}
          </div>
        </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="label">Chat model</label>
            <div className="text-xs text-ink-400">
              Currently: <span className="font-mono">{chatModel}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                className="input min-w-0 flex-1 font-mono text-xs"
                placeholder="deepseek-v4-flash"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                list="deepseek-model-presets"
              />
              <button type="button" className="btn-outline" onClick={saveModel} disabled={!modelDraft}>
                Save
              </button>
              {savedFlash === 'model' && (
                <span className="self-center text-xs text-emerald-600 dark:text-emerald-400">Saved ✓</span>
              )}
            </div>
            <datalist id="deepseek-model-presets">
              <option value="deepseek-v4-flash" />
              <option value="deepseek-v4-pro" />
            </datalist>
            <p className="text-xs text-ink-400">
              A DeepSeek native model id (no provider prefix). See the docs at{' '}
              <a
                href="https://api-docs.deepseek.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-400 hover:underline"
              >
                api-docs.deepseek.com
              </a>
              .
            </p>
          </div>
          <div className="space-y-2">
            <label className="label">Embedding model</label>
            <input
              className="input w-full"
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
            />
            <div className="text-xs text-ink-400">
              Should match the model used at index time (default voyage-3-large).
            </div>
          </div>
        </div>

        {!PROXY_MODE && (
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              className="btn-outline text-red-600 dark:text-red-400"
              onClick={() => {
                if (confirm('Clear the saved DeepSeek and Voyage keys from this browser?')) {
                  clearKeys();
                  setStatus('API keys cleared.');
                }
              }}
            >
              Clear API keys
            </button>
          </div>
        )}
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-lg font-semibold">Wiki server (optional)</h2>
        <p className="text-sm text-ink-500 dark:text-ink-300">
          The local Flask wiki server (run <code>python wiki_server.py</code>) lets the chat
          agent look up named-entity briefs. Leave it off if you haven't bootstrapped the
          wiki yet - the agent gracefully degrades to SQL-only mode.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1"
            placeholder="http://localhost:8765"
            value={wikiDraft}
            onChange={(e) => setWikiDraft(e.target.value)}
          />
          <button type="button" className="btn-outline" onClick={saveWiki}>
            Save
          </button>
          {savedFlash === 'wiki' && (
            <span className="self-center text-xs text-emerald-600 dark:text-emerald-400">Saved ✓</span>
          )}
          <button
            type="button"
            className="btn-outline"
            onClick={() => void testWiki()}
            disabled={testing.wiki}
          >
            Test
          </button>
        </div>
        {pingResult.wiki && (
          <div
            className={`text-xs ${
              pingResult.wiki.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {pingResult.wiki.message}
          </div>
        )}
      </section>

      <McpSection />

      <section className="card space-y-3 p-5">
        <h2 className="text-lg font-semibold">Sync</h2>
        <div className="space-y-2">
          <label className="label">Import chat search data on this device</label>
          <p className="text-sm text-ink-500 dark:text-ink-300">
            The embeddings power chat's semantic search. <strong>Auto</strong>
            imports them everywhere - on phones/tablets via a memory-safe
            streaming format (embeddings only, no URL/image context); on
            desktop via the full enriched file. <strong>Never</strong> disables
            chat RAG on this device entirely.
          </p>
          <div className="inline-flex rounded-full bg-ink-100 p-1 dark:bg-ink-800">
            {(
              [
                { value: 'auto', label: 'Auto' },
                { value: 'always', label: 'Always' },
                { value: 'never', label: 'Never' },
              ] as Array<{ value: EnrichedImport; label: string }>
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setEnrichedImport(opt.value)}
                className={`min-h-11 rounded-full px-4 py-1.5 text-sm font-medium transition-colors md:min-h-0 ${
                  enrichedImport === opt.value
                    ? 'bg-white text-ink-900 shadow-soft dark:bg-ink-600 dark:text-white'
                    : 'text-ink-500 hover:text-ink-800 dark:text-ink-300 dark:hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-400">
            After changing this, hit the ⟳ button in the top nav to re-sync. Enabling it
            later re-fetches the embeddings automatically.
          </p>
        </div>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-lg font-semibold">Snapshot</h2>
        <p className="text-sm text-ink-500 dark:text-ink-300">
          Export the raw SQLite file for backup. Import replaces the current DB -
          a merge workflow is not provided (do it on a snapshot to be safe).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-outline" onClick={download}>
            Download .db
          </button>
          <label className="btn-outline cursor-pointer">
            Import .db
            <input
              type="file"
              accept=".db,application/vnd.sqlite3,application/octet-stream"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onImportSnapshot(file);
                e.target.value = '';
              }}
            />
          </label>
          <button type="button" className="btn-outline text-red-600 dark:text-red-400" onClick={() => void onReset()}>
            Reset all data
          </button>
        </div>
        {status && <div className="text-xs text-ink-500 dark:text-ink-300">{status}</div>}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink-50">{value}</div>
    </div>
  );
}
