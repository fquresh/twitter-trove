// Tiny global store for the chat surfaces. Lets any component (layout button,
// tweet-card "Ask the agent" link, source card, selection bar, command palette)
// start a question without prop-drilling.
//
// There are two surfaces: the floating popup (ChatPopup, desktop only) and the
// full /chat route. Exactly one of them may be visible at a time - `ask()`
// through useAskAgent() hands the prompt to whichever one the reader is
// already looking at, instead of stacking a second chat on top of the first.

import { create } from 'zustand';

/** A prompt on its way to the /chat route's composer. The nonce lets the route
 *  re-fill the composer even when the same prompt is asked twice. */
export interface RoutePrompt {
  text: string;
  nonce: number;
}

interface PopupChatState {
  open: boolean;
  initialPrompt: string | undefined;
  routePrompt: RoutePrompt | undefined;
  toggle: () => void;
  show: (initialPrompt?: string) => void;
  hide: () => void;
  /** Hand a prompt to the /chat route's composer. */
  handToRoute: (text: string) => void;
  clearRoutePrompt: () => void;
}

let handoffNonce = 0;

export const usePopupChat = create<PopupChatState>((set) => ({
  open: false,
  initialPrompt: undefined,
  routePrompt: undefined,
  toggle: () => set((s) => ({ open: !s.open })),
  show: (initialPrompt) => set({ open: true, initialPrompt }),
  hide: () => set({ open: false, initialPrompt: undefined }),
  handToRoute: (text) => set({ open: false, initialPrompt: undefined, routePrompt: { text, nonce: ++handoffNonce } }),
  clearRoutePrompt: () => set({ routePrompt: undefined }),
}));
