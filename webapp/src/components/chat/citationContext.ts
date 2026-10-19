// Shared numbering for tweet citations inside one assistant message.
//
// MarkdownMessage computes the first-appearance order of every [^tweetid]
// in the text and publishes it here; the inline chip renders "[3]" and the
// SourcesList renders the matching numbered card. `scope` namespaces the DOM
// ids so chips in one message never scroll to a card in another.

import { createContext, useContext } from 'react';

export interface CitationIndex {
  scope: string;
  /** tweetId → 1-based footnote number. */
  numbers: Map<string, number>;
}

export const CitationContext = createContext<CitationIndex>({
  scope: 'none',
  numbers: new Map(),
});

export function useCitationIndex(): CitationIndex {
  return useContext(CitationContext);
}

export function sourceDomId(scope: string, tweetId: string): string {
  return `chat-src-${scope}-${tweetId}`;
}

const TWEET_RE = /\[\^(\d{6,25})\]/g;

/** Unique tweet ids in first-appearance order. */
export function orderedTweetCitations(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of content.matchAll(TWEET_RE)) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function buildCitationIndex(scope: string, content: string): CitationIndex {
  const numbers = new Map<string, number>();
  orderedTweetCitations(content).forEach((id, i) => numbers.set(id, i + 1));
  return { scope, numbers };
}
