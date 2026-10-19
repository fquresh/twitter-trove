// Floating chat panel reachable from any page. Click the launcher (bottom-
// right) or hit ⌘K to open. Picks up the most recent session, or creates a
// fresh one - same DB persistence as /chat. "Expand" jumps to the full
// chat surface preserving the session id so context is continuous.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useDb } from '../../lib/dbContext';
import { useChatStore } from '../../state/chatStore';
import { filtersFromParams } from '../../filters/urlSync';
import { ensureWorkerReady } from '../../chat/retrieval';
import { useChatTurn } from '../../chat/useChatTurn';
import {
  createSession,
  listMessages,
  listSessions,
} from '../../db/queries/chat';
import { makeWikiClient } from '../../chat/wikiClient';
import { ConversationView } from './ConversationView';
import { Composer } from './Composer';
import { EmptyChatState } from './EmptyChatState';
import { useStickToBottom } from '../../lib/useStickToBottom';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional initial prompt to pre-fill the composer (e.g. from "Ask about this tweet"). */
  initialPrompt?: string;
}

export function ChatPopup({ open, onClose, initialPrompt }: Props) {
  const handle = useDb();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);

  const chatModel = useChatStore((s) => s.chatModel);
  const embedModel = useChatStore((s) => s.embedModel);
  const wikiServerUrl = useChatStore((s) => s.wikiServerUrl);

  // Reuse the most recent session. Lazily allocated on first send.
  const sessionsQ = useQuery({
    enabled: open,
    queryKey: ['chat-sessions-popup'],
    queryFn: () => listSessions(handle.db, 1),
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (open && !sessionId && sessionsQ.data?.[0]) {
      setSessionId(sessionsQ.data[0].id);
    }
  }, [open, sessionsQ.data, sessionId]);

  const messagesQ = useQuery({
    enabled: open && !!sessionId,
    queryKey: ['chat-messages', sessionId],
    queryFn: () => (sessionId ? listMessages(handle.db, sessionId) : []),
  });

  const [workerReady, setWorkerReady] = useState(false);
  const [wikiOk, setWikiOk] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBootError(null);
    void (async () => {
      try {
        const ready = await ensureWorkerReady(embedModel);
        if (!cancelled) setWorkerReady(ready.embeddingCount > 0);
      } catch (e) {
        if (!cancelled) {
          setWorkerReady(false);
          setBootError(`Worker initialization failed: ${(e as Error).message}`);
        }
      }
    })();
    void (async () => {
      const wiki = makeWikiClient(wikiServerUrl);
      const r = await wiki.health();
      if (!cancelled) setWikiOk(!('error' in (r as Record<string, unknown>)));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, embedModel, wikiServerUrl]);

  const ensureSession = (): string => {
    if (sessionId) return sessionId;
    const id = crypto.randomUUID();
    createSession(handle.db, id, chatModel, filters);
    handle.markDirty();
    setSessionId(id);
    void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['chat-sessions-popup'] });
    return id;
  };

  const turn = useChatTurn({
    filters,
    wikiOk,
    workerReady,
    getPriorMessages: () => messagesQ.data ?? [],
    ensureSession,
  });

  // Pre-fill the composer when an initialPrompt arrives. Only sets once per
  // open - if the user types something else, we don't clobber.
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const lastPrompt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (open && initialPrompt && lastPrompt.current !== initialPrompt) {
      setPrefill(initialPrompt);
      lastPrompt.current = initialPrompt;
    }
    if (!open) lastPrompt.current = undefined;
  }, [open, initialPrompt]);

  const paneRef = useRef<HTMLDivElement | null>(null);
  const { atBottom, scrollToBottom } = useStickToBottom(paneRef, [
    open,
    messagesQ.data,
    turn.pendingAssistant,
    turn.pendingToolCalls.length,
    turn.pendingPhase?.kind,
  ]);
  // Only show the starter panel once we know the session has no messages;
  // otherwise it flashes for a frame while the latest session loads.
  const settled = !sessionsQ.isLoading && (!sessionId || messagesQ.isSuccess);
  const isEmpty = settled && (messagesQ.data ?? []).length === 0 && !turn.pendingUser && !turn.busy;

  // Esc to close. The panel stays mounted while closed (below), so dismissing
  // it never throws away a half-typed question.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Dialog behaviour: focus lands in the composer on open (or on the first
  // control when the composer is disabled), and goes back to whatever opened
  // the panel on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const panel = document.querySelector('[data-testid="chat-popup"]');
      const target =
        panel?.querySelector<HTMLElement>('[data-chat-composer]:not([disabled])') ??
        panel?.querySelector<HTMLElement>('button');
      target?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      triggerRef.current?.focus?.();
      triggerRef.current = null;
    };
  }, [open]);

  return (
    <div
      className={`fixed inset-0 z-40 flex items-stretch justify-end bg-ink-900/30 backdrop-blur-sm dark:bg-black/50 ${open ? '' : 'hidden'}`}
      onClick={onClose}
      data-testid="chat-popup"
      role="dialog"
      aria-modal="true"
      aria-label="Quick chat"
      aria-hidden={!open}
    >
      <aside
        className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-canvas-200 bg-white shadow-[-18px_0_44px_-12px_rgba(124,58,237,0.25)] dark:border-accent-500/20 dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-canvas-200 px-5 py-4 dark:border-white/10">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-accent-100 text-accent-700 shadow-soft dark:bg-accent-500/20 dark:text-accent-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500 opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-600" />
              </span>
            </span>
            <div className="min-w-0">
              <div className="label">Quick chat</div>
              <div className="hidden text-xs text-ink-500 dark:text-ink-300 sm:block">
                {workerReady ? '🟢 worker ready' : '🟡 worker empty'} ·{' '}
                {wikiOk ? '🟢 wiki' : '⚪️ no wiki'}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              to={sessionId ? `/chat?s=${sessionId}` : '/chat'}
              className="btn-outline inline-flex min-h-[44px] items-center text-xs"
              onClick={onClose}
              title="Continue this conversation in the full chat view"
            >
              Expand ↗
            </Link>
            <button
              type="button"
              className="btn-outline inline-flex min-h-[44px] items-center text-xs"
              onClick={onClose}
            >
              Close (Esc)
            </button>
          </div>
        </header>

        {(bootError ?? turn.error) && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-900/20 dark:text-red-200"
          >
            <span className="min-w-0 flex-1 break-words">{bootError ?? turn.error}</span>
            {turn.error && turn.lastInput && !turn.busy && (
              <button type="button" className="underline underline-offset-2" onClick={() => void turn.retry()}>
                Retry
              </button>
            )}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setBootError(null);
                turn.setError(null);
              }}
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <div ref={paneRef} className="h-full space-y-3 overflow-auto px-5 py-4">
            <ConversationView
              messages={messagesQ.data ?? []}
              pendingUser={turn.pendingUser ?? undefined}
              pendingAssistant={turn.pendingAssistant ?? undefined}
              pendingPhase={turn.pendingPhase}
              pendingHits={turn.pendingHits}
              pendingToolCalls={turn.pendingToolCalls}
              pendingElapsedMs={turn.pendingElapsedMs}
              compact
            />
            {isEmpty && (
              <EmptyChatState
                filters={filters}
                compact
                disabled={!workerReady}
                onPick={(p) => {
                  setPrefill(undefined);
                  void turn.send(p);
                }}
              />
            )}
          </div>
          {!atBottom && (
            <button
              type="button"
              onClick={() => scrollToBottom()}
              className="btn-outline absolute bottom-3 left-1/2 -translate-x-1/2 text-xs shadow-md"
            >
              ↓ Latest
            </button>
          )}
        </div>

        <div className="border-t border-canvas-200 p-3 dark:border-white/10">
          <Composer
            filters={filters}
            busy={turn.busy}
            onSend={(t) => {
              setPrefill(undefined);
              void turn.send(t);
            }}
            onStop={turn.stop}
            disabled={!workerReady}
            disabledReason={!workerReady ? 'Import enriched_tweets.json first.' : undefined}
            initialValue={prefill}
          />
        </div>
      </aside>
    </div>
  );
}
