import { describe, it, expect } from 'vitest';
import {
  parseCitations,
  extractTweetIds,
  extractWikiPaths,
} from '../chat/citationParser';

describe('parseCitations', () => {
  it('returns plain text when no citations are present', () => {
    expect(parseCitations('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('parses a single tweet citation', () => {
    const out = parseCitations('See [^1234567890] for details.');
    expect(out).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'tweet', id: '1234567890' },
      { type: 'text', value: ' for details.' },
    ]);
  });

  it('parses adjacent tweet citations', () => {
    const out = parseCitations('Both [^1234567890][^9876543210] argue X.');
    expect(out).toEqual([
      { type: 'text', value: 'Both ' },
      { type: 'tweet', id: '1234567890' },
      { type: 'tweet', id: '9876543210' },
      { type: 'text', value: ' argue X.' },
    ]);
  });

  it('parses interleaved tweet + wiki citations', () => {
    const out = parseCitations(
      "Juno's view [^1234567890] is captured in [[concepts/ai-agents]].",
    );
    expect(out).toEqual([
      { type: 'text', value: "Juno's view " },
      { type: 'tweet', id: '1234567890' },
      { type: 'text', value: ' is captured in ' },
      { type: 'wiki', path: 'concepts/ai-agents' },
      { type: 'text', value: '.' },
    ]);
  });

  it('rejects tweet ids that are too short', () => {
    const out = parseCitations('not a citation [^123].');
    expect(out).toEqual([{ type: 'text', value: 'not a citation [^123].' }]);
  });

  it('handles wiki paths with dashes and slashes', () => {
    const out = parseCitations('See [[entities/jhalvorsen.md]] and [[concepts/llm-scaling]]');
    expect(out).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'wiki', path: 'entities/jhalvorsen.md' },
      { type: 'text', value: ' and ' },
      { type: 'wiki', path: 'concepts/llm-scaling' },
    ]);
  });
});

describe('extractTweetIds / extractWikiPaths', () => {
  it('finds every id and path in order', () => {
    const text = 'See [^1234567890] vs [^9876543210], synthesized in [[concepts/ai]] and [[entities/jhalvorsen]].';
    expect(extractTweetIds(text)).toEqual(['1234567890', '9876543210']);
    expect(extractWikiPaths(text)).toEqual(['concepts/ai', 'entities/jhalvorsen']);
  });
});
