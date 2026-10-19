import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import { useChatStore } from '../state/chatStore';
import { usePopupChat } from '../state/popupChatStore';
import { filtersFromParams } from '../filters/urlSync';
import { createSession, listMessages } from '../db/queries/chat';
import { ensureWorkerReady } from '../chat/retrieval';
import { ConversationView } from '../components/chat/ConversationView';
import { Composer } from '../components/chat/Composer';
import { EmptyChatState } from '../components/chat/EmptyChatState';
import { SessionList } from '../components/chat/SessionList';
import { makeWikiClient } from '../chat/wikiClient';
import { useChatTurn } from '../chat/useChatTurn';
import { useQueryClient } from '@tanstack/react-query';
import { useVisualViewport } from '../lib/useVisualViewport';
import { useIsMobile } from '../lib/useIsMobile';
import { useStickToBottom } from '../lib/useStickToBottom';

export function ChatRoute() {
  const handle = useDb();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const sessionId = params.get('s');

  const chatModel = useChatStore((s) => s.chatModel);
  const embedModel = useChatStore((s) => s.embedModel);
  const wikiServerUrl = useChatStore((s) => s.wikiServerUrl);

  const [workerReady, setWorkerReady] = useState(false);
  const [wikiOk, setWikiOk] = useState<boolean>(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  useVisualViewport();

  // "Ask the agent about this tweet" from anywhere inside /chat lands here: the
  // prompt fills this route's composer instead of opening a second chat panel.
  // The nonce keys the composer so the same prompt asked twice still re-fills it.
  const routePrompt = usePopupChat((s) => s.routePrompt);
  const clearRoutePrompt = usePopupChat((s) => s.clearRoutePrompt);
  const [handoff, setHandoff] = useState<{ text: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!routePrompt) return;
    setHandoff(routePrompt);
    clearRoutePrompt();
  }, [routePrompt, clearRoutePrompt]);

  // Sync the worker against the current DB on mount (and on model change).
  // Mid-session imports are handled separately: import paths call
  // markRetrievalStale() and hybridSearch re-syncs the worker before querying.
  useEffect(() => {
    let cancelled = false;
    setBootError(null);
    setWorkerReady(false);
    (async () => {
      try {
        const ready = await ensureWorkerReady(embedModel);
        if (!cancelled) setWorkerReady(ready.embeddingCount > 0);
      } catch (e) {
        if (!cancelled) setBootError(`worker init: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embedModel]);

  // Probe the wiki server once per mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wiki = makeWikiClient(wikiServerUrl);
      const r = await wiki.health();
      if (!cancelled) setWikiOk(!('error' in (r as Record<string, unknown>)));
    })();
    return () => {
      cancelled = true;
    };
  }, [wikiServerUrl]);

  const messages = useQuery({
    queryKey: ['chat-messages', sessionId],
    enabled: !!sessionId,
    queryFn: () => (sessionId ? listMessages(handle.db, sessionId) : []),
  });

  const newSession = (): string => {
    const id = crypto.randomUUID();
    createSession(handle.db, id, chatModel, filters);
    handle.markDirty();
    void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
    const sp = new URLSearchParams(params);
    sp.set('s', id);
    navigate({ pathname: '/chat', search: sp.toString() });
    return id;
  };

  const turn = useChatTurn({
    filters,
    wikiOk,
    workerReady,
    getPriorMessages: () => messages.data ?? [],
    ensureSession: () => sessionId ?? newSession(),
  });

  const error = bootError ?? turn.error;

  // Follow the latest message while the reader is at the bottom; leave them
  // alone if they scrolled up to re-read something.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const { atBottom, scrollToBottom } = useStickToBottom(paneRef, [
    sessionId,
    messages.data,
    turn.pendingAssistant,
    turn.pendingToolCalls.length,
    turn.pendingPhase?.kind,
  ]);
  const settled = !sessionId || messages.isSuccess;
  const isEmpty = settled && (messages.data ?? []).length === 0 && !turn.pendingUser && !turn.pendingAssistant && !turn.busy;

  return (
    <div className="grid h-full grid-cols-1 gap-3 md:grid-cols-[14rem_1fr] md:gap-4">
      <div className="hidden md:block">
        <SessionList activeId={sessionId} onNew={newSession} />
      </div>
      <section className="flex min-h-0 flex-col gap-3">
        <header className="flex items-center justify-between">
          <h1 className="h-display">Chat</h1>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-3 text-xs text-ink-500 md:flex dark:text-ink-300">
              <span>
                Worker:{' '}
                <span className={workerReady ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-yellow-400'}>
                  {workerReady ? '🟢 ready' : '🟡 empty'}
                </span>
              </span>
              <span>
                Wiki:{' '}
                <span className={wikiOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                  {wikiOk ? '🟢 connected' : '🔴 off'}
                </span>
              </span>
            </div>
            {isMobile && (
              <button
                type="button"
                onClick={newSession}
                className="btn-outline text-xs"
              >
                + New
              </button>
            )}
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/40 dark:bg-red-900/20 dark:text-red-200"
          >
            <span className="min-w-0 flex-1 break-words">{error}</span>
            {turn.error && turn.lastInput && !turn.busy && (
              <button type="button" className="btn-outline text-xs" onClick={() => void turn.retry()}>
                Retry
              </button>
            )}
            <button
              type="button"
              className="text-xs underline underline-offset-2"
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
          <div ref={paneRef} className="h-full space-y-3 overflow-auto pr-2">
            <ConversationView
              messages={messages.data ?? []}
              pendingUser={turn.pendingUser ?? undefined}
              pendingAssistant={turn.pendingAssistant ?? undefined}
              pendingPhase={turn.pendingPhase}
              pendingHits={turn.pendingHits}
              pendingToolCalls={turn.pendingToolCalls}
              pendingElapsedMs={turn.pendingElapsedMs}
            />
            {isEmpty && (
              <EmptyChatState filters={filters} disabled={!workerReady} onPick={(p) => void turn.send(p)} />
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

        <div className="shrink-0 pb-[var(--keyboard-height)]">
          <Composer
            key={handoff?.nonce ?? 0}
            filters={filters}
            busy={turn.busy}
            onSend={(t) => void turn.send(t)}
            onStop={turn.stop}
            disabled={!workerReady}
            disabledReason={!workerReady ? 'No embeddings imported yet. Tap ⟳ in the top nav to sync chat search data.' : undefined}
            initialValue={handoff?.text}
          />
        </div>
      </section>
    </div>
  );
}
