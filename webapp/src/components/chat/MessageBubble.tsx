import { useMemo, useState } from 'react';
import { MarkdownMessage } from './MarkdownMessage';
import { SourcesList } from './SourcesList';
import { CitationContext, buildCitationIndex } from './citationContext';
import { formatNumber } from '../../lib/format';

export interface MessageMeta {
  /** Unix seconds when the row was written. */
  createdAt?: number;
  tokenInput?: number | null;
  tokenOutput?: number | null;
}

interface Props {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  pending?: boolean;
  /** Stable key for DOM ids (footnote → source card scrolling). */
  scope?: string;
  meta?: MessageMeta;
  /** Compact sources (no "ask" action) - used by the popup. */
  compact?: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers / non-https contexts
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setState('copied');
    } catch {
      setState('error');
    }
    window.setTimeout(() => setState('idle'), 1500);
  };

  const label =
    state === 'copied' ? 'Copied' : state === 'error' ? 'Failed' : 'Copy';
  const icon =
    state === 'copied' ? (
      // checkmark
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    ) : (
      // overlapping rectangles icon
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="5" width="8" height="8" rx="1.5" />
        <path d="M3 11V4a1 1 0 0 1 1-1h7" />
      </svg>
    );

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy message"
      aria-label="Copy message to clipboard"
      className={`inline-flex min-h-11 items-center gap-1 rounded-md border border-canvas-200 bg-white/60 px-1.5 py-0.5 text-[11px] font-medium text-ink-500 transition-colors hover:bg-white hover:text-ink-800 md:min-h-0 dark:border-white/10 dark:bg-white/5 dark:text-ink-300 dark:hover:bg-white/10 dark:hover:text-ink-50 ${
        state === 'copied' ? 'text-emerald-600 dark:text-emerald-300' : ''
      } ${state === 'error' ? 'text-red-600 dark:text-red-300' : ''}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function timeOfDay(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function MessageBubble({ role, content, pending, scope = 'pending', meta, compact }: Props) {
  const wrapper =
    role === 'user'
      ? 'border-accent-200 bg-accent-50 text-ink-900 dark:border-accent-500/30 dark:bg-accent-500/10 dark:text-ink-50'
      : role === 'tool'
        ? 'border-canvas-200 bg-canvas-100 font-mono text-xs text-ink-600 dark:border-white/10 dark:bg-black/30 dark:text-ink-300'
        : 'border-canvas-200 bg-white text-ink-800 shadow-soft dark:border-white/10 dark:bg-white/5 dark:text-ink-100 dark:shadow-none';

  // Copy button is only useful on assistant output, and only once it's fully
  // streamed. Hide while pending - copying half a response is rarely useful
  // and the partial text often ends mid-sentence.
  const showCopy = role === 'assistant' && !pending && content.trim().length > 0;

  const index = useMemo(
    () => (role === 'assistant' ? buildCitationIndex(scope, content) : null),
    [role, scope, content],
  );

  const tokens =
    meta && (meta.tokenInput || meta.tokenOutput)
      ? `${formatNumber(meta.tokenInput ?? 0)} in · ${formatNumber(meta.tokenOutput ?? 0)} out`
      : null;

  return (
    <div className={`group relative rounded-2xl border px-4 py-3 text-sm leading-relaxed ${wrapper}`}>
      <div className="mb-1 flex items-center justify-between">
        {role === 'user' && <div className="label text-accent-700 dark:text-accent-300">You</div>}
        {role === 'assistant' && <div className="label text-ink-500 dark:text-ink-300">Agent</div>}
        {role === 'tool' && <div className="label text-ink-400">Tool</div>}
        {showCopy && (
        <div className="opacity-100 transition-opacity md:opacity-60 md:group-hover:opacity-100">
            <CopyButton text={content} />
          </div>
        )}
      </div>
      {role === 'assistant' && index ? (
        <CitationContext.Provider value={index}>
          <div>
            <MarkdownMessage content={content} />
            {pending && <span className="ml-0.5 inline-block animate-pulse">▌</span>}
          </div>
          <SourcesList index={index} compact={compact} />
        </CitationContext.Provider>
      ) : (
        <div className="whitespace-pre-wrap break-words">
          {content}
          {pending && <span className="ml-1 inline-block animate-pulse">▌</span>}
        </div>
      )}
      {role === 'assistant' && !pending && meta && (meta.createdAt || tokens) && (
        <div className="mt-2 flex flex-wrap gap-x-3 text-[10px] tabular-nums text-ink-400 dark:text-ink-500">
          {meta.createdAt ? <span>{timeOfDay(meta.createdAt)}</span> : null}
          {tokens ? <span title="Prompt tokens in · completion tokens out">{tokens}</span> : null}
        </div>
      )}
    </div>
  );
}
