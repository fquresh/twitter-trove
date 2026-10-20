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
.venv/bin/python3 -m unittest discover -s tests
bash -n trove && bash tests/test_trove_secrets.sh
bash tests/test_check_no_real_data.sh && bash scripts/check-no-real-data.sh
```

Run the app with `cd webapp && npm run dev` (port 5174).
Import `webapp/public/seed/` on the Import page for synthetic data.

## Conventions

- Keep TypeScript strict and the typecheck clean.
- Add or update a test with each behavior change.
- Use only invented handles, display names, and post text in tests, fixtures, and docs.
- Never copy or paraphrase a real post, even a public one.
- Use only fictional post ids, such as `1900000000000000001`. `scripts/check-no-real-data.sh` enforces this.
- Write docs in short sentences, one sentence on each line.
- Do not use the em dash character.
- Never edit lockfiles or build output by hand.
- Keep the chat citation format `[^tweet_id]` and the wiki link format `[[folder/slug]]`.

## Data and secrets

- Never commit `.env`, `.wiki_token`, `webapp/wrangler.toml`, `exports/`, `wiki/`, pipeline JSON files, or cache files.
- Never print or write an API key.
- Never put a real account id, email, or address in a file.
- Do not start `wiki_server.py` from a directory that holds real data when you capture media.
- Do not run `./trove deploy` unless the user asks.
