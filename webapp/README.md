# Trove web app

The React and TypeScript app for Trove.
It browses, searches, charts, and chats over a collection of X posts.
The collection lives in your browser (SQLite through [sql.js](https://sql.js.org), saved to IndexedDB).
Read the [root README](../README.md) for the product overview.
Read [docs/architecture.md](../docs/architecture.md) for the system design and the chat flow.
Read [docs/deployment.md](../docs/deployment.md) for the cloud app in `functions/`.

> Chat uses DeepSeek (default model `deepseek-v4-flash`).
> Read the [MCP server guide](../docs/mcp-server.md) for the remote MCP endpoint.

## Quick start

The easiest path is `./trove go` from the project root - it boots this
webapp + the wiki server, opens a browser, and (by default) refreshes the
pipeline data first.

For dev work on the webapp alone:

```bash
npm install                 # postinstall copies sql-wasm{,-browser}.wasm into public/
npm run seed                # generates ~5000 synthetic tweets in public/seed/
npm run dev                 # http://127.0.0.1:5174  (port 5174, not 5173)
```

In a fresh browser, open the app, go to **Import**, and drag-drop:

- one or more `.html` exports from the Chrome extension (or the seed's
  `public/seed/tweets.html`), and
- (optional) the classifier's `categorized_tweets.json` and
  `enriched_tweets.json`.

Or, with `wiki_server.py` running on `:8765`, click the **⟳** button in
the top nav and the webapp will pull all three from disk in one shot.

Imports are idempotent: re-uploading the same file updates engagement
counts but leaves your favorites, notes, and manual category assignments
intact.

## Repo layout

```
webapp/
├── README.md                     ← you are here
├── package.json                  ← deps + scripts (dev, build, test, seed, perf)
├── tsconfig.json                 ← strict TS, "@/" alias → src/
├── vite.config.ts                ← Vite + Vitest config (see "vitest type quirk")
├── tailwind.config.js            ← ink + accent palette (midnight/cyan)
├── postcss.config.js
├── playwright.config.ts          ← single chromium project, reuses dev server
├── index.html                    ← entry, mounts <App /> into #root
│
├── public/                       ← served at site root
│   ├── sql-wasm.wasm             ← copied by postinstall from node_modules/sql.js/dist/
│   ├── sql-wasm-browser.wasm     ←  "    "  (Vite's "browser" export condition asks for this name)
│   └── seed/                     ← `npm run seed` writes here (gitignored in spirit)
│       ├── tweets.html
│       ├── classifier.json
│       └── enriched.json
│
├── scripts/
│   ├── seed.ts                   ← deterministic 5k-tweet fixture generator (mulberry32)
│   └── perf.ts                   ← times the full pipeline against the seed (Node + sql.js)
│
├── e2e/
│   └── smoke.spec.ts             ← Playwright: import → list → search → drill → export
│
└── src/
    ├── main.tsx                  ← QueryClientProvider + DbProvider + RouterProvider
    ├── App.tsx                   ← createBrowserRouter; index → /dashboard
    ├── index.css                 ← Tailwind directives + utility classes
    │
    ├── components/
    │   ├── Layout.tsx            ← top nav, theme toggle, total tweet count, FilterChips
    │   ├── TweetCard.tsx         ← per-tweet card; tickers/hashtags become filter chips
    │   ├── TimeSeriesChart.tsx   ← Recharts BarChart, click-to-drill via activeTooltipIndex
    │   ├── CategoryBreakdown.tsx ← horizontal bars (pure HTML, no Recharts)
    │   ├── TopAccountsTable.tsx
    │   ├── EntityTrends.tsx      ← Recharts AreaChart, stacked
    │   ├── EmptyState.tsx
    │   └── LoadingSkeleton.tsx
    │
    ├── routes/
    │   ├── ImportRoute.tsx       ← drag/drop of exports, classifier JSON, and enriched JSON
    │   ├── TweetsRoute.tsx       ← paginated list, FTS search, sort, markdown export
    │   ├── DashboardRoute.tsx    ← 4 panels, granularity + timeField toggles
    │   ├── CategoriesRoute.tsx   ← rename/recolor/delete + bulk-assign-to-filtered
    │   └── SettingsRoute.tsx     ← stats, .db snapshot up/download, reset
    │
    ├── parser/
    │   ├── htmlExport.ts         ← regex-extracts `const tweetsData = [...]` from extension HTML
    │   ├── classifierJson.ts     ← parses categorized_tweets.json (Python classifier output)
    │   └── entities.ts           ← extractEntities() for $tickers, #hashtags, @mentions
    │
    ├── db/
    │   ├── schema.ts             ← INITIAL_SCHEMA[] + SCHEMA_VERSION; FTS4 + triggers
    │   ├── sqlite.ts             ← getDb() handle, IDB snapshot persistence (2s debounce)
    │   ├── exec.ts               ← run / all<T> / get<T> / scalar<T> / transaction helpers
    │   └── queries/
    │       ├── tweets.ts         ← importHtmlTweets (UPSERT), listTweetsPage, setFavorite, …
    │       ├── categories.ts     ← upsert/list/rename/recolor; replaceClassifierAssignments;
    │       │                       bulkAssignToFiltered
    │       └── analytics.ts      ← timeSeries, categoryBreakdown, topAccounts, entityTrends
    │
    ├── filters/
    │   ├── types.ts              ← FilterSet (canonical), Granularity, TimeField, helpers
    │   ├── urlSync.ts            ← FilterSet ⇄ URLSearchParams
    │   ├── queryBuilder.ts       ← buildFilterFragments(): {whereSql, joinSql, params}
    │   └── FilterChips.tsx       ← removable chips + "Clear all"
    │
    ├── lib/
    │   ├── dbContext.tsx         ← <DbProvider> + useDb() / useDbStatus() hooks
    │   ├── format.ts             ← formatNumber (K/M/B), formatDate, formatBucket
    │   └── time.ts               ← bucketBounds(bucket, granularity) for chart drill-down
    │
    ├── state/
    │   └── uiStore.ts            ← Zustand: { theme, entityTab, pageSize }, persisted
    │
    │
    └── tests/
        ├── parser.test.ts        ← 12 tests: HTML parse, classifier parse, entity extract
        ├── queryBuilder.test.ts  ← 13 tests: filter SQL emission, FTS sanitize, URL round-trip
        ├── setup.ts              ← Vitest setup hook (currently empty)
        └── fixtures/
            └── sample-export.html
```

### Where to look first

| If you're touching… | Start at |
|---|---|
| HTML parser / classifier ingest | `src/parser/{htmlExport,classifierJson,entities}.ts` |
| Schema / migrations / triggers | `src/db/schema.ts` |
| A new SQL query | `src/db/queries/*.ts` (use helpers from `db/exec.ts`) |
| Filter semantics / new filter type | `src/filters/{types,queryBuilder,urlSync}.ts` |
| A new chart panel | new component in `src/components/`, wire into `routes/DashboardRoute.tsx` |
| URL state for a new param | extend `FilterSet`, then both halves of `urlSync.ts` |
| Persistent UI pref | `src/state/uiStore.ts` + add to `partialize` |
| Chat keys / model / wiki URL persistence | `src/state/chatStore.ts` (persist version 3; bump + migrate if you rename a field) |
| Adding tests | `src/tests/` (Vitest) and `e2e/` (Playwright) |
| Making the seed bigger / different | `scripts/seed.ts`, run `npm run seed` |
| Measuring perf changes | `scripts/perf.ts`, run `npx tsx scripts/perf.ts` |
| Chat agent loop / tool-round cap | `src/chat/agent.ts` (`MAX_TOOL_ROUNDS = 12`, final round forced text-only) |
| DeepSeek adapter (Anthropic-shape → OpenAI-compat) | `src/chat/client.ts` |
| Chat tools (5 SQL + 3 wiki) | `src/chat/tools.ts` |
| System prompts / context block | `src/chat/prompts.ts` |
| Query-time embedding (Voyage) | `src/chat/voyage.ts` |
| Hybrid retrieval / Web Worker | `src/chat/{retrievalCore,retrievalWorker,retrieval}.ts` |
| Chat UI (footnote chips, sources grid, tool steps, status line, drawer) | `src/components/chat/{MessageBubble,CitationChip,SourcesList,ToolSteps,ConversationView,WikiDrawer,ChatPopup,…}.tsx`, `src/routes/ChatRoute.tsx` |
| Chat turn state (streaming, stop, retry, phase) | `src/chat/useChatTurn.ts` |
| Remote MCP server (`/api/mcp`, D1 FTS5) | `functions/api/mcp.ts`, `../scripts/build_mcp_d1.py`, Settings panel `src/components/McpSection.tsx`, docs `../docs/mcp-server.md` |
| Enrichment ingest | `src/parser/enrichedExport.ts`, `src/db/queries/enrichments.ts` |
| ⟳ Sync button (pull files from disk) | `src/lib/syncFromDisk.ts` + `src/components/Layout.tsx`; server side: `wiki_server.py` `/api/data/*` |
| Settings + "Load keys from .env" | `src/routes/SettingsRoute.tsx`; server side: `wiki_server.py` `/api/keys/*` |

## What it does

- **Tweet list** with FTS search (FTS4 prefix search), sort by liked/created
  time, pagination, and per-row export to Markdown.
- **Dashboard** with four cross-filtered panels:
  - time-series histogram (year / month / week / day)
  - top categories bar chart
  - top accounts table
  - entity trends area chart (tickers / hashtags / mentions)

  Click any bar/row to drill in - the URL captures the active filter set
  so the page state is shareable.
- **Categories** management - rename, recolor, delete manual categories;
  bulk-assign a category to every tweet currently matching the filter.
- **Settings** - snapshot the entire DB to a `.db` file (or restore from
  one), reset all data, see a summary of corpus size, paste API keys for
  **DeepSeek** (chat) and **Voyage** (query-side embeddings), pick a
  chat model (free-text - any DeepSeek native model id, defaults to
  `deepseek-v4-flash`), and configure the wiki server URL.  The
  **"Load keys from .env"** button at the top fetches `/api/keys/load` on
  the wiki server and populates both keys with one click. The wiki server
  needs the token from `../.wiki_token`; paste it once under
  **Local server token**.
- **Chat** - second-brain RAG over the archive. Pre-fetched hybrid
  retrieval (FTS + cosine similarity over int8 Voyage embeddings, fused via
  RRF) gives the agent a context block; the agent can also call 5 SQL tools
  (`search_tweets`, `count_tweets`, `top_authors`, `tweets_in_period`,
  `get_tweet_by_id`) and - **only when the local wiki server is running** - 3
  wiki tools (`list_wiki_pages`, `read_wiki_page`, `search_wiki`). The
  **cloud deployment is SQL-tools-only** (no wiki server), and uses the
  SQL-only system prompt. The tool-using loop caps at 12 rounds; round 11 is
  forced text-only (tools omitted) so the model always converges.
  Responses **stream** token by token (SSE through the same adapter; a
  plain-JSON reply still works), with a live status line while the agent
  embeds, searches, thinks, or runs a tool, and a **Stop** button that
  keeps whatever streamed.  A failed turn offers **Retry** without
  re-persisting the question.
  Assistant replies render as markdown.  `[^1234567890]` becomes a numbered
  footnote chip (`[2] @handle`); every cited tweet is laid out in full in a
  **Sources** grid under the message (author, date, text, media, likes,
  "View in archive" → `/tweets?id=…`, open on X, ask about it).  Clicking a
  chip scrolls to and flashes its card.  `[[people/jhalvorsen]]` opens a side
  drawer over the local wiki.  Tool calls collapse into a one-line
  "N steps" strip with readable summaries (expand for raw JSON).  Each
  completed message shows its time and token usage and has a Copy button.
  The composer sends on Enter (Shift+Enter for a newline; on mobile Enter
  is a newline and the button sends), grows with the text, and an empty
  conversation offers starter questions built from the archive's top
  authors and categories.  The pane only auto-follows new output while
  you are at the bottom; a "↓ Latest" button appears otherwise.

  To run chat against your own collection, follow [docs/getting-started.md](../docs/getting-started.md).
  `./trove update` builds the embeddings, URL text, and image descriptions offline with `enrich.py`.

  Wiki layer (optional but improves synthesis answers):
  ```bash
  python3 wiki_bootstrap.py --limit-authors 20 --limit-concepts 20 \
      --limit-tickers 20         # validation slice, ~$0.30
  python3 wiki_bootstrap.py      # full pass
  ./trove wiki                  # boot just the wiki server (also starts as part of `./trove go`)
  ```
  In Settings → Wiki server, set the URL and click Test - the badge turns
  green and the chat agent automatically gets the wiki tools.

## Architecture

```
HTML export ─┐
             ├─► parser ──► sql.js (in memory) ──► IndexedDB snapshot
classifier  ─┘                    ▲
                                  │
                React + TanStack Query + Recharts
                                  ▲
                URL ◄─► FilterSet ◄─► Zustand (UI prefs)
```

- **`src/db/`** - sql.js handle, schema, query helpers
  - `schema.ts` - `tweets`, `categories`, `tags`, `entities`, join tables,
    indexes, FTS4 virtual table + triggers
  - `sqlite.ts` - `getDb()` returns a handle that auto-flushes to
    IndexedDB on a 2 s debounce, with a `beforeunload` last-ditch flush
  - `queries/` - typed wrappers for each query/mutation
- **`src/parser/`** - pure functions that turn the extension's HTML and
  the classifier's JSON into typed records. Covered by Vitest.
- **`src/filters/`** - `FilterSet` is the canonical filter type. The URL
  is the source of truth: `urlSync` round-trips it; `queryBuilder.ts`
  produces parameterized SQL fragments for use across all reads.
- **`src/components/`, `src/routes/`** - the React surface. Routes are
  `react-router-dom` browser router routes; data is fetched with
  `@tanstack/react-query`.
- **`src/state/uiStore.ts`** - Zustand store for UI-only prefs (theme,
  page size, dashboard tab) persisted to `localStorage` under
  `trove-ui`.

### Why sql.js + IndexedDB (not wa-sqlite + OPFS)?

OPFS is faster but fiddly for snapshot import/export; sql.js's serialize/
deserialize round-trip makes the **Settings → Download .db** flow trivial
and works in every modern browser. Re-loading the snapshot on app open is
in the noise next to React's own startup cost (see *Performance*).

### Why FTS4 instead of FTS5?

The sql.js 1.14.1 build ships with FTS3/FTS4 only - FTS5 is **not**
compiled in (verified with `strings` on the wasm: `ENABLE_FTS3` /
`ENABLE_FTS3_PARENTHESIS` are present, no FTS5 markers). FTS4 with
external content (the parent `tweets` table) gives us the same
MATCH/prefix-search ergonomics. If you swap to a sql.js fork that ships
FTS5, change `USING fts4(...)` → `USING fts5(...)` and the join column
from `docid` → `rowid` (one-line edit in `queryBuilder.ts`).

### Re-imports preserve user data

`tweet_categories.assigned_by` is `'classifier'` or `'user'`. When the
classifier JSON is re-uploaded, only `assigned_by='classifier'` rows for
the affected tweets are deleted before inserting the fresh assignments -
so a tweet you manually categorized stays categorized.

The same logic applies to tweets themselves: `importHtmlTweets` issues
an `INSERT … ON CONFLICT(id) DO UPDATE` that refreshes engagement counts
and content but **does not** touch `is_favorite`, `user_notes`, or
`liked_at` (which is set on first insert).

## Scripts

| command | what it does |
|---|---|
| `npm run dev` | Vite dev server on `127.0.0.1:5174` |
| `npm run build` | typecheck + production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests (MCP server under Miniflare and D1, parsers, query builder, retrieval, citations, chat, schema migrations, sync) |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:e2e` | Playwright (smoke `import → list → filter → drill → export`, plus chat e2e) |
| `npm run seed` | regenerates `public/seed/{tweets.html, classifier.json, enriched.json}` |
| `npx tsx scripts/perf.ts` | runs perf measurement against the seed |

The Playwright config has `reuseExistingServer: !process.env.CI`, so it
piggybacks on a running `npm run dev` if there is one.

## Performance

Measured by `scripts/perf.ts` against the seed fixture (5000 tweets, 20
categories, 4-year span) - Apple Silicon, sql.js running in node. In the
browser numbers are comparable.

| step | observed | target |
|---|---|---|
| sql.js init + schema migrate | ~35 ms | 3 s |
| 5000-tweet import (insert + FTS sync) | ~625 ms | n/a |
| classifier link (4600 tweets) | ~125 ms | n/a |
| `listTweetsPage` empty filter, 50 rows | ~2 ms | 200 ms |
| `listTweetsPage` with FTS query | ~2 ms | 200 ms |
| `timeSeries` (4 years, monthly, 48 buckets) | ~5 ms | 300 ms |
| `categoryBreakdown` (top 20) | ~6 ms | 500 ms |
| `topAccounts` (top 15) | ~4 ms | 500 ms |
| `entityTrends` (ticker, top 8) | ~4 ms | 500 ms |

What would push these out of budget: a much larger corpus (>50k
tweets) starts to make `entityTrends` and `topAccounts` more expensive
because the inner CTE materializes the filter set; if needed,
materialize an `entity_counts` aggregate in a separate table on import.

## Known quirks

- **`vite.config.ts` casts `test` via `UserConfig & { test }`.** Vitest
  ships its own `vite` dep, so importing `defineConfig` from
  `vitest/config` collides with the top-level `vite` types (Plugin type
  identity mismatch). Casting against a widened type is the smallest
  workaround and is annotated in the file.
- **Two wasm files in `public/`.** sql.js's `package.json` exports
  condition routes browser builds to `sql-wasm-browser.js`, which in
  turn fetches `sql-wasm-browser.wasm` (not `sql-wasm.wasm`). The
  postinstall copies both so either entry point works.
- **`liked_at` falls back to `created_at`.** The Chrome extension does
  not currently emit a separate liked-at timestamp; `importHtmlTweets`
  uses the tweet creation time as a stand-in. The dashboard's
  `liked_at` toggle still works - it just resolves to the same column
  data until the extension grows real liked-at capture.
- **Thread detection is heuristic.** After import, a single
  `UPDATE tweets SET is_thread = 1 WHERE EXISTS (…another tweet by
  same author within 1 hour…)` runs once. False positives possible for
  high-volume authors; cheap to recompute.

## License

MIT. See [LICENSE](../LICENSE) and the [root README](../README.md).
