// Collapsed "what the agent did" strip shown above an assistant answer.
//
// One line per tool call with a human-readable summary of its input and
// result ("search_tweets “agent memory” → 20 hits"). Expanding a step shows
// the raw JSON for debugging. Collapsed by default once the turn is done;
// while a turn is in flight the list stays open so progress is visible.

import { useState } from 'react';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
}

const NAME_LABEL: Record<string, string> = {
  search_tweets: 'Searched tweets',
  count_tweets: 'Counted tweets',
  top_authors: 'Ranked authors',
  tweets_in_period: 'Pulled a date range',
  get_tweet_by_id: 'Fetched a tweet',
  list_wiki_pages: 'Listed wiki pages',
  read_wiki_page: 'Read wiki page',
  search_wiki: 'Searched the wiki',
};

export function toolLabel(name: string): string {
  return NAME_LABEL[name] ?? name;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Short description of the call's arguments. Exported for tests. */
export function summarizeInput(name: string, input: Record<string, unknown>): string {
  const parts: string[] = [];
  const q = str(input.query);
  if (q) parts.push(`“${q.length > 60 ? q.slice(0, 60) + '…' : q}”`);
  if (name === 'tweets_in_period') {
    const a = str(input.start) ?? '…';
    const b = str(input.end) ?? '…';
    parts.push(`${a} → ${b}`);
  }
  const id = str(input.id) ?? str(input.tweet_id);
  if (id) parts.push(id);
  const path = str(input.path);
  if (path) parts.push(path);
  for (const key of ['categories', 'authors', 'tickers', 'hashtags', 'mentions'] as const) {
    const v = input[key];
    if (Array.isArray(v) && v.length > 0) {
      const prefix = key === 'authors' ? '@' : key === 'tickers' ? '$' : key === 'hashtags' ? '#' : '';
      parts.push(v.slice(0, 3).map((x) => `${prefix}${String(x)}`).join(', ') + (v.length > 3 ? '…' : ''));
    }
  }
  const from = str(input.from_date);
  const to = str(input.to_date);
  if (from || to) parts.push(`${from ?? '…'} → ${to ?? '…'}`);
  if (input.by_category === true) parts.push('by category');
  return parts.join(' · ');
}

/** Short description of the call's result. Exported for tests. */
export function summarizeOutput(name: string, output: unknown): string {
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if ('error' in o) return `error: ${String(o.error)}`;
    if (o.found === false) return 'not found';
    if (Array.isArray(o.hits)) return `${o.hits.length} hits`;
    if (typeof o.count === 'number') return `${o.count.toLocaleString()} tweets`;
    if (Array.isArray(o.pages)) return `${o.pages.length} pages`;
    if (Array.isArray(o.results)) return `${o.results.length} results`;
    if (Array.isArray(o.tweets)) return `${o.tweets.length} tweets`;
    if (Array.isArray(o.authors)) return `${o.authors.length} authors`;
    if (name === 'get_tweet_by_id' && typeof o.id === 'string') return `@${String(o.handle ?? o.author_handle ?? '?').replace(/^@/, '')}`;
    if (name === 'read_wiki_page') return 'ok';
  }
  if (Array.isArray(output)) {
    if (name === 'top_authors') return `${output.length} authors`;
    if (name === 'tweets_in_period') return `${output.length} tweets`;
    return `${output.length} rows`;
  }
  return '';
}

function Step({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const inp = summarizeInput(call.name, call.input);
  const out = summarizeOutput(call.name, call.output);
  const failed = out.startsWith('error');
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-9 w-full items-baseline gap-2 text-left md:min-h-0"
      >
        <span className="shrink-0 text-ink-400">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-ink-700 dark:text-ink-200">{toolLabel(call.name)}</span>
          {inp && <span className="ml-1.5 text-ink-500 dark:text-ink-400">{inp}</span>}
        </span>
        {out && (
          <span className={`shrink-0 tabular-nums ${failed ? 'text-red-500 dark:text-red-300' : 'text-ink-500 dark:text-ink-400'}`}>
            → {out}
          </span>
        )}
      </button>
      {open && (
        <pre className="mb-1 mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-canvas-100 p-2 font-mono text-[0.7rem] text-ink-700 dark:bg-black/40 dark:text-ink-200">
          {`input: ${JSON.stringify(call.input, null, 2)}\n\noutput: ${JSON.stringify(call.output, null, 2).slice(0, 4000)}`}
        </pre>
      )}
    </li>
  );
}

export function ToolSteps({ calls, live }: { calls: ToolCall[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;
  const expanded = live || open;
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const headline = [...counts.entries()]
    .map(([n, k]) => (k > 1 ? `${toolLabel(n).toLowerCase()} ×${k}` : toolLabel(n).toLowerCase()))
    .join(', ');

  return (
    <div className="rounded-xl border border-canvas-200 bg-canvas-50/60 px-3 py-1.5 text-xs dark:border-white/10 dark:bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        disabled={live}
        className="flex min-h-9 w-full items-center gap-2 text-left text-ink-600 dark:text-ink-300 md:min-h-0"
      >
        <span aria-hidden="true">🔧</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{calls.length} {calls.length === 1 ? 'step' : 'steps'}</span>
          <span className="ml-1.5 text-ink-500 dark:text-ink-400">{headline}</span>
        </span>
        {!live && <span className="shrink-0 text-ink-400">{open ? 'hide' : 'show'}</span>}
      </button>
      {expanded && (
        <ol className="mt-1 space-y-0.5 border-t border-canvas-200 pt-1.5 dark:border-white/10">
          {calls.map((c, i) => (
            <Step key={i} call={c} />
          ))}
        </ol>
      )}
    </div>
  );
}
