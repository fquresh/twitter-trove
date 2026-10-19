# Contributing

Trove is a personal project shared as-is.
You can still open an issue or a pull request.
Small, focused changes are easiest to review.

## Set up

```bash
git clone https://github.com/fquresh/twitter-trove
cd twitter-trove
(cd webapp && npm install)
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env    # only if you run the pipeline or chat
```

Run the app against the synthetic seed: `cd webapp && npm run dev`.
Then import the files in `webapp/public/seed/` on the Import page.
Run `npm run seed` to regenerate the seed.

## Run the tests

Run all of these before you open a pull request.

```bash
cd webapp
npm run typecheck
npm test
npm run build
cd ..
node x-collector/test/units.mjs
.venv/bin/python3 -m unittest tests.test_enrich_ssrf tests.test_wiki_server_host tests.test_wiki_bootstrap_schema
```

Optional checks:

- `npm run test:e2e` in `webapp/` runs the Playwright tests.
- `node x-collector/test/run.mjs` drives the collector against a fake timeline.

## Style

- TypeScript is strict. Keep `npm run typecheck` clean.
- Python code uses type hints and the standard library where possible.
- The extension uses plain JavaScript with no build step.
- Write comments that explain why, not what.
- Add a test with each bug fix.
- Use only invented handles in tests, fixtures, and docs. The seed uses names such as `ada_fieldstone` and `jhalvorsen`.
- Write docs in short sentences. Put one sentence on each line.
- Do not use the em dash character.
- Write small commits with clear messages.

## Never commit data or keys

- Never commit `.env`, `webapp/wrangler.toml`, API keys, or tokens.
- Never commit `exports/`, `categorized_tweets.json`, `enriched_tweets.json`, `embeddings.ndjson`, the cache files, or `wiki/`.
- Never put a real Cloudflare id, email, or address in a file.
- Run `git status` before each commit and read the list.
