// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildCitationIndex, orderedTweetCitations, sourceDomId } from '../components/chat/citationContext';
import { summarizeInput, summarizeOutput, toolLabel } from '../components/chat/ToolSteps';
import { buildSuggestions } from '../components/chat/EmptyChatState';
import { phaseLabel } from '../components/chat/ConversationView';
import { usePopupChat } from '../state/popupChatStore';

describe('citation numbering', () => {
  it('numbers tweet citations by first appearance and dedupes repeats', () => {
    const text = 'A [^1111111111] then B [^2222222222], A again [^1111111111], C [^3333333333].';
    expect(orderedTweetCitations(text)).toEqual(['1111111111', '2222222222', '3333333333']);
    const idx = buildCitationIndex('m1', text);
    expect(idx.numbers.get('1111111111')).toBe(1);
    expect(idx.numbers.get('2222222222')).toBe(2);
    expect(idx.numbers.get('3333333333')).toBe(3);
    expect(sourceDomId(idx.scope, '2222222222')).toBe('chat-src-m1-2222222222');
  });

  it('ignores wiki links and short numeric brackets', () => {
    expect(orderedTweetCitations('see [[concepts/agents]] and [^12345]')).toEqual([]);
  });
});

describe('tool step summaries', () => {
  it('describes a search call by query, filters, and hit count', () => {
    expect(summarizeInput('search_tweets', { query: 'agent memory', authors: ['ada_fieldstone'], k: 20 })).toBe(
      '“agent memory” · @ada_fieldstone',
    );
    expect(summarizeOutput('search_tweets', { hits: [{}, {}, {}], applied_filters: {} })).toBe('3 hits');
  });

  it('describes counts, periods, ids, and errors', () => {
    expect(summarizeInput('count_tweets', { tickers: ['NVDA'], from_date: '2025-01', by_category: true })).toBe(
      '$NVDA · 2025-01 → … · by category',
    );
    expect(summarizeOutput('count_tweets', { count: 1234, filters_applied: {} })).toBe('1,234 tweets');
    expect(summarizeInput('tweets_in_period', { start: '2025-Q1', end: '2025-Q2' })).toBe('2025-Q1 → 2025-Q2');
    expect(summarizeOutput('tweets_in_period', [{}, {}])).toBe('2 tweets');
    expect(summarizeOutput('top_authors', [{}])).toBe('1 authors');
    expect(summarizeInput('get_tweet_by_id', { id: '99' })).toBe('99');
    expect(summarizeOutput('get_tweet_by_id', { id: '99', handle: '@alice' })).toBe('@alice');
    expect(summarizeOutput('read_wiki_page', { error: 'wiki_unreachable' })).toBe('error: wiki_unreachable');
    expect(toolLabel('search_wiki')).toBe('Searched the wiki');
    expect(toolLabel('unknown_tool')).toBe('unknown_tool');
  });
});

describe('starter suggestions', () => {
  it('builds prompts from the top authors and categories, then pads with defaults', () => {
    const out = buildSuggestions([{ handle: '@alice' }, { handle: 'bob' }], [{ name: 'AI > Agents' }], 5);
    expect(out[0]).toContain('@alice');
    expect(out[1]).toContain('AI > Agents');
    expect(out[2]).toContain('@alice and @bob');
    expect(out).toHaveLength(5);
  });

  it('falls back to defaults when the archive is empty', () => {
    const out = buildSuggestions([], [], 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/through-lines/);
  });
});

describe('phase labels', () => {
  it('maps every phase to a human sentence', () => {
    expect(phaseLabel({ kind: 'embedding' })).toMatch(/Embedding/);
    expect(phaseLabel({ kind: 'searching' })).toMatch(/Searching/);
    expect(phaseLabel({ kind: 'thinking', round: 1 })).toBe('Thinking…');
    expect(phaseLabel({ kind: 'thinking', round: 3 })).toBe('Thinking (round 3)…');
    expect(phaseLabel({ kind: 'reasoning', round: 1 })).toBe('Reasoning…');
    expect(phaseLabel({ kind: 'tool', name: 'search_tweets', round: 2 })).toBe('Searched tweets…');
    expect(phaseLabel({ kind: 'writing' })).toBe('Writing…');
  });
});

// Regression: "ask the agent about this tweet" from inside /chat used to open
// the floating popup on top of the conversation the reader was already in.
// Handing a prompt to the route must never leave the popup open, and asking the
// same thing twice must still read as a fresh request.
describe('chat surfaces', () => {
  it('hands a prompt to the route instead of opening the popup', () => {
    const store = usePopupChat.getState();
    store.show('what about this one?');
    expect(usePopupChat.getState().open).toBe(true);

    usePopupChat.getState().handToRoute('what about this one?');
    const after = usePopupChat.getState();
    expect(after.open).toBe(false);
    expect(after.initialPrompt).toBeUndefined();
    expect(after.routePrompt?.text).toBe('what about this one?');

    const first = after.routePrompt?.nonce ?? 0;
    usePopupChat.getState().handToRoute('what about this one?');
    expect(usePopupChat.getState().routePrompt?.nonce).toBeGreaterThan(first);

    usePopupChat.getState().clearRoutePrompt();
    expect(usePopupChat.getState().routePrompt).toBeUndefined();
  });
});
