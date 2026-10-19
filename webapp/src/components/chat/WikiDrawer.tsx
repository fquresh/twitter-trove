// Side drawer that renders a wiki page body. Hits /wiki/read on the local
// wiki server (Phase 13). On connection failure, shows a friendly banner +
// a link to the README's "How to start the wiki server" section.

import { useEffect, useState } from 'react';

interface Props {
  path: string;
  serverUrl: string;
  onClose: () => void;
}

interface WikiResp {
  path: string;
  frontmatter: Record<string, unknown>;
  body_markdown: string;
}

export function WikiDrawer({ path, serverUrl, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<WikiResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = `${serverUrl.replace(/\/$/, '')}/wiki/read?path=${encodeURIComponent(path)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const json = (await resp.json()) as WikiResp;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, serverUrl]);

  // Esc closes, like every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50"
      onClick={onClose}
      data-testid="wiki-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Wiki page"
    >
      <aside
        className="flex h-full w-full max-w-xl flex-col overflow-hidden bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="label">Wiki page</div>
            <div className="font-mono text-sm text-ink-100">{path}</div>
          </div>
          <div className="flex gap-2">
            <a
              href={`obsidian://open?path=${encodeURIComponent(path)}`}
              className="btn-outline text-xs"
              title="Open this page in Obsidian"
            >
              Open in Obsidian
            </a>
            <button type="button" className="btn-outline text-xs" onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-auto px-5 py-4 text-sm text-ink-100">
          {loading && <div className="text-ink-300">Loading…</div>}
          {error && (
            <div className="rounded-md border border-yellow-700/50 bg-yellow-900/20 p-3 text-yellow-200">
              <div className="font-semibold">Wiki server unreachable</div>
              <p className="mt-1 text-sm">
                The wiki page <code className="font-mono">{path}</code> couldn't load
                from <code className="font-mono">{serverUrl}</code>: {error}.
              </p>
              <p className="mt-2 text-sm">
                Run <code className="font-mono">python wiki_server.py --port 8765</code> in
                the project root, then retry.
              </p>
            </div>
          )}
          {data && (
            <div>
              {Object.keys(data.frontmatter).length > 0 && (
                <div className="mb-4 rounded-md border border-white/5 bg-white/5 p-3 text-xs">
                  <div className="label mb-1">Frontmatter</div>
                  <pre className="whitespace-pre-wrap text-ink-200">
                    {JSON.stringify(data.frontmatter, null, 2)}
                  </pre>
                </div>
              )}
              <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-100">
                {data.body_markdown}
              </pre>
            </div>
          )}
        </main>
      </aside>
    </div>
  );
}
