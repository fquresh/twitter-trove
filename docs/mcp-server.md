# MCP server

This document is the reference for the remote MCP (Model Context Protocol) server in Trove.
The server lets any MCP client query your collection.
It is optional and runs only in the cloud deployment.
Read [deployment.md](deployment.md) first.

## What it is

The endpoint is `<your-pages-url>/api/mcp`.
It is a read-only MCP server.
It runs as a Cloudflare Pages Function in `webapp/functions/api/mcp.ts`.
It answers from the `mcp_*` tables in your D1 database.
It speaks the MCP Streamable HTTP transport in stateless mode.
Every request is one JSON-RPC POST, and every response is JSON.

It exposes ten tools.

| Tool | What it does |
|---|---|
| `search_tweets` | Full-text search (FTS5, bm25) over text, handle, article title, and extracted page and image text. Filters: authors, categories, tickers, from, to, min_likes. |
| `count_tweets` | Count with the same filters, grouped by category, author, ticker, year, or month. |
| `top_authors` | Most-liked authors in a slice, with post count and average likes. |
| `tweets_in_period` | Posts in a date range, newest, oldest, or by likes. |
| `get_tweet` | One post in full, with links, media, and extracted content. |
| `list_categories` | Every category with its count. |
| `archive_stats` | Post count, date range, last index push, and wiki page count. |
| `list_wiki_pages`, `read_wiki_page`, `search_wiki` | The wiki pages from `wiki/`. |

## Why Cloudflare

- The index updates with `./trove deploy`, the same command that ships the app and the data.
- One URL works from any machine.
- Cloudflare Access gates the endpoint, and a service token is the only credential a client needs.

The remote server uses keyword search because D1 holds no embeddings.
The tool descriptions tell the model to try two or three phrasings for a concept.

## How it is updated

`./trove deploy` pushes the index as its last step.
You can also run `./trove mcp-push` alone.

`scripts/build_mcp_d1.py` hashes every post.
The launcher reads the current `(id, hash)` pairs from D1.
It writes only new, changed, and removed posts.
The wiki pages and the `mcp_meta` row are rewritten each time.

The first push has no table to compare, so it loads everything.
That writes many rows, about 75,000 for a collection of 32,000 posts.
Check your D1 plan for the daily row-write limit.
After a full reclassification, run `./trove mcp-push --full`.

## Connect a client

Browsers carry the Access cookie.
MCP clients send an Access service token in two headers on every request:

```text
CF-Access-Client-Id: <client id>
CF-Access-Client-Secret: <client secret>
```

1. In Zero Trust, open Access, then Service Auth, then Service Tokens, and create a token.
2. Add a Service Auth policy for that token to your Access application.
3. Keep the id and the secret in a safe place. Do not commit them.

Settings, then MCP server, in the web app shows ready-to-copy snippets.

**Claude Code**

```bash
claude mcp add --transport http trove https://<your-pages-url>/api/mcp \
  --header "CF-Access-Client-Id: <client id>" \
  --header "CF-Access-Client-Secret: <client secret>"
```

**Claude Desktop or Cursor** (through `mcp-remote`, which bridges stdio to HTTP)

```json
{
  "mcpServers": {
    "trove": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-pages-url>/api/mcp",
        "--header", "CF-Access-Client-Id:${CF_ACCESS_CLIENT_ID}",
        "--header", "CF-Access-Client-Secret:${CF_ACCESS_CLIENT_SECRET}"],
      "env": {
        "CF_ACCESS_CLIENT_ID": "<client id>",
        "CF_ACCESS_CLIENT_SECRET": "<client secret>"
      }
    }
  }
}
```

**Smoke test from a shell**

```bash
curl -s https://<your-pages-url>/api/mcp \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"archive_stats","arguments":{}}}'
```

## Limits

- The server is read-only. Favorites, notes, and manual categories are not exposed.
- Search uses keywords only.
- A call returns 50 results at most. Text is cut at 1,200 characters in lists. `get_tweet` returns the full text.
- The rate limit is 300 requests per minute per identity, shared with the other `/api/*` routes.
- A GET request returns 405. The server has no sessions and no server-to-client stream.
- `webapp/src/tests/mcpServer.test.ts` builds the SQL with the real Python script.
  It loads the SQL into a local D1 under Miniflare and calls the function over HTTP.
