// Single entry point for "ask the agent about this" actions (tweet cards,
// source cards, the selection bar, the command palette).
//
// Before this existed, every one of those called usePopupChat.show() directly,
// so asking a question from inside /chat opened the floating popup over the
// conversation the reader was already in - a second chat, with its own session
// and its own composer. The rule now: hand the prompt to the surface that is
// already on screen.
//
//   on /chat        -> the route's composer (pre-filled, focused)
//   on a phone      -> the popup is not rendered at all, so navigate to /chat
//   anywhere else   -> the floating popup
//
// The surface is read at click time rather than subscribed to: TweetCard is
// memoized and rendered in lists, and a router or matchMedia subscription per
// card would be paid for on every render.

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePopupChat } from '../../state/popupChatStore';

const MOBILE_QUERY = '(max-width: 767px)';

export function useAskAgent(): (prompt: string) => void {
  const navigate = useNavigate();
  const show = usePopupChat((s) => s.show);
  const handToRoute = usePopupChat((s) => s.handToRoute);

  return useCallback(
    (prompt: string) => {
      if (window.location.pathname.startsWith('/chat')) {
        handToRoute(prompt);
        return;
      }
      if (window.matchMedia(MOBILE_QUERY).matches) {
        // Keep the reader's filter scope, which the chat route reads off the URL.
        navigate({ pathname: '/chat', search: window.location.search });
        handToRoute(prompt);
        return;
      }
      show(prompt);
    },
    [navigate, show, handToRoute],
  );
}
