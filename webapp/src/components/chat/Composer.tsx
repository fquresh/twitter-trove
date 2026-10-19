import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isEmptyFilterSet, type FilterSet } from '../../filters/types';
import { useIsMobile } from '../../lib/useIsMobile';

interface Props {
  filters: FilterSet;
  busy: boolean;
  onSend: (text: string) => void;
  /** Abort the in-flight turn. Shown in place of Send while busy. */
  onStop?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  /** Pre-fill the textarea once. Updates only when this value changes. */
  initialValue?: string;
}

const MAX_HEIGHT_PX = 240;

export function Composer({ filters, busy, onSend, onStop, disabled, disabledReason, initialValue }: Props) {
  const [text, setText] = useState(initialValue ?? '');
  const lastInit = useRef<string | undefined>(initialValue);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (initialValue !== undefined && initialValue !== lastInit.current) {
      setText(initialValue);
      lastInit.current = initialValue;
      taRef.current?.focus();
    }
  }, [initialValue]);

  // Grow with the content up to a cap, then scroll inside.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(ta.scrollHeight, MAX_HEIGHT_PX);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, [text]);

  // Hand focus back once a turn finishes so the next question can be typed
  // without reaching for the mouse.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && !isMobile) taRef.current?.focus();
    wasBusy.current = busy;
  }, [busy, isMobile]);

  const filterChip = filterScopeChip(filters);
  const submit = () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    setText('');
    onSend(t);
  };

  return (
    <div className="card flex flex-col gap-2 p-3">
      {disabled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-yellow-700/50 dark:bg-yellow-900/20 dark:text-yellow-200">
          {disabledReason ?? 'Chat disabled.'}
        </div>
      )}
      {filterChip && (
        <div className="min-w-0 break-words text-xs text-ink-500 dark:text-ink-300">
          Scoped to: <span className="font-mono text-accent-600 dark:text-accent-300">{filterChip}</span>
        </div>
      )}
      <textarea
        ref={taRef}
        rows={2}
        data-chat-composer
        className="input min-h-[44px] resize-none"
        placeholder="Ask the agent - e.g. 'what's my through-line on AI agents?'"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          // Desktop: Enter sends, Shift+Enter inserts a newline. Mobile: Enter
          // is a newline and the Send button submits. ⌘/Ctrl+Enter always sends.
          const sendCombo = e.metaKey || e.ctrlKey || (!isMobile && !e.shiftKey);
          if (sendCombo && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={disabled}
      />
      <div className="flex items-center justify-between gap-2 text-xs text-ink-400">
        <span className="hidden md:inline">
          {isMobile ? '' : 'Enter to send · Shift+Enter for a new line'}
        </span>
        <span className="md:hidden" />
        {busy ? (
          <button
            type="button"
            className="btn-outline inline-flex items-center gap-1.5 border-red-300 text-red-700 hover:border-red-400 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-200 dark:hover:bg-red-900/20"
            onClick={onStop}
            disabled={!onStop}
            aria-label="Stop generating"
          >
            <span className="inline-block h-2 w-2 rounded-sm bg-current" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary disabled:opacity-50"
            disabled={disabled || !text.trim()}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function filterScopeChip(f: FilterSet): string | null {
  if (isEmptyFilterSet(f)) return null;
  const parts: string[] = [];
  if (f.categories.length > 0) parts.push(`categories: ${f.categories.join(', ')}`);
  if (f.authors.length > 0) parts.push(`@${f.authors.join(', @')}`);
  if (f.tickers.length > 0) parts.push(`$${f.tickers.join(', $')}`);
  if (f.hashtags.length > 0) parts.push(`#${f.hashtags.join(', #')}`);
  if (f.from !== null || f.to !== null) {
    const fmt = (s: number | null) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '∞');
    parts.push(`${fmt(f.from)} → ${fmt(f.to)}`);
  }
  if (f.q) parts.push(`q="${f.q}"`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
