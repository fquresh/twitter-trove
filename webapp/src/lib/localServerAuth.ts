// Bearer token for the local server (wiki_server.py).
//
// Any local account can reach a loopback port, so the server needs a secret
// that only this user has. ./trove start writes it to the mode-600 file
// .wiki_token, and the user pastes it once in Settings. It is stored with the
// API keys in this origin's localStorage, which already holds the keys the
// token protects. It is never a VITE_* variable: `vite dev` inlines those into
// the modules it serves, and any local account can fetch them from loopback.

import { useChatStore } from '../state/chatStore';

/** Headers for a request to the local server. Empty when no token is saved. */
export function localServerHeaders(token = useChatStore.getState().wikiToken): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
