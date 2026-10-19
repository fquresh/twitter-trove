// Settings → "MCP server": where the remote MCP endpoint lives, how to point
// a client at it, and a Test button that calls it from this browser (which
// already carries the Cloudflare Access cookie in cloud mode).

import { useState } from 'react';
import { PROXY_MODE } from '../chat/client';

// The cloud app serves the endpoint on its own origin. A local build has no
// cloud origin of its own, so it reads VITE_CLOUD_ORIGIN (for example
// https://<your-project>.pages.dev) and shows a placeholder when that is unset.
const CLOUD_ORIGIN = (import.meta.env.VITE_CLOUD_ORIGIN ?? '').trim().replace(/\/+$/, '');
const PLACEHOLDER_ORIGIN = 'https://<your-project>.pages.dev';

function endpointUrl(): string {
  if (PROXY_MODE && typeof window !== 'undefined') return `${window.location.origin}/api/mcp`;
  return `${CLOUD_ORIGIN || PLACEHOLDER_ORIGIN}/api/mcp`;
}

function Snippet({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="label">{title}</span>
        <button type="button" className="text-xs underline underline-offset-2" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-canvas-100 p-3 font-mono text-[11px] leading-relaxed text-ink-800 dark:bg-black/40 dark:text-ink-100">
        {code}
      </pre>
    </div>
  );
}

export function McpSection() {
  const url = endpointUrl();
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const rpc = async (method: string, params: Record<string, unknown> = {}) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
      };
      const tools = await rpc('tools/list');
      if (tools.error) throw new Error(tools.error.message);
      const n = ((tools.result?.tools as unknown[]) ?? []).length;
      const stats = await rpc('tools/call', { name: 'archive_stats', arguments: {} });
      const sc = (stats.result?.structuredContent ?? {}) as { tweets?: number; newest?: string; index_pushed_at?: string | null };
      if (!sc.tweets) {
        setTest({ ok: false, message: `Endpoint answered with ${n} tools, but the D1 index is empty. Run ./trove mcp-push.` });
      } else {
        const pushed = sc.index_pushed_at ? new Date(sc.index_pushed_at).toLocaleString() : 'unknown';
        setTest({ ok: true, message: `OK - ${n} tools, ${sc.tweets.toLocaleString()} tweets, newest ${sc.newest}, index pushed ${pushed}.` });
      }
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const claudeCode = `claude mcp add --transport http trove ${url} \\
  --header "CF-Access-Client-Id: <client id>" \\
  --header "CF-Access-Client-Secret: <client secret>"`;

  const claudeDesktop = `{
  "mcpServers": {
    "trove": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${url}",
        "--header", "CF-Access-Client-Id:\${CF_ACCESS_CLIENT_ID}",
        "--header", "CF-Access-Client-Secret:\${CF_ACCESS_CLIENT_SECRET}"],
      "env": {
        "CF_ACCESS_CLIENT_ID": "<client id>",
        "CF_ACCESS_CLIENT_SECRET": "<client secret>"
      }
    }
  }
}`;

  const hermes = `# ~/.hermes/config.yaml
mcp_servers:
  trove:
    url: "${url}"
    headers:
      CF-Access-Client-Id: "<client id>"
      CF-Access-Client-Secret: "<client secret>"`;

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold">MCP server</h2>
        <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">
          Any MCP client (Claude Code, Claude Desktop, Cursor, Hermes Agent) can query this
          archive through a read-only remote server. It answers from a D1 index that{' '}
          <code className="font-mono text-xs">./trove deploy</code> refreshes on every run, so
          it always matches the tweets in the cloud app.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-canvas-100 px-3 py-2 font-mono text-xs dark:bg-black/40">
          {url}
        </code>
        <button type="button" className="btn-outline" disabled={testing} onClick={() => void runTest()}>
          {testing ? 'Testing…' : 'Test'}
        </button>
      </div>
      {test && (
        <div className={`text-xs ${test.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {test.message}
        </div>
      )}
      {!PROXY_MODE && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-yellow-700/50 dark:bg-yellow-900/20 dark:text-yellow-200">
          The Test button only works from the cloud app (it needs the Cloudflare Access cookie).
          Configure clients with the snippets below.
          {!CLOUD_ORIGIN && (
            <>
              {' '}Set <code className="font-mono">VITE_CLOUD_ORIGIN</code> in{' '}
              <code className="font-mono">webapp/.env.local</code> to fill in your deployed URL.
            </>
          )}
        </div>
      )}

      <div className="rounded-md border border-accent-500/40 bg-accent-500/10 p-3 text-xs text-ink-800 dark:text-ink-200">
        <p className="mb-1">
          <strong>Authentication.</strong> The endpoint sits behind Cloudflare Access. Clients
          authenticate with a service token sent as two headers. Mint one in Zero Trust → Access →
          Service Auth → Service Tokens, and make sure your Pages project's Access app has a
          Service Auth policy. The values in your local <code className="font-mono">.env</code>{' '}
          (<code className="font-mono">CF_ACCESS_CLIENT_ID</code> /{' '}
          <code className="font-mono">CF_ACCESS_CLIENT_SECRET</code>) are the same token the deploy
          verifier uses.
        </p>
        <p>Tools: search_tweets, count_tweets, top_authors, tweets_in_period, get_tweet, list_categories, archive_stats, list_wiki_pages, read_wiki_page, search_wiki.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-1">
        <Snippet title="Claude Code" code={claudeCode} />
        <Snippet title="Claude Desktop / Cursor (via mcp-remote)" code={claudeDesktop} />
        <Snippet title="Hermes Agent" code={hermes} />
      </div>
      <p className="text-xs text-ink-500 dark:text-ink-400">
        Setup, authentication, the update flow, and what each tool does: see the project
        README.
      </p>
    </section>
  );
}
