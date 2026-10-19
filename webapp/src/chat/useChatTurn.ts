// Shared hook that wires the chat agent loop to React state. Powers both
// the full ChatRoute surface and the floating popup chat - they each pass
// their own session id and filter scope, but the embed → hybrid-search →
// runTurn → persist sequence is identical.

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDb } from '../lib/dbContext';
import { useChatStore } from '../state/chatStore';
import { embedQuery } from './voyage';
import { hybridSearch } from './retrieval';
import { runTurn, type AgentEvent } from './agent';
import { makeDeepseekClient, PROXY_MODE } from './client';
import { makeWikiClient } from './wikiClient';
import { SYSTEM_PROMPT_SQL_ONLY, SYSTEM_PROMPT_WITH_WIKI } from './prompts';
import { appendMessage, setSessionTitle, type ChatMessageRow } from '../db/queries/chat';
import { extractTweetIds } from './citationParser';
import type { ToolEnv } from './tools';
import type { FilterSet } from '../filters/types';
import type { RetrievalHit } from './retrievalCore';

interface Options {
  filters: FilterSet;
  wikiOk: boolean;
  workerReady: boolean;
  getPriorMessages: () => ChatMessageRow[];
  /** Called once a session id is known (for routes that need to navigate). */
  onSessionEnsured?: (sid: string) => void;
  /** Called to lazily allocate a new session if one isn't passed. */
  ensureSession: () => string;
}

/** What the in-flight turn is doing, for the live status line. */
export type TurnPhase =
  | { kind: 'embedding' }
  | { kind: 'searching' }
  | { kind: 'thinking'; round: number }
  | { kind: 'reasoning'; round: number }
  | { kind: 'tool'; name: string; round: number }
  | { kind: 'writing' };

export interface ChatTurnState {
  busy: boolean;
  error: string | null;
  pendingUser: string | null;
  pendingAssistant: string | null;
  pendingPhase: TurnPhase | null;
  pendingHits: RetrievalHit[];
  pendingElapsedMs: number | undefined;
  pendingToolCalls: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  /** The most recent input, kept so a failed turn can be retried. */
  lastInput: string | null;
  send: (userInput: string) => Promise<void>;
  /** Re-send `lastInput` after an error. */
  retry: () => Promise<void>;
  /** Abort the in-flight turn. Partial output is persisted with a marker. */
  stop: () => void;
  setError: (s: string | null) => void;
}

export function useChatTurn(opts: Options): ChatTurnState {
  const handle = useDb();
  const queryClient = useQueryClient();
  const deepseekApiKey = useChatStore((s) => s.deepseekApiKey);
  const voyageApiKey = useChatStore((s) => s.voyageApiKey);
  const chatModel = useChatStore((s) => s.chatModel);
  const embedModel = useChatStore((s) => s.embedModel);
  const wikiServerUrl = useChatStore((s) => s.wikiServerUrl);

  const [busy, setBusy] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string | null>(null);
  const [pendingHits, setPendingHits] = useState<RetrievalHit[]>([]);
  const [pendingElapsedMs, setPendingElapsedMs] = useState<number | undefined>(undefined);
  const [pendingToolCalls, setPendingToolCalls] = useState<
    Array<{ name: string; input: Record<string, unknown>; output: unknown }>
  >([]);
  const [pendingPhase, setPendingPhase] = useState<TurnPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Set once the user's message row is written for the current input, so a
  // retry after a later failure does not persist it a second time.
  const userPersistedRef = useRef<{ input: string; sid: string } | null>(null);

  const send = async (userInput: string) => {
    setError(null);
    setLastInput(userInput);
    // In proxy mode the keys live in Cloudflare env vars server-side; browser
    // never sees them. Otherwise both must be pasted in Settings.
    if (!PROXY_MODE && (!deepseekApiKey || !voyageApiKey)) {
      setError(
        'Settings missing: load DeepSeek + Voyage keys in /settings (the "Load keys from .env" button is the fastest path).',
      );
      return;
    }
    if (!opts.workerReady) {
      setError(
        'Retrieval index empty - drop enriched_tweets.json on /import (or run npm run seed in dev) before chatting.',
      );
      return;
    }

    const sid = opts.ensureSession();
    opts.onSessionEnsured?.(sid);
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setPendingUser(userInput);
    setPendingAssistant('');
    setPendingPhase({ kind: 'embedding' });
    setPendingHits([]);
    setPendingToolCalls([]);

    const wikiClient = opts.wikiOk ? makeWikiClient(wikiServerUrl) : undefined;
    let assistantBuffer = '';
    const turnToolCalls: Array<{
      name: string;
      input: Record<string, unknown>;
      output: unknown;
    }> = [];
    let hits: RetrievalHit[] = [];
    let tokenIn = 0;
    let tokenOut = 0;
    let userPersisted = false;
    try {
      const t0 = performance.now();
      const queryEmbedding = await embedQuery(userInput, {
        apiKey: voyageApiKey,
        model: embedModel,
      });
      if (abort.signal.aborted) throw new DOMException('Stopped', 'AbortError');
      setPendingPhase({ kind: 'searching' });
      hits = await hybridSearch(queryEmbedding, userInput, opts.filters, 20);
      const elapsedMs = performance.now() - t0;
      setPendingHits(hits);
      setPendingElapsedMs(elapsedMs);
      if (abort.signal.aborted) throw new DOMException('Stopped', 'AbortError');

      // A retry of an input whose user row already exists must not write it
      // again - the earlier attempt died after persisting the question.
      const already = userPersistedRef.current;
      const isRetry = already !== null && already.input === userInput && already.sid === sid;
      let prior = opts.getPriorMessages();
      if (isRetry) {
        const last = prior[prior.length - 1];
        if (last && last.role === 'user' && last.content === userInput) prior = prior.slice(0, -1);
      } else {
        appendMessage(handle.db, {
          session_id: sid,
          role: 'user',
          content: userInput,
          retrieved_ids: hits.map((h) => h.tweetId),
        });
        userPersistedRef.current = { input: userInput, sid };
        handle.markDirty();
        void queryClient.invalidateQueries({ queryKey: ['chat-messages', sid] });
      }
      userPersisted = true;

      if (prior.filter((m) => m.role === 'user').length === 0) {
        setSessionTitle(handle.db, sid, userInput.slice(0, 80));
        void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
      }

      const agentClient = makeDeepseekClient(deepseekApiKey);
      const toolEnv: ToolEnv = {
        db: handle.db,
        baseFilters: opts.filters,
        searchHandler: async (input) => {
          const { query: q, k, ...rest } = input;
          const qEmb = await embedQuery(q, { apiKey: voyageApiKey, model: embedModel });
          const sub: FilterSet = { ...opts.filters };
          if (rest.categories) sub.categories = rest.categories;
          if (rest.authors) sub.authors = rest.authors;
          if (rest.tickers) sub.tickers = rest.tickers.map((t: string) => t.toUpperCase());
          if (rest.hashtags) sub.hashtags = rest.hashtags.map((h: string) => h.toLowerCase());
          if (rest.mentions) sub.mentions = rest.mentions.map((m: string) => m.toLowerCase());
          return hybridSearch(qEmb, q, sub, k ?? 20);
        },
        wiki: wikiClient,
      };

      let round = 1;
      const apply = (ev: AgentEvent) => {
        switch (ev.type) {
          case 'status':
            if (ev.status) {
              round = ev.status.round;
              setPendingPhase({ kind: ev.status.phase, round });
            }
            break;
          case 'text_delta':
            if (ev.text) {
              assistantBuffer += ev.text;
              setPendingAssistant(assistantBuffer);
              setPendingPhase({ kind: 'writing' });
            }
            break;
          case 'tool_use':
            if (ev.tool) setPendingPhase({ kind: 'tool', name: ev.tool.name, round });
            break;
          case 'tool_result':
            if (ev.tool && ev.result !== undefined) {
              turnToolCalls.push({
                name: ev.tool.name,
                input: ev.tool.input,
                output: ev.result,
              });
              setPendingToolCalls([...turnToolCalls]);
            }
            break;
          case 'turn_complete':
            tokenIn = ev.usage?.input ?? 0;
            tokenOut = ev.usage?.output ?? 0;
            if (ev.finalText) assistantBuffer = ev.finalText;
            break;
          case 'error':
            setError(ev.error ?? 'agent error');
            break;
        }
      };

      for await (const ev of runTurn(
        {
          client: agentClient,
          toolEnv,
          model: chatModel,
          systemPrompt: opts.wikiOk ? SYSTEM_PROMPT_WITH_WIKI : SYSTEM_PROMPT_SQL_ONLY,
          wikiEnabled: opts.wikiOk,
          signal: abort.signal,
        },
        {
          userInput,
          priorMessages: prior.map((m) => ({
            role: m.role === 'assistant' || m.role === 'user' ? m.role : 'user',
            content: m.content,
          })),
          prefetchedHits: hits,
        },
      )) {
        apply(ev);
      }

      // Always persist the assistant turn - even if `assistantBuffer` is
      // empty. Otherwise a length-truncated turn (reasoning model ate the
      // token budget without emitting `content`) silently disappears after
      // the pending bubble clears, and the user has no idea anything ran.
      // Stash a marker so the conversation log makes clear what happened.
      const persistedContent =
        assistantBuffer ||
        (turnToolCalls.length > 0
          ? '_(Agent ran tools but produced no text - likely hit max_tokens. Raise the limit in Settings or try a non-reasoning model.)_'
          : '_(Empty response from the model.)_');
      persistAssistant(sid, persistedContent);
      userPersistedRef.current = null;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        // User pressed Stop. Keep whatever streamed so the transcript stays
        // honest about what was and was not answered.
        if (userPersisted) {
          persistAssistant(
            sid,
            (assistantBuffer ? assistantBuffer.trimEnd() + '\n\n' : '') + '_(Stopped by you.)_',
          );
          userPersistedRef.current = null;
        }
      } else {
        setError(err.message);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setPendingUser(null);
      setPendingAssistant(null);
      setPendingPhase(null);
      setPendingToolCalls([]);
      setPendingHits([]);
      setPendingElapsedMs(undefined);
    }

    function persistAssistant(sessionId: string, content: string) {
      appendMessage(handle.db, {
        session_id: sessionId,
        role: 'assistant',
        content,
        citations: assistantBuffer ? extractTweetIds(assistantBuffer) : [],
        retrieved_ids: hits.map((h) => h.tweetId),
        tool_calls: turnToolCalls.length > 0 ? turnToolCalls : undefined,
        token_input: tokenIn,
        token_output: tokenOut,
      });
      // Flush now rather than on the 2 s debounce: a completed answer is the
      // most valuable write in the app, and the unload-time flush is only
      // best-effort. Navigating away seconds after an answer must not lose it.
      void handle.flush();
      void queryClient.invalidateQueries({ queryKey: ['chat-messages', sessionId] });
    }
  };

  const retry = async () => {
    if (lastInput && !busy) await send(lastInput);
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  return {
    busy,
    error,
    pendingUser,
    pendingAssistant,
    pendingPhase,
    pendingHits,
    pendingElapsedMs,
    pendingToolCalls,
    lastInput,
    send,
    retry,
    stop,
    setError,
  };
}
