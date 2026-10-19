# Workflow

This guide lists the daily commands for Trove.
For first-time setup, read [getting-started.md](getting-started.md).

## The daily routine

1. Collect new posts with the Chrome extension. The file lands in `exports/` through the link.
2. Run `./trove go`. Use `./trove deploy` when you also want to update the cloud app.
3. Click the sync button in the app (top right).

Step 2 classifies and enriches only the new posts.
Step 3 loads the new data and keeps your favorites, notes, and manual categories.

> Never delete the cache files.
> They are `.canonical_classification_cache.json`, `.embedding_cache.json`, `.image_description_cache.json`, and `.url_content_cache.json`.
> A deleted cache forces a paid rerun of that phase.

> Use two paths with care.
> Only `./trove update` classifies posts, and only for HTML in `exports/`.
> A raw HTML file dropped on `/import` loads for viewing but stays uncategorized.

## Commands

```bash
./trove go              # update, start the servers, open the browser, push data to R2 if configured
./trove go --no-update  # only start the servers
./trove update          # classify and enrich new posts (no app)
./trove update --dry    # estimate cost without spending
./trove deploy          # publish code and data to your Cloudflare app
./trove start           # start the app and the wiki server
./trove wiki            # start only the wiki server
./trove stop            # stop both servers
./trove status          # show servers, keys, and cloud settings
./trove set-key         # paste API keys into .env
./trove mcp-push        # rebuild the MCP index in D1 (--full reloads all)
```

## The sync button

The button is in the top nav of every page.
It fetches the latest `*.html`, `categorized_tweets.json`, and `enriched_tweets.json`.
It imports them with no duplicates.
A pill shows the result: syncing, new posts added, already up to date, or an error.
Locally, `wiki_server.py` serves the files from disk.
In the cloud, Pages Functions serve them from R2.

## Why updates are cheap

`./trove update` reads all HTML files again, which is free.
It sends only new posts and new images to paid APIs.
Everything else comes from the on-disk caches.
A run with nothing new is free and fast.

`./trove update --dry` prints the pending items per phase and an estimate.
If the pending image count is close to your whole collection, something is wrong.
The usual cause is a changed vision model name.
`enrich.py` then asks for `--yes-reprocess-images` before it describes all images again.

## Cost figures

These figures come from the author's own runs on a collection of about 32,000 posts.

| Run | Cost |
|---|---|
| Incremental: 78 new posts, 45 new images | About 4 cents. Classify $0.003, images $0.04, embeddings $0.001, URL text $0. |
| Full rebuild | About $11. Image descriptions are most of it, at about $0.0008 per image. |

## Pipeline at a glance

```text
exports/*.html -> reclassify_canonical.py -> categorized_tweets.json -> enrich.py -> enriched_tweets.json
                                                        |
        sync button (or /import) loads all three -> SQLite in browser <-> IndexedDB
```

`./trove update --no-images` skips image descriptions.
`./trove update --emergent` uses the legacy Anthropic classifier.

## Cloud app

`./trove deploy` publishes the app to your own Cloudflare account.
Read [deployment.md](deployment.md) for setup and flags.
Local and cloud are separate copies.
You choose when to publish.

## Fixes

| Problem | Fix |
|---|---|
| `/import` says a tweet is not yet imported | Drop the HTML, classifier, and enriched files together. |
| Chat retrieval is empty | Import `enriched_tweets.json`. |
| The wiki badge shows off | Run `./trove wiki`. |
| Chat says keys are missing | In Settings, click "Load keys from .env", or paste the keys. |
| Wipe and start over | In Settings, click Reset all data. |
| Back up the data | In Settings, click Download .db. |
| Ports stay busy | Run `./trove stop`. |
