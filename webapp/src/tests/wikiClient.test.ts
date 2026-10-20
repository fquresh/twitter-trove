// Regression: read_wiki_page surfaced "error: wiki_http_404" for model-style
// paths ("people/jhalvorsen.md", "wiki/people/jhalvorsen") and for pages that do not exist.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeWikiClient, normalizeWikiPath } from '../chat/wikiClient';
import { summarizeOutput } from '../components/chat/ToolSteps';
import { useChatStore } from '../state/chatStore';

afterEach(() => vi.unstubAllGlobals());

// Mirrors wiki_server._safe_path: only `<category>/<slug>` with [a-z0-9._-] is a hit.
function stubServer(pages: string[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const path = new URL(url).searchParams.get('path') ?? '';
    if (pages.includes(path)) return new Response(JSON.stringify({ path, body_markdown: 'x' }), { status: 200 });
    return new Response('nope', { status: 404 });
  });
  return calls;
}

describe('normalizeWikiPath', () => {
  it('strips .md, wiki/ prefix, [[ ]], slashes, case and spaces', () => {
    expect(normalizeWikiPath('people/jhalvorsen')).toBe('people/jhalvorsen');
    expect(normalizeWikiPath('people/jhalvorsen.md')).toBe('people/jhalvorsen');
    expect(normalizeWikiPath('wiki/people/jhalvorsen.md')).toBe('people/jhalvorsen');
    expect(normalizeWikiPath('/people/Jhalvorsen/')).toBe('people/jhalvorsen');
    expect(normalizeWikiPath('[[concepts/Agentic Search]]')).toBe('concepts/agentic-search');
  });
});

describe('wiki client read', () => {
  it('succeeds for model-style variants of an existing page', async () => {
    const calls = stubServer(['people/jhalvorsen']);
    const c = makeWikiClient('http://x');
    for (const p of ['people/jhalvorsen.md', 'wiki/people/jhalvorsen', 'People/Jhalvorsen']) {
      expect(await c.read({ path: p })).toMatchObject({ path: 'people/jhalvorsen' });
    }
    expect(calls.every((u) => u.endsWith('path=people%2Fjhalvorsen'))).toBe(true);
  });

  it('returns a non-error not-found result for a missing page', async () => {
    stubServer([]);
    const out = await makeWikiClient('http://x').read({ path: 'people/nobody' });
    expect(out).toMatchObject({ found: false, path: 'people/nobody' });
    expect(out).not.toHaveProperty('error');
    expect(summarizeOutput('read_wiki_page', out)).toBe('not found');
  });

  it('still reports other HTTP failures and network errors as errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('x', { status: 500 }));
    expect(await makeWikiClient('http://x').read({ path: 'people/jhalvorsen' })).toEqual({ error: 'wiki_http_500' });
    vi.stubGlobal('fetch', async () => {
      throw new Error('down');
    });
    expect(await makeWikiClient('http://x').read({ path: 'people/jhalvorsen' })).toEqual({ error: 'wiki_unreachable' });
  });
});

describe('wiki client auth', () => {
  afterEach(() => useChatStore.getState().setWikiToken(''));

  it('sends the local server token on wiki routes but not on /health', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('Authorization') });
      return new Response('{}', { status: 200 });
    });
    useChatStore.getState().setWikiToken('dummy-local-token');
    const c = makeWikiClient('http://x');
    await c.search({ query: 'agent memory' });
    await c.list({});
    await c.read({ path: 'people/jhalvorsen' });
    await c.health();
    expect(seen.slice(0, 3).every((s) => s.auth === 'Bearer dummy-local-token')).toBe(true);
    expect(seen[3]).toEqual({ url: 'http://x/health', auth: null });
  });
});
