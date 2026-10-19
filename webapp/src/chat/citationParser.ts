// Splits assistant text into a sequence of segments and tweet-id citations.
// Used by MessageBubble.tsx - the renderer maps citations to <CitationCard>.
//
// Citation grammar (locked by the system prompt):
//   - Tweet citation:    [^1234567890]   numeric, 6-25 digits
//   - Wiki citation:     [[concepts/ai-agents]]   any non-bracket path
//
// We surface tweet ids and wiki paths uniformly so the UI can route both.

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'tweet'; id: string }
  | { type: 'wiki'; path: string };

const TWEET_RE = /\[\^(\d{6,25})\]/g;
const WIKI_RE = /\[\[([^\]]+?)\]\]/g;

export function parseCitations(text: string): Segment[] {
  if (!text) return [];

  // Find every match across both regexes, build a single sorted insertion list,
  // then walk the text inserting text + citation segments.
  type Match = { start: number; end: number; segment: Exclude<Segment, { type: 'text' }> };
  const matches: Match[] = [];
  for (const m of text.matchAll(TWEET_RE)) {
    if (m.index === undefined) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      segment: { type: 'tweet', id: m[1]! },
    });
  }
  for (const m of text.matchAll(WIKI_RE)) {
    if (m.index === undefined) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      segment: { type: 'wiki', path: m[1]!.trim() },
    });
  }
  matches.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlapping; first wins
    if (m.start > cursor) {
      out.push({ type: 'text', value: text.slice(cursor, m.start) });
    }
    out.push(m.segment);
    cursor = m.end;
  }
  if (cursor < text.length) {
    out.push({ type: 'text', value: text.slice(cursor) });
  }
  return out;
}

export function extractTweetIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(TWEET_RE)) ids.push(m[1]!);
  return ids;
}

export function extractWikiPaths(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(WIKI_RE)) paths.push(m[1]!.trim());
  return paths;
}
