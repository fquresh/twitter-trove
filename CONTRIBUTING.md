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
CI runs the same checks on each push and pull request (`.github/workflows/ci.yml`).

```bash
cd webapp
npm run typecheck
npm test
npm run build
cd ..
node x-collector/test/units.mjs
.venv/bin/python3 -m unittest discover -s tests
bash -n trove && bash tests/test_trove_secrets.sh
bash tests/test_check_no_real_data.sh && bash scripts/check-no-real-data.sh
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
- Use only invented handles, display names, and post text in tests, fixtures, and docs.
  The seed uses names such as `ada_fieldstone` and `jhalvorsen`.
- Never copy or paraphrase a real post, even a public one.
- Use only fictional post ids, such as `1900000000000000001`.
  `scripts/check-no-real-data.sh` fails on any other 18- or 19-digit id.
- Write docs in short sentences. Put one sentence on each line.
- Do not use the em dash character.
- Write small commits with clear messages.

## Never commit data or keys

- Never commit `.env`, `.wiki_token`, `webapp/wrangler.toml`, API keys, or tokens.
- Never commit `exports/`, `categorized_tweets.json`, `enriched_tweets.json`, `embeddings.ndjson`, the cache files, or `wiki/`.
- Never put a real Cloudflare id, email, or address in a file.
- Run `git status` before each commit and read the list.
