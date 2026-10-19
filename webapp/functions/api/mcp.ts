// /api/mcp - remote MCP server over the saved-tweet archive.
//
// Transport: MCP "Streamable HTTP" in stateless mode. Every JSON-RPC request
// arrives as a POST and gets a JSON response; there is no session id and no
// server-initiated SSE stream, which is all a read-only tool server needs.
// Any MCP client that speaks HTTP (Claude Code, Claude Desktop, Cursor, Hermes
// Agent, mcp-remote) can connect.
//
// Data: the `mcp_*` tables in D1, loaded by `./trove deploy` from
// scripts/build_mcp_d1.py. Keyword search is FTS5 (bm25); there is no vector
// search here (D1 holds no embeddings), so semantic queries should use
// several phrasings via the tool's `query` argument.
//
// Auth: the same Cloudflare Access gate as every other /api/* route. Browsers
// carry the Access cookie; MCP clients send a CF Access *service token* as
// `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, which Access
// exchanges for the JWT that _auth.ts verifies.

import { verifyAccess, denyResponse, type Env } from './_auth';
import { rejectOversizedBody, rateLimit } from './_guard';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'trove-archive', version: '1.0.0' };
const MAX_BODY_BYTES = 65_536;
const RATE_LIMIT = 300;
const RATE_WINDOW_SEC = 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TEXT_MAX = 1200;

// ---------- JSON-RPC plumbing ----------

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id: RpcRequest['id'], code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

class ToolError extends Error {}

// ---------- Tool definitions ----------

const FILTER_PROPS = {
  authors: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only tweets by these handles (with or without @).',
  },
  categories: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Only tweets in these categories. Exact names like "AI > Agents", or a prefix like "AI" to match every AI subcategory.',
  },
  tickers: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only tweets that mention these tickers, e.g. ["NVDA", "BTC"].',
  },
  from: { type: 'string', description: 'Start date: YYYY, YYYY-MM, YYYY-MM-DD, or YYYY-Qn.' },
  to: { type: 'string', description: 'End date (inclusive): same formats as `from`.' },
  min_likes: { type: 'integer', description: 'Only tweets with at least this many likes.' },
} as const;

const LIMIT_PROP = {
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
} as const;

export const TOOLS = [
  {
    name: 'search_tweets',
    description:
      "Full-text search over the user's saved tweets (text, author handle, article titles, and the extracted text of linked pages and images). Ranked by relevance. Use short keyword queries; try two or three phrasings for a concept. Returns tweet ids you can cite and pass to get_tweet.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords. All terms must match; quotes force a phrase.' },
        ...FILTER_PROPS,
        ...LIMIT_PROP,
        order: {
          type: 'string',
          enum: ['relevance', 'newest', 'likes'],
          default: 'relevance',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'count_tweets',
    description:
      'Count saved tweets matching filters, optionally grouped by category, author, ticker, year, or month. Good for "how much of my reading is X" and for trends over time.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword filter (same syntax as search_tweets).' },
        ...FILTER_PROPS,
        group_by: { type: 'string', enum: ['none', 'category', 'author', 'ticker', 'year', 'month'], default: 'none' },
        ...LIMIT_PROP,
      },
    },
  },
  {
    name: 'top_authors',
    description: 'The most-liked authors within a slice of the archive: tweet count and average likes per author.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, ...FILTER_PROPS, ...LIMIT_PROP },
    },
  },
  {
    name: 'tweets_in_period',
    description: 'List saved tweets in a date range, newest first or by likes. Use for "what did I save in March" style questions.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTER_PROPS,
        order: { type: 'string', enum: ['newest', 'oldest', 'likes'], default: 'newest' },
        ...LIMIT_PROP,
      },
      required: ['from'],
    },
  },
  {
    name: 'get_tweet',
    description: 'One tweet in full: text, author, date, engagement, categories, tickers, links, media, and the extracted text of linked pages and images.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The numeric tweet id.' } },
      required: ['id'],
    },
  },
  {
    name: 'list_categories',
    description: 'Every category in the archive with its tweet count. Call this first when you need exact category names for filters.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'archive_stats',
    description: 'Size and freshness of the archive: tweet count, date range, when the index was last pushed, wiki page count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_wiki_pages',
    description: "The user's wiki: LLM-maintained synthesis pages about recurring people, concepts, and tickers. Read these before raw tweets for 'what do I think about X' questions.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_wiki_page',
    description: 'Read one wiki page as markdown. Paths come from list_wiki_pages, e.g. "people/jhalvorsen".',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'search_wiki',
    description: 'Case-insensitive substring search across wiki pages. Returns matching paths with a snippet.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...LIMIT_PROP }, required: ['query'] },
  },
] as const;

// ---------- Query helpers ----------

interface TweetRow {
  id: string;
  handle: string;
  author: string | null;
  text: string;
  created_at: number;
  like_count: number;
  retweet_count: number;
  is_article: number | null;
  article_title: string | null;
  categories: string;
  tickers: string;
  urls: string;
  media_type: string | null;
  media_urls: string;
  enrichment: string | null;
}

function iso(sec: number): string {
  return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '';
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function presentTweet(r: TweetRow, full = false) {
  const clean = r.handle.replace(/^@/, '');
  return {
    id: r.id,
    handle: clean,
    author: r.author,
    date: iso(r.created_at),
    likes: r.like_count,
    retweets: r.retweet_count,
    text: full ? r.text : truncate(r.text, TEXT_MAX),
    url: `https://x.com/${clean}/status/${r.id}`,
    ...(r.is_article === 1 ? { article_title: r.article_title } : {}),
    categories: parseJson<string[]>(r.categories, []),
    tickers: parseJson<string[]>(r.tickers, []),
    ...(full
      ? {
          links: parseJson<string[]>(r.urls, []),
          media_type: r.media_type,
          media_urls: parseJson<string[]>(r.media_urls, []),
          extracted_content: r.enrichment,
        }
      : r.media_type && r.media_type !== 'none'
        ? { media_type: r.media_type }
        : {}),
  };
}

/** Parse a loose date. `end` moves it to the last second of its period. */
export function parseLooseDate(s: string, end = false): number {
  const v = s.trim();
  let m: RegExpMatchArray | null;
  const utc = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / 1000;
  if ((m = v.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return end ? utc(y + 1, 1, 1) - 1 : utc(y, 1, 1);
  }
  if ((m = v.match(/^(\d{4})-Q([1-4])$/i))) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const startMonth = (q - 1) * 3 + 1;
    return end ? utc(y, startMonth + 3, 1) - 1 : utc(y, startMonth, 1);
  }
  if ((m = v.match(/^(\d{4})-(\d{2})$/))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return end ? utc(y, mo + 1, 1) - 1 : utc(y, mo, 1);
  }
  if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})/))) {
    const t = utc(Number(m[1]), Number(m[2]), Number(m[3]));
    return end ? t + 86_399 : t;
  }
  throw new ToolError(`Cannot parse date "${s}". Use YYYY, YYYY-MM, YYYY-MM-DD, or YYYY-Qn.`);
}

/** FTS5 query from user keywords: each term quoted (so punctuation is safe),
 *  joined by implicit AND. User-supplied "phrases" stay phrases. */
export function toFtsQuery(q: string): string {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const term = (m[1] ?? m[2] ?? '').replace(/"/g, '').trim();
    if (!term) continue;
    out.push(`"${term}"`);
  }
  return out.join(' ');
}

interface Filters {
  authors?: string[];
  categories?: string[];
  tickers?: string[];
  from?: string;
  to?: string;
  min_likes?: number;
  query?: string;
}

interface Built {
  joinSql: string;
  whereSql: string;
  params: unknown[];
  usesFts: boolean;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function buildFilters(f: Filters, ftsQuery: string | null): Built {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  let joinSql = '';
  let usesFts = false;
  if (ftsQuery) {
    usesFts = true;
    joinSql += ' JOIN mcp_tweets_fts f ON f.id = t.id';
    where.push('mcp_tweets_fts MATCH ?');
    params.push(ftsQuery);
  }
  const authors = strList(f.authors).map((a) => a.replace(/^@/, '').toLowerCase());
  if (authors.length) {
    where.push(`lower(t.handle) IN (${authors.map(() => '?').join(',')})`);
    params.push(...authors);
  }
  const cats = strList(f.categories);
  if (cats.length) {
    const clauses = cats.map(() => '(c.category = ? OR c.category LIKE ?)');
    where.push(`t.id IN (SELECT c.tweet_id FROM mcp_tweet_categories c WHERE ${clauses.join(' OR ')})`);
    for (const c of cats) params.push(c, `${c} > %`);
  }
  const tickers = strList(f.tickers).map((t) => t.replace(/^\$/, '').toUpperCase());
  if (tickers.length) {
    where.push(`t.id IN (SELECT k.tweet_id FROM mcp_tweet_tickers k WHERE k.ticker IN (${tickers.map(() => '?').join(',')}))`);
    params.push(...tickers);
  }
  if (typeof f.from === 'string' && f.from.trim()) {
    where.push('t.created_at >= ?');
    params.push(parseLooseDate(f.from));
  }
  if (typeof f.to === 'string' && f.to.trim()) {
    where.push('t.created_at <= ?');
    params.push(parseLooseDate(f.to, true));
  }
  if (typeof f.min_likes === 'number' && f.min_likes > 0) {
    where.push('t.like_count >= ?');
    params.push(Math.floor(f.min_likes));
  }
  return { joinSql, whereSql: where.join(' AND '), params, usesFts };
}

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

async function all<T>(db: D1Database, sql: string, params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

// ---------- Tool implementations ----------

async function searchTweets(db: D1Database, a: Record<string, unknown>) {
  const raw = String(a.query ?? '').trim();
  if (!raw) throw new ToolError('query is required');
  const limit = clampLimit(a.limit);
  const order = a.order === 'newest' ? 't.created_at DESC' : a.order === 'likes' ? 't.like_count DESC' : 'bm25(mcp_tweets_fts)';
  const runWith = async (fts: string) => {
    const b = buildFilters(a as Filters, fts);
    return all<TweetRow>(
      db,
      `SELECT t.* FROM mcp_tweets t${b.joinSql} WHERE ${b.whereSql} ORDER BY ${order} LIMIT ?`,
      [...b.params, limit],
    );
  };
  let rows = await runWith(toFtsQuery(raw));
  let relaxed = false;
  if (rows.length === 0) {
    // All-terms match failed; fall back to any-term so a long query still
    // returns the closest tweets instead of nothing.
    const anyTerm = toFtsQuery(raw).split(' ').join(' OR ');
    if (anyTerm.includes(' OR ')) {
      rows = await runWith(anyTerm);
      relaxed = rows.length > 0;
    }
  }
  return { query: raw, matched_any_term: relaxed, count: rows.length, tweets: rows.map((r) => presentTweet(r)) };
}

async function countTweets(db: D1Database, a: Record<string, unknown>) {
  const q = typeof a.query === 'string' && a.query.trim() ? toFtsQuery(a.query) : null;
  const b = buildFilters(a as Filters, q);
  const group = String(a.group_by ?? 'none');
  const limit = clampLimit(a.limit ?? MAX_LIMIT);
  // Extra joins must precede WHERE: from(joinSql) builds the FROM clause.
  const from = (extraJoin = '') => `FROM mcp_tweets t${b.joinSql}${extraJoin} WHERE ${b.whereSql}`;
  const total = (await all<{ n: number }>(db, `SELECT COUNT(*) AS n ${from()}`, b.params))[0]?.n ?? 0;
  let groups: Array<{ key: string; count: number }> = [];
  if (group === 'category') {
    groups = await all(
      db,
      `SELECT c.category AS key, COUNT(DISTINCT t.id) AS count ${from(' JOIN mcp_tweet_categories c ON c.tweet_id = t.id')} GROUP BY c.category ORDER BY count DESC LIMIT ?`,
      [...b.params, limit],
    );
  } else if (group === 'author') {
    groups = await all(db, `SELECT t.handle AS key, COUNT(*) AS count ${from()} GROUP BY t.handle ORDER BY count DESC LIMIT ?`, [...b.params, limit]);
  } else if (group === 'ticker') {
    groups = await all(
      db,
      `SELECT k.ticker AS key, COUNT(DISTINCT t.id) AS count ${from(' JOIN mcp_tweet_tickers k ON k.tweet_id = t.id')} GROUP BY k.ticker ORDER BY count DESC LIMIT ?`,
      [...b.params, limit],
    );
  } else if (group === 'year' || group === 'month') {
    const fmt = group === 'year' ? '%Y' : '%Y-%m';
    groups = await all(
      db,
      `SELECT strftime('${fmt}', t.created_at, 'unixepoch') AS key, COUNT(*) AS count ${from()} GROUP BY key ORDER BY key ASC LIMIT ?`,
      [...b.params, Math.max(limit, MAX_LIMIT)],
    );
  }
  return { total, group_by: group, groups };
}

async function topAuthors(db: D1Database, a: Record<string, unknown>) {
  const q = typeof a.query === 'string' && a.query.trim() ? toFtsQuery(a.query) : null;
  const b = buildFilters(a as Filters, q);
  const limit = clampLimit(a.limit ?? 15);
  const rows = await all<{ handle: string; author: string | null; n: number; avg_likes: number; latest: number }>(
    db,
    `SELECT t.handle, MAX(t.author) AS author, COUNT(*) AS n, ROUND(AVG(t.like_count)) AS avg_likes, MAX(t.created_at) AS latest
     FROM mcp_tweets t${b.joinSql} WHERE ${b.whereSql}
     GROUP BY t.handle ORDER BY n DESC, avg_likes DESC LIMIT ?`,
    [...b.params, limit],
  );
  return {
    authors: rows.map((r) => ({ handle: r.handle, author: r.author, tweets: r.n, avg_likes: r.avg_likes, latest: iso(r.latest) })),
  };
}

async function tweetsInPeriod(db: D1Database, a: Record<string, unknown>) {
  if (typeof a.from !== 'string' || !a.from.trim()) throw new ToolError('from is required');
  const b = buildFilters(a as Filters, null);
  const limit = clampLimit(a.limit);
  const order = a.order === 'likes' ? 't.like_count DESC' : a.order === 'oldest' ? 't.created_at ASC' : 't.created_at DESC';
  const total = (await all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM mcp_tweets t WHERE ${b.whereSql}`, b.params))[0]?.n ?? 0;
  const rows = await all<TweetRow>(db, `SELECT t.* FROM mcp_tweets t WHERE ${b.whereSql} ORDER BY ${order} LIMIT ?`, [...b.params, limit]);
  return { total_in_period: total, returned: rows.length, tweets: rows.map((r) => presentTweet(r)) };
}

async function getTweet(db: D1Database, a: Record<string, unknown>) {
  const id = String(a.id ?? '').trim();
  if (!/^\d{6,25}$/.test(id)) throw new ToolError('id must be the numeric tweet id');
  const row = (await all<TweetRow>(db, 'SELECT * FROM mcp_tweets WHERE id = ?', [id]))[0];
  if (!row) return { found: false, id, url: `https://x.com/i/web/status/${id}` };
  return { found: true, tweet: presentTweet(row, true) };
}

async function listCategories(db: D1Database) {
  const rows = await all<{ category: string; n: number }>(
    db,
    'SELECT category, COUNT(*) AS n FROM mcp_tweet_categories GROUP BY category ORDER BY n DESC',
    [],
  );
  return { categories: rows.map((r) => ({ name: r.category, tweets: r.n })) };
}

async function archiveStats(db: D1Database) {
  const meta = await all<{ key: string; value: string }>(db, 'SELECT key, value FROM mcp_meta', []);
  const m: Record<string, unknown> = {};
  for (const r of meta) m[r.key] = parseJson(r.value, r.value);
  const range = (await all<{ lo: number; hi: number; n: number }>(db, 'SELECT MIN(created_at) AS lo, MAX(created_at) AS hi, COUNT(*) AS n FROM mcp_tweets', []))[0];
  return {
    tweets: range?.n ?? 0,
    oldest: iso(range?.lo ?? 0),
    newest: iso(range?.hi ?? 0),
    index_pushed_at: typeof m.pushed_at === 'number' ? new Date(m.pushed_at * 1000).toISOString() : null,
    wiki_pages: m.wiki_pages ?? 0,
    search: 'FTS5 keyword search (bm25). No vector search on this endpoint.',
  };
}

async function listWikiPages(db: D1Database) {
  const rows = await all<{ path: string; title: string | null; updated_at: number | null; len: number }>(
    db,
    'SELECT path, title, updated_at, length(content) AS len FROM mcp_wiki ORDER BY path',
    [],
  );
  return { pages: rows.map((r) => ({ path: r.path, title: r.title, updated: iso(r.updated_at ?? 0), chars: r.len })) };
}

async function readWikiPage(db: D1Database, a: Record<string, unknown>) {
  const path = String(a.path ?? '').trim().replace(/\.md$/, '');
  if (!path) throw new ToolError('path is required');
  const row = (await all<{ path: string; title: string | null; content: string; updated_at: number | null }>(db, 'SELECT * FROM mcp_wiki WHERE path = ?', [path]))[0];
  if (!row) return { found: false, path };
  return { found: true, path: row.path, title: row.title, updated: iso(row.updated_at ?? 0), content: row.content };
}

async function searchWiki(db: D1Database, a: Record<string, unknown>) {
  const q = String(a.query ?? '').trim();
  if (!q) throw new ToolError('query is required');
  const limit = clampLimit(a.limit ?? 10);
  const rows = await all<{ path: string; title: string | null; content: string }>(
    db,
    'SELECT path, title, content FROM mcp_wiki WHERE lower(content) LIKE ? OR lower(title) LIKE ? LIMIT ?',
    [`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, limit],
  );
  return {
    results: rows.map((r) => {
      const i = r.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, i - 160);
      return { path: r.path, title: r.title, snippet: r.content.slice(start, start + 400) };
    }),
  };
}

export async function callTool(db: D1Database, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_tweets':
      return searchTweets(db, args);
    case 'count_tweets':
      return countTweets(db, args);
    case 'top_authors':
      return topAuthors(db, args);
    case 'tweets_in_period':
      return tweetsInPeriod(db, args);
    case 'get_tweet':
      return getTweet(db, args);
    case 'list_categories':
      return listCategories(db);
    case 'archive_stats':
      return archiveStats(db);
    case 'list_wiki_pages':
      return listWikiPages(db);
    case 'read_wiki_page':
      return readWikiPage(db, args);
    case 'search_wiki':
      return searchWiki(db, args);
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// ---------- Request handling ----------

async function handleRpc(db: D1Database, req: RpcRequest): Promise<unknown | null> {
  const { id, method, params = {} } = req;
  const isNotification = id === undefined;
  switch (method) {
    case 'initialize': {
      const asked = String((params as { protocolVersion?: string }).protocolVersion ?? '');
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only tools over the user's archive of saved X/Twitter posts. Start with archive_stats or list_categories to learn the shape, then search_tweets with short keyword queries. Cite tweets by id or url.",
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      const name = String(p.name ?? '');
      try {
        const result = await callTool(db, name, p.arguments ?? {});
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 1) }],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : `tool failed: ${(e as Error).message}`;
        return rpcResult(id, { content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await verifyAccess(request, env);
  if (!auth.ok) return denyResponse(auth);
  if (!env.DB) return json({ error: 'server_misconfigured', reason: 'D1 binding DB missing' }, 500);

  const tooBig = rejectOversizedBody(request, MAX_BODY_BYTES);
  if (tooBig) return tooBig;
  const limited = await rateLimit(env, auth.sub || auth.email || 'unknown', RATE_LIMIT, RATE_WINDOW_SEC);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const item of batch) {
    if (!item || typeof item !== 'object' || typeof (item as RpcRequest).method !== 'string') {
      responses.push(rpcError(null, -32600, 'Invalid Request'));
      continue;
    }
    const out = await handleRpc(env.DB, item as RpcRequest);
    if (out !== null) responses.push(out);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
};

// Stateless server: no SSE stream to open, nothing to delete.
export const onRequestGet: PagesFunction<Env> = async () => json({ error: 'method_not_allowed', hint: 'POST JSON-RPC to this URL' }, 405);
export const onRequestDelete: PagesFunction<Env> = async () => new Response(null, { status: 405 });
