// Zustand persist for chat-related user prefs. Only credentials + model
// choices live here - conversation history is DB-only (chat_messages),
// accessed via TanStack Query.
//
// Plan §risk register #1: API keys live in localStorage, reachable from any
// dependency via XSS. The Settings UI shows a yellow security banner.
//
// As of 2026-08, chat is wired through the DeepSeek native API (one key,
// model `deepseek-v4-flash` by default). Voyage stays separate because no
// DeepSeek-hosted embedding model beats it on small-corpus retrieval.
// OpenRouter remains only in the offline Python pipeline.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ChatStoreState {
  /** DeepSeek API key - single key for the chat LLM (native api.deepseek.com). */
  deepseekApiKey: string;
  /** Voyage API key - for embedding the user's query at chat time. */
  voyageApiKey: string;
  /** Free-text model id passed straight to DeepSeek (e.g. deepseek-v4-flash,
   *  deepseek-v4-pro). No provider prefix on the native API. */
  chatModel: string;
  /** Embedding model used at index time; the chat agent embeds queries with the same model. */
  embedModel: string;
  /** Read-only reflection - whether the user has authorized browser-key risk. */
  acknowledgedKeyRisk: boolean;
  /** Wiki server URL for Phase 13 wiki tools. */
  wikiServerUrl: string;
  /** Bearer token for wiki_server.py, pasted from .wiki_token. Local mode only. */
  wikiToken: string;

  setDeepseekApiKey(v: string): void;
  setVoyageApiKey(v: string): void;
  setChatModel(v: string): void;
  setEmbedModel(v: string): void;
  setAcknowledgedKeyRisk(v: boolean): void;
  setWikiServerUrl(v: string): void;
  setWikiToken(v: string): void;
  clearKeys(): void;
}

const DEFAULT_CHAT_MODEL = 'deepseek-v4-flash';

export const useChatStore = create<ChatStoreState>()(
  persist(
    (set) => ({
      deepseekApiKey: '',
      voyageApiKey: '',
      chatModel: DEFAULT_CHAT_MODEL,
      embedModel: 'voyage-3-large',
      acknowledgedKeyRisk: false,
      wikiServerUrl: 'http://localhost:8765',
      wikiToken: '',

      setDeepseekApiKey: (v) => set({ deepseekApiKey: v.trim() }),
      setVoyageApiKey: (v) => set({ voyageApiKey: v.trim() }),
      setChatModel: (v) => set({ chatModel: v.trim() }),
      setEmbedModel: (v) => set({ embedModel: v }),
      setAcknowledgedKeyRisk: (v) => set({ acknowledgedKeyRisk: v }),
      setWikiServerUrl: (v) => set({ wikiServerUrl: v.trim() }),
      setWikiToken: (v) => set({ wikiToken: v.trim() }),
      clearKeys: () => set({ deepseekApiKey: '', voyageApiKey: '' }),
    }),
    {
      name: 'trove-chat',
      version: 3,
      // Drop fields from older versions of the schema.
      //   v1 stored `anthropicApiKey` + an Anthropic-only `chatModel`.
      //   v2 stored `openrouterApiKey` + an OpenRouter-style `chatModel`
      //       (e.g. `deepseek/deepseek-v4-pro`, `anthropic/claude-sonnet-4`).
      //   v3 renames `openrouterApiKey` -> `deepseekApiKey` and resets any
      //       model id that looks OpenRouter-namespaced (`contains '/'`) or
      //       Anthropic-native (`starts with 'claude-'`) to the new default,
      //       since those ids are invalid on the DeepSeek native API.
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return persisted;
        const p = persisted as Record<string, unknown>;
        if (version < 2) {
          delete p.anthropicApiKey;
          if (
            typeof p.chatModel !== 'string' ||
            (p.chatModel as string).startsWith('claude-')
          ) {
            p.chatModel = DEFAULT_CHAT_MODEL;
          }
        }
        if (version < 3) {
          // The OpenRouter key is not valid on the DeepSeek native API; drop it
          // so the user is prompted to paste a DeepSeek key in Settings.
          delete p.openrouterApiKey;
          const m = p.chatModel;
          if (
            typeof m !== 'string' ||
            m.includes('/') ||
            m.startsWith('claude-')
          ) {
            p.chatModel = DEFAULT_CHAT_MODEL;
          }
        }
        return p;
      },
      partialize: (s) => ({
        deepseekApiKey: s.deepseekApiKey,
        voyageApiKey: s.voyageApiKey,
        chatModel: s.chatModel,
        embedModel: s.embedModel,
        acknowledgedKeyRisk: s.acknowledgedKeyRisk,
        wikiServerUrl: s.wikiServerUrl,
        wikiToken: s.wikiToken,
      }),
    },
  ),
);

export function maskKey(k: string): string {
  if (!k) return '(none)';
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}
