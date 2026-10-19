import { useState } from 'react';

interface Props {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
}

export function ToolCallBadge({ name, input, output }: Props) {
  const [open, setOpen] = useState(false);
  const summary = summarize(name, output);
  return (
    <div className="rounded-md border border-canvas-200 bg-canvas-100 px-3 py-2 text-xs dark:border-white/5 dark:bg-black/30">
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between text-left text-ink-700 md:min-h-0 dark:text-ink-200"
        onClick={() => setOpen((p) => !p)}
      >
        <span>
          <span className="mr-1">🔧</span>
          <span className="font-mono">{name}</span>
          <span className="ml-2 text-ink-400">{summary}</span>
        </span>
        <span className="text-ink-400">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[0.7rem] text-ink-700 dark:bg-black/40 dark:text-ink-200">
          input: {JSON.stringify(input, null, 2)}
          {'\n\n'}
          output: {JSON.stringify(output, null, 2).slice(0, 4000)}
        </pre>
      )}
    </div>
  );
}

function summarize(name: string, output: unknown): string {
  if (output && typeof output === 'object' && 'count' in (output as Record<string, unknown>)) {
    return `→ ${(output as { count: number }).count}`;
  }
  if (Array.isArray(output)) return `→ ${output.length} rows`;
  if (output && typeof output === 'object' && 'hits' in (output as Record<string, unknown>)) {
    const hits = (output as { hits: unknown[] }).hits;
    return Array.isArray(hits) ? `→ ${hits.length} hits` : '';
  }
  if (output && typeof output === 'object' && 'error' in (output as Record<string, unknown>)) {
    return `→ error: ${(output as { error: string }).error}`;
  }
  if (name === 'get_tweet_by_id' && output && typeof output === 'object' && 'id' in (output as Record<string, unknown>)) {
    return `→ tweet ${(output as { id: string }).id}`;
  }
  return '';
}
