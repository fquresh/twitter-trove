# X Collector

A Chrome/Brave extension that collects any X (Twitter) timeline into a self-contained, searchable HTML archive.
It is the collection step of [Trove](../README.md).
For the full first-run path, read the [root README](../README.md).

Version 2 removed the Likes-only restriction. Point it at whatever timeline you want and press Start.

Version 2.1 made capture reliable and made re-scans cheap. Every scroll step now waits for X to render the window of posts for the new position before moving on (a fixed scroll cadence silently skips posts when X's virtualizer lags), a run is only called `Complete` when X confirms it, and the collector keeps an index of what it has already collected so re-scanning a timeline exports just the posts that were missing.

## What it can collect

| Page | Example address | Download slug |
|---|---|---|
| Your Likes | `x.com/i/history/likes` | `likes` |
| Someone's Likes | `x.com/<handle>/likes` | `likes-<handle>` |
| Your Bookmarks | `x.com/i/bookmarks` | `bookmarks` |
| A bookmark folder | `x.com/i/bookmarks/<id>` | `bookmarks-<id>` |
| Home timeline | `x.com/home` | `home` |
| A profile | `x.com/<handle>` | `<handle>` |
| Posts and replies | `x.com/<handle>/with_replies` | `<handle>-replies` |
| Highlights, Articles | `x.com/<handle>/highlights` | `<handle>-highlights` |
| Search results | `x.com/search?q=...` | `search-<query>` |
| A hashtag | `x.com/hashtag/<tag>` | `hashtag-<tag>` |
| A list | `x.com/i/lists/<id>` | `list-<id>` |
| A community | `x.com/i/communities/<id>` | `community-<id>` |
| A topic | `x.com/i/topics/<id>` | `topic-<id>` |
| A thread | `x.com/<handle>/status/<id>` | `thread-<handle>-<id>` |
| Quotes of a post | `x.com/<handle>/status/<id>/quotes` | `quotes-<id>` |
| Explore, Notifications | `x.com/explore` | `explore` |

Every one of those renders the same virtualized post list, so one engine serves them all.

The popup names the page it is looking at before you press Start. Pages that hold accounts rather than posts (Followers, Following, the Likes and Reposts tabs of a single post) and pages with no timeline (Messages, Settings) are refused with a reason.

**The Media tab is a known gap.** `x.com/<handle>/media` renders a photo grid instead of posts, so the collector finds nothing there and says so. Use the main profile tab.

## Features

- Walks the timeline one viewport at a time and captures every post X mounts. Each step is sized from the window X actually has mounted (half of it, so a step whose render never lands still cannot leave a gap) and waits for that window to render before scanning, so a lagging virtualizer cannot skip posts
- Skips posts from exports you already have, and folds every run's ids into that index (see "Collecting only what was missed")
- Survives closing the popup: progress is stored in `chrome.storage.local`, and the popup shows live stats when you reopen it
- Waits instead of scrolling while the X tab is in the background, where Chrome freezes rendering
- Recovers from X's "Something went wrong / Retry" and from stalled loads (clicks Retry, nudges the scroll, keeps trying for up to 90 s before deciding the timeline is done)
- Finishes the moment X says it is over: an end-of-timeline marker ends the run instead of sitting out the stall window. `Complete` means X showed that marker or had nothing more to load; `Stopped` means X was still showing a loader that never delivered, so the run is not claimed to be whole
- Stops itself if the tab navigates to a different timeline mid-run, so one export never mixes two sources
- Pause / Resume / Stop, and "keep collected" restarts that skip posts you already have
- Date range filtering on the post's own date
- Extracts: display name, @handle, text (emoji preserved), link, ISO timestamp, images (the post's own photos, not the quoted post's), video flag, like/repost counts, timeline position
- Detects X long-form articles (`isArticle` + title)
- Saves every export to one `trove` folder in Downloads, and lets you set a different folder per kind of page
- Generates a self-contained HTML page with search and sort
- No X API required; everything runs in your browser

## Installation

Icons ship in this folder. `create-icons.html` is only needed if you want to regenerate them.

**Chrome or Brave**

1. Open `chrome://extensions/` (or `brave://extensions/`)
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select this `x-collector` folder
4. Pin the extension from the puzzle-piece menu

**Edge**

1. Open `edge://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this folder

After pulling a new version: click the reload icon on `chrome://extensions/`, then **reload the X tab**. The popup refuses to start if an older collector is still loaded in the tab.

## How to use

1. Open the X timeline you want, logged in
2. Click the extension icon. The banner at the top names the page and where the file will be saved
3. Press **Start**
4. Keep the X tab visible. Chrome freezes rendering in background tabs, so collection waits there until the tab is in front again. You can close the popup; progress continues and the popup catches up when reopened
5. Press **Download HTML** when the status shows Complete (or after Stop)

### Options

- **Posts from / to**: month range applied to the post's own date. A Likes timeline is ordered by *when you liked*, and search by relevance, so an old post can appear anywhere in either. The collector skips out-of-range posts and stops only after 50 posts in a row are older than "from".
- **Keep posts already collected in this export**: Start merges with what is stored and skips known posts. Untick it (or press **Clear**) to begin from scratch. The popup blocks a merge across two different sources so an export cannot end up mixed.
- **Skip posts from earlier exports**: Start skips every post the index already holds for this timeline, so the export is the delta - only what was missing. On by default.
- **Import earlier exports… / Forget**: manage that index (next section).
- **Save into Downloads/**: remembered per kind of page. Every source defaults to `trove`. Link `Downloads/trove` to the `exports/` folder in your Trove checkout, and the pipeline reads every export:
  `ln -s ~/Downloads/trove exports`. Change the folder for a kind of page if you want to keep those exports out of the pipeline.

### Collecting only what was missed

The collector keeps an index of every post id it has collected, per timeline, in `chrome.storage.local`. Every finished run folds its ids into that index, and Start skips them, so a re-scan of a timeline exports only the posts you did not already have.

That index starts out empty for exports collected before this version, so import them once:

1. Open the timeline you are about to re-scan and click the extension icon
2. Under the skip checkbox, press **Import earlier exports…** and multi-select the `x-*.html` files you already have (all of `exports/`, for example)
3. The status line under the buttons reports how many ids were imported and how many are known for this page
4. Press **Start** - the button reads `Start (skip N known)`. The run walks the whole timeline but only keeps posts that were missing; the "already collected, skipped" counter in the stats line shows it working
5. **Download HTML** when it finishes. `collectionMeta.skippedKnown` in the file records how many were skipped, so a delta export is self-describing

**Forget** drops the index for the page you are on, if you ever want a full re-collect. Files from before v2.0 carry no source label and are counted as Likes exports; v2.0+ files are filed under the timeline recorded in their `collectionMeta` block, so a profile export can never suppress Likes posts.

Downstream is idempotent anyway - the webapp import upserts by id and `parse_and_classify.py` dedupes by URL across every file in `exports/` - but a delta export keeps the run, the file, and the classifier from doing the same work twice.

### Everyday pattern

Collect new likes only: press Start, watch the count and "already collected, skipped", press **Stop** once you are past the range you care about, then Download. Re-imports into the webapp are idempotent, so overlap is harmless.

## Export format

The HTML file embeds `const tweetsData = [...]` with one object per post:

```
{ id, username, handle, text, link, timestamp, date, images, hasVideo,
  isArticle, articleTitle, likeCount, retweetCount, sourceIndex, likeIndex }
```

`sourceIndex` (v2.0+) is the position in whatever timeline was collected, 0 first. `likeIndex` is the same number under its original name, kept because the readers below already know it.

A second block, `const collectionMeta = {...}`, records which timeline produced the file:

```
{ generator, version, collectedAt, count, skippedKnown,
  source: { kind, label, slug, handle, query, id, url } }
```

`skippedKnown` is how many posts Start skipped because the already-collected index held them, so a file that is a delta rather than the whole timeline says so.

The rendered cards use `.tweet-card`, `.tweet-author .name/.handle`, `.tweet-date`, `.tweet-text`, `.tweet-images`, `.video-indicator`, `.article-indicator`, `.article-title`.

This shape is a contract shared with `webapp/src/parser/htmlExport.ts` and `parse_and_classify.py`. Both locate the posts with the regex `/const tweetsData = (\[[\s\S]*?\]);/`, which is why the emitter escapes `];`, `</` and `<!--` inside the block.

## Files

| File | Role |
|---|---|
| `manifest.json` | Manifest V3; content scripts match all of x.com |
| `source.js` | Classifies an X address: kind, label, download slug, is it a timeline. Shared by the popup and the content script |
| `known.js` | The already-collected index: reading ids out of an old export, which timeline it came from, per-source merge. Shared by the popup and the content script |
| `content.js` | The collection engine: scroll loop, settle-waited steps, MutationObserver capture, extraction, dedup, persistence |
| `popup.js` | View over `chrome.storage.local`, plus policy: which pages may be collected, naming, folders, import/forget of the index |
| `report.js` | `buildReportHtml(tweets, meta)`, the export emitter |

## Testing

```bash
cd webapp && npm install              # once, for Playwright
node x-collector/test/units.mjs       # source classifier, export emitter, already-collected index, no browser
node x-collector/test/run.mjs         # 200 posts in headless Chromium; asserts 0 missed
node x-collector/test/run.mjs --n 1000
node x-collector/test/run.mjs --old path/to/content.js   # compare another engine
node x-collector/test/run.mjs --lag 400 --overscan 0.5   # harsher virtualizer; the pre-2.1 engine loses ~8%
node x-collector/test/run.mjs --lag 0 --overscan 1.2     # a virtualizer that renders instantly
```

`units.mjs` checks a table of about 35 X addresses against the classifier, round-trips a generated export through the readers' own regex (including posts whose text contains `];`, `</script>` and `<!--<script>`), and covers the index helpers: ids read back out of an export, the timeline an export came from, and per-source merging.

`run.mjs` drives the engine against `test/fake-timeline.html`, a virtualized timeline that mimics X: paged loading, unmounting of off-screen posts, a Retry failure, promoted posts, quoted posts, emoji-as-images, and an end-of-timeline marker. Two query parameters model the part that loses posts in the field: `?lag` (X's virtualizer coalesces scroll events and renders the window for the current position at most once per `lag` ms) and `?overscan` (how much of the timeline stays mounted). At the defaults the pre-2.1 engine drops a few percent of the timeline; at `--lag 400 --overscan 0.5` it drops about 8%. The current engine must collect every post at both settings, and pass the pause, merge, and already-collected-skip scenarios.

The same fixture is the speed benchmark, because `?lag` dominates the wall clock the way X's own render latency does. At `--n 200` (197 collectable posts, one Retry page): the engine committed as 2.1 takes 152 s (~78 posts/min); the current one takes 43 s (~276 posts/min). Roughly 80% of the remaining time is the modelled render wait, so that is close to the floor for this fixture - on a live timeline the rate is set by how fast X commits each window, which is why the collector is fastest when the tab is in front and the machine is idle.

The fixture is served over `file://`, which the classifier calls "not an X page" on purpose: the engine must never gate on the address, so it can be exercised offline. The popup owns that policy.

## Troubleshooting

**The extension will not load**: make sure `icon16.png`, `icon48.png`, and `icon128.png` are in the folder, keep all files in one directory, and refresh the extensions page.

**Cannot find the extension icon**: click the puzzle-piece icon in the toolbar, find "X Collector", and click the pin.

**"No posts found on this page"**: the timeline had not rendered yet. Scroll it once by hand, then press Start. On a Media tab, use the main profile tab instead.

**"This tab lists accounts, not posts"**: you are on Followers, Following, or the Likes/Reposts tab of a single post. Those hold accounts, which this extension does not collect.

**"An older collector is still loaded"**: reload the X tab after updating the extension.

**"Stopped: the tab moved from ... to ..."**: the page navigated during collection. Whatever was collected is kept. Go back and press Start with "keep collected" ticked.

**"N posts from <source> are still held"**: you are about to collect a different timeline while posts from another one are in storage. Download them or press Clear first.

**Status shows Interrupted**: the X tab reloaded or closed mid-run. What was collected is kept; press Start with "keep collected" ticked to continue.

**Collection is slow**: keep the X tab in the foreground. Each step waits for X to render the new window of posts and is sized from what X already has mounted, so the rate follows X - expect roughly 150 to 400 posts per minute, and slower if the popup warns that X took seconds to render. Waiting is what keeps posts from being skipped; a background tab or a busy machine is what makes X slow.

**"Stopped at the bottom ... X kept showing a loading indicator"**: X never delivered the next page. What was collected is kept; press Start again with "Keep posts already collected" ticked to carry on from where it stopped.

**Complete, but the count looks short**: X never showed its end-of-timeline marker, so the collector cannot prove it reached the end. Press Start again with "Keep posts already collected" ticked - it resumes past what you have instead of re-collecting it.

**A run collects nothing, or very little**: the already-collected index is doing its job - every post it saw was already in your archive. The "already collected, skipped" counter in the stats line shows how many. Press **Forget** under the skip checkbox to drop the index for this page and collect it in full again.

**Text ends with "…"**: X truncates long posts in the timeline ("Show more"). The collector records what the timeline shows.

## Privacy

Everything runs locally. The only network traffic is X itself and, when you open the export, the images linked from X's CDN.

Collect only what you are allowed to see and keep. A profile you can read is still someone else's content: the export is for your own reference, not for redistribution.
