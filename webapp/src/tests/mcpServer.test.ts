// @vitest-environment node
//
// End-to-end test of the remote MCP server: the Python index builder turns a
// tiny fixture into SQL, Miniflare loads that SQL into a local D1, and the
// compiled Pages Function answers JSON-RPC over HTTP exactly as a client
// would see it. Runs the deployed artifact (wrangler pages functions build),
// not the TypeScript source.

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { parseLooseDate, toFtsQuery } from '../../functions/api/mcp';

const ROOT = resolve(__dirname, '../..');
const BUILD_DIR = resolve(ROOT, '.wrangler/test-fn-build-mcp');

const CATEGORIZED = {
  metadata: { total_tweets: 3 },
  taxonomy: { AI: ['Agents'], Markets: ['Macro'] },
  tweets: [
    {
      id: '1000000000000000001',
      author: 'Ada Fieldstone',
      handle: '@ada_fieldstone',
      text: 'Agent memory belongs in plain folders on disk. A context window forgets; a folder keeps.',
      timestamp: 'Mar 31, 2026',
      urls: [],
      tickers: [],
      media: { type: 'image', urls: ['https://pbs.twimg.com/media/a.jpg'] },
      is_article: false,
      article_title: null,
      categories: ['AI > Agents'],
      engagement: { like_count: 5000, retweet_count: 200 },
    },
    {
      id: '1000000000000000002',
      author: 'Macro Person',
      handle: '@macro',
      text: 'Rates and $NVDA: the whole market is one trade now.',
      timestamp: 'Jan 15, 2025',
      urls: ['https://example.com/rates'],
      tickers: ['$NVDA'],
      media: { type: 'none', urls: [] },
      is_article: null,
      article_title: null,
      categories: ['Markets > Macro'],
      engagement: { like_count: 120, retweet_count: 4 },
    },
    {
      id: '1000000000000000003',
      author: 'Ada Fieldstone',
      handle: '@ada_fieldstone',
      text: "Isn't it odd that memory ' quotes \" and unicode – survive?",
      timestamp: 'Jul 04, 2024',
      urls: [],
      tickers: [],
      media: { type: 'none', urls: [] },
      is_article: null,
      article_title: null,
      categories: ['AI > Agents', 'Other > Misc'],
      engagement: { like_count: 10, retweet_count: 0 },
    },
  ],
};

const ENRICHED = {
  metadata: {},
  embeddings: {},
  url_enrichments: [{ tweet_id: '1000000000000000002', source_ref: 'https://example.com/rates', content: 'Fed decision recap: inflation cooled.' }],
  image_enrichments: [{ tweet_id: '1000000000000000001', source_ref: 'https://pbs.twimg.com/media/a.jpg', content: 'A diagram of a filesystem tree labelled agent memory.' }],
};

const WIKI_PAGE = `---
last_updated_iso: 2026-05-01
---
# Ada Fieldstone

Recurring author on agent memory and small models.
`;

let mf: Miniflare;
let fullSql: string;

/** Split a .sql file into statements (';' outside single quotes) and run them. */
async function execSql(db: D1Database, sql: string): Promise<void> {
  const stmts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i++;
        } else inStr = false;
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
    } else if (ch === ';') {
      if (cur.trim()) stmts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) stmts.push(cur.trim());
  for (const st of stmts) await db.prepare(st).run();
}

async function rpc(method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  const res = await mf.dispatchFetch('http://app/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as Record<string, unknown>) };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  const result = (body as { result: { structuredContent?: unknown; isError: boolean; content: Array<{ text: string }> } }).result;
  return result;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trove-mcp-'));
  writeFileSync(join(dir, 'categorized.json'), JSON.stringify(CATEGORIZED));
  writeFileSync(join(dir, 'enriched.json'), JSON.stringify(ENRICHED));
  mkdirSync(join(dir, 'wiki', 'people'), { recursive: true });
  writeFileSync(join(dir, 'wiki', 'people', 'ada_fieldstone.md'), WIKI_PAGE);
  writeFileSync(join(dir, 'wiki', 'CLAUDE.md'), '# operator file, must be skipped');

  const script = resolve(ROOT, '..', 'scripts', 'build_mcp_d1.py');
  execFileSync('python3', [
    script,
    '--categorized', join(dir, 'categorized.json'),
    '--enriched', join(dir, 'enriched.json'),
    '--wiki', join(dir, 'wiki'),
    '--output', join(dir, 'full.sql'),
    '--full',
  ]);
  fullSql = readFileSync(join(dir, 'full.sql'), 'utf8');

  execFileSync('npx', ['wrangler', 'pages', 'functions', 'build', `--outdir=${BUILD_DIR}`], { cwd: ROOT, stdio: 'pipe' });
  mf = new Miniflare({
    modules: true,
    scriptPath: resolve(BUILD_DIR, 'index.js'),
    compatibilityDate: '2025-01-15',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'trove-test' },
    r2Buckets: { DATA_BUCKET: 'trove-data' },
    bindings: { ALLOW_UNAUTHENTICATED_DEV: 'true' },
  });
  const db = await mf.getD1Database('DB');
  await execSql(db, fullSql);
}, 180_000);

afterAll(async () => {
  await mf?.dispose();
});

describe('helpers', () => {
  it('quotes every keyword for FTS5 and keeps user phrases', () => {
    expect(toFtsQuery('agent memory')).toBe('"agent" "memory"');
    expect(toFtsQuery('"context window" nvda')).toBe('"context window" "nvda"');
    expect(toFtsQuery("isn't it (odd)")).toBe('"isn\'t" "it" "(odd)"');
  });
  it('parses loose dates as inclusive ranges', () => {
    expect(parseLooseDate('2025')).toBe(Date.UTC(2025, 0, 1) / 1000);
    expect(parseLooseDate('2025', true)).toBe(Date.UTC(2026, 0, 1) / 1000 - 1);
    expect(parseLooseDate('2025-Q2')).toBe(Date.UTC(2025, 3, 1) / 1000);
    expect(parseLooseDate('2025-Q4', true)).toBe(Date.UTC(2026, 0, 1) / 1000 - 1);
    expect(parseLooseDate('2026-03', true)).toBe(Date.UTC(2026, 3, 1) / 1000 - 1);
    expect(() => parseLooseDate('yesterday')).toThrow(/Cannot parse/);
  });
});

describe('/api/mcp (Streamable HTTP, stateless)', () => {
  it('handshakes: initialize, initialized notification, ping, tools/list', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.status).toBe(200);
    const r = init.body!.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } };
    expect(r.protocolVersion).toBe('2025-06-18');
    expect(r.serverInfo.name).toBe('trove-archive');
    expect(r.capabilities.tools).toBeTruthy();

    const notified = await mf.dispatchFetch('http://app/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notified.status).toBe(202);

    expect((await rpc('ping')).body!.result).toEqual({});
    const tools = (await rpc('tools/list')).body!.result as { tools: Array<{ name: string; inputSchema: unknown }> };
    expect(tools.tools.map((t) => t.name)).toEqual([
      'search_tweets', 'count_tweets', 'top_authors', 'tweets_in_period', 'get_tweet',
      'list_categories', 'archive_stats', 'list_wiki_pages', 'read_wiki_page', 'search_wiki',
    ]);
    expect((await rpc('nope')).body!.error).toMatchObject({ code: -32601 });
    expect((await mf.dispatchFetch('http://app/api/mcp')).status).toBe(405);
  });

  it('search_tweets ranks by FTS5, searches enrichment text, and relaxes to any-term', async () => {
    const r = await call('search_tweets', { query: 'agent memory' });
    expect(r.isError).toBe(false);
    const s = r.structuredContent as { count: number; tweets: Array<{ id: string; handle: string; url: string }>; matched_any_term: boolean };
    expect(s.count).toBe(1);
    expect(s.tweets[0]!.id).toBe('1000000000000000001');
    expect(s.tweets[0]!.handle).toBe('ada_fieldstone');
    expect(s.tweets[0]!.url).toBe('https://x.com/ada_fieldstone/status/1000000000000000001');
    expect(s.matched_any_term).toBe(false);

    // Text extracted from a linked page is searchable.
    const viaUrl = (await call('search_tweets', { query: 'inflation cooled' })).structuredContent as { tweets: Array<{ id: string }> };
    expect(viaUrl.tweets.map((t) => t.id)).toEqual(['1000000000000000002']);

    // No tweet has all three terms; the any-term fallback still finds the closest.
    const relaxed = (await call('search_tweets', { query: 'memory zebra quotes' })).structuredContent as { matched_any_term: boolean; count: number };
    expect(relaxed.matched_any_term).toBe(true);
    expect(relaxed.count).toBe(2);
  });

  it('applies author, category prefix, ticker, date, and min_likes filters', async () => {
    const byAuthor = (await call('search_tweets', { query: 'memory', authors: ['@Ada_Fieldstone'], order: 'newest' })).structuredContent as { count: number };
    expect(byAuthor.count).toBe(2);
    const byCat = (await call('count_tweets', { categories: ['AI'] })).structuredContent as { total: number };
    expect(byCat.total).toBe(2);
    const byTicker = (await call('count_tweets', { tickers: ['nvda'] })).structuredContent as { total: number };
    expect(byTicker.total).toBe(1);
    const byDate = (await call('count_tweets', { from: '2025', to: '2025-Q4' })).structuredContent as { total: number };
    expect(byDate.total).toBe(1);
    const byLikes = (await call('count_tweets', { min_likes: 100 })).structuredContent as { total: number };
    expect(byLikes.total).toBe(2);
    const grouped = (await call('count_tweets', { group_by: 'category' })).structuredContent as { groups: Array<{ key: string; count: number }> };
    expect(grouped.groups[0]).toEqual({ key: 'AI > Agents', count: 2 });
    const byYear = (await call('count_tweets', { group_by: 'year' })).structuredContent as { groups: Array<{ key: string; count: number }> };
    expect(byYear.groups.map((g) => g.key)).toEqual(['2024', '2025', '2026']);
  });

  it('top_authors, tweets_in_period, get_tweet, list_categories, archive_stats', async () => {
    const top = (await call('top_authors', {})).structuredContent as { authors: Array<{ handle: string; tweets: number }> };
    expect(top.authors[0]).toMatchObject({ handle: 'ada_fieldstone', tweets: 2 });

    const period = (await call('tweets_in_period', { from: '2024-01-01', to: '2025-12-31', order: 'likes' })).structuredContent as { total_in_period: number; tweets: Array<{ id: string }> };
    expect(period.total_in_period).toBe(2);
    expect(period.tweets[0]!.id).toBe('1000000000000000002');
    expect((await call('tweets_in_period', {})).isError).toBe(true);

    const one = (await call('get_tweet', { id: '1000000000000000003' })).structuredContent as { found: boolean; tweet: { text: string; categories: string[] } };
    expect(one.found).toBe(true);
    expect(one.tweet.text).toContain("' quotes \" and unicode –");
    expect(one.tweet.categories).toEqual(['AI > Agents', 'Other > Misc']);
    const full = (await call('get_tweet', { id: '1000000000000000001' })).structuredContent as { tweet: { extracted_content: string; media_urls: string[] } };
    expect(full.tweet.extracted_content).toContain('filesystem tree');
    expect(full.tweet.media_urls).toEqual(['https://pbs.twimg.com/media/a.jpg']);
    expect((await call('get_tweet', { id: '999999999999' })).structuredContent).toMatchObject({ found: false });
    expect((await call('get_tweet', { id: 'DROP TABLE' })).isError).toBe(true);

    const cats = (await call('list_categories')).structuredContent as { categories: Array<{ name: string; tweets: number }> };
    expect(cats.categories).toContainEqual({ name: 'AI > Agents', tweets: 2 });

    const stats = (await call('archive_stats')).structuredContent as { tweets: number; oldest: string; newest: string; index_pushed_at: string | null; wiki_pages: number };
    expect(stats).toMatchObject({ tweets: 3, oldest: '2024-07-04', newest: '2026-03-31', wiki_pages: 1 });
    expect(stats.index_pushed_at).toMatch(/^\d{4}-/);
  });

  it('serves the wiki and skips operator files', async () => {
    const pages = (await call('list_wiki_pages')).structuredContent as { pages: Array<{ path: string; updated: string }> };
    expect(pages.pages).toEqual([{ path: 'people/ada_fieldstone', title: 'Ada Fieldstone', updated: '2026-05-01', chars: expect.any(Number) }]);
    const page = (await call('read_wiki_page', { path: 'people/ada_fieldstone.md' })).structuredContent as { found: boolean; content: string };
    expect(page.found).toBe(true);
    expect(page.content).toContain('small models');
    const hits = (await call('search_wiki', { query: 'SMALL models' })).structuredContent as { results: Array<{ path: string }> };
    expect(hits.results.map((h) => h.path)).toEqual(['people/ada_fieldstone']);
  });

  it('incremental build only rewrites changed tweets and removes deleted ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trove-mcp-inc-'));
    const changed = structuredClone(CATEGORIZED) as typeof CATEGORIZED;
    changed.tweets = changed.tweets.filter((t) => t.id !== '1000000000000000003');
    changed.tweets[0]!.engagement.like_count = 9999; // changed row
    writeFileSync(join(dir, 'categorized.json'), JSON.stringify(changed));
    writeFileSync(join(dir, 'enriched.json'), JSON.stringify(ENRICHED));
    const db = await mf.getD1Database('DB');
    const existing = await db.prepare('SELECT id, h FROM mcp_tweets').all();
    writeFileSync(join(dir, 'existing.json'), JSON.stringify([{ results: existing.results }]));
    execFileSync('python3', [
      resolve(ROOT, '..', 'scripts', 'build_mcp_d1.py'),
      '--categorized', join(dir, 'categorized.json'),
      '--enriched', join(dir, 'enriched.json'),
      '--output', join(dir, 'inc.sql'),
      '--existing', join(dir, 'existing.json'),
      '--summary-json', join(dir, 'summary.json'),
    ]);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as { mode: string; written: number; deleted: number };
    expect(summary).toMatchObject({ mode: 'incremental', written: 1, deleted: 1 });
    const sql = readFileSync(join(dir, 'inc.sql'), 'utf8');
    expect(sql).not.toContain('DROP TABLE');
    await execSql(db, sql);

    const stats = (await call('archive_stats')).structuredContent as { tweets: number };
    expect(stats.tweets).toBe(2);
    const one = (await call('get_tweet', { id: '1000000000000000001' })).structuredContent as { tweet: { likes: number } };
    expect(one.tweet.likes).toBe(9999);
    // FTS must not hold a stale copy of the rewritten or removed tweet.
    const s = (await call('search_tweets', { query: 'memory' })).structuredContent as { count: number };
    expect(s.count).toBe(1);
  });
});
