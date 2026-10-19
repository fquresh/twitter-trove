# Agent instructions

Guidance for coding agents that work in this repository.

## Layout

| Path | Content |
|---|---|
| `trove` | Bash launcher. Run `./trove help`. |
| `x-collector/` | Chrome extension (plain JavaScript, no build step). |
| `parse_and_classify.py`, `reclassify_canonical.py`, `enrich.py`, `trove_common.py` | Offline pipeline. |
| `wiki_server.py`, `wiki_bootstrap.py` | Optional wiki and the local data server. |
| `webapp/` | React and TypeScript app. Cloudflare Pages Functions are in `webapp/functions/api/`. |
| `scripts/` | MCP index build, R2 upload, cloud checks, and `capture-media/`. |
| `tests/` | Python unit tests. |
| `docs/` | Guides. Start with `docs/architecture.md`. |

## Commands

```bash
cd webapp && npm install
npm run typecheck && npm test && npm run build
cd .. && node x-collector/test/units.mjs
.venv/bin/python3 -m unittest tests.test_enrich_ssrf tests.test_wiki_server_host tests.test_wiki_bootstrap_schema
```

Run the app with `cd webapp && npm run dev` (port 5174).
Import `webapp/public/seed/` on the Import page for synthetic data.

## Conventions

- Keep TypeScript strict and the typecheck clean.
- Add or update a test with each behavior change.
- Use only invented handles in tests, fixtures, and docs.
- Write docs in short sentences, one sentence on each line.
- Do not use the em dash character.
- Never edit lockfiles or build output by hand.
- Keep the chat citation format `[^tweet_id]` and the wiki link format `[[folder/slug]]`.

## Data and secrets

- Never commit `.env`, `webapp/wrangler.toml`, `exports/`, `wiki/`, pipeline JSON files, or cache files.
- Never print or write an API key.
- Never put a real account id, email, or address in a file.
- Do not start `wiki_server.py` from a directory that holds real data when you capture media.
- Do not run `./trove deploy` unless the user asks.
