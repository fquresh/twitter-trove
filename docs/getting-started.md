# Getting started

This guide takes you from a fresh clone to a working Trove.
It takes about 15 minutes, plus pipeline time.

## What you need

- macOS or Linux. The `./trove` launcher is a Bash script. The `.command` files are macOS double-click wrappers.
- Python 3 and Node.js.
- Chrome, Brave, or Edge.
- API keys for DeepSeek (chat), OpenRouter (classification and image descriptions), and Voyage (embeddings).
- An Anthropic key is optional. Only `./trove update --emergent` and `wiki_bootstrap.py` use it.

You can try the app first without any key.
See "Try it without your own data" in the [README](../README.md).

## 1. Clone and install

```bash
git clone https://github.com/fquresh/twitter-trove
cd twitter-trove
(cd webapp && npm install)
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

`./trove` also creates `.venv/` on its first run if it is missing.

## 2. Install the extension

1. Open `chrome://extensions/` (or `brave://extensions/`, `edge://extensions/`).
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select the `x-collector/` folder.
5. Pin the extension from the puzzle-piece menu.

Read [x-collector/README.md](../x-collector/README.md) for all pages, options, and fixes.

## 3. Link the download folder

The extension saves every export to `Downloads/trove/`.
The pipeline reads `exports/` in the repo root.
Link the two folders once, from the repo root:

```bash
mkdir -p ~/Downloads/trove
ln -s ~/Downloads/trove exports
```

The folder `exports/` is ignored by git.
In the extension options, you can pick a different download folder for a kind of page.
Files in another folder stay out of the pipeline.

## 4. Set the API keys

```bash
cp .env.example .env
./trove set-key
```

`./trove set-key` asks for each key and hides your input.
It writes the keys to `.env` (mode 600, ignored by git).
Press Enter to skip a key.
`./trove status` shows which keys are loaded.

| Key | Used by |
|---|---|
| `DEEPSEEK_API_KEY` | Chat |
| `OPENROUTER_API_KEY` | `reclassify_canonical.py` and the image phase of `enrich.py` |
| `VOYAGE_API_KEY` | Corpus embeddings and query embeddings |
| `ANTHROPIC_API_KEY` | Optional. Legacy classifier and wiki pages |

The Voyage free tier is too slow for a full collection.
Add a payment method at <https://dash.voyageai.com/> to unlock normal limits.

## 5. Collect posts

1. Open an X timeline while you are logged in. Examples are `x.com/i/history/likes`, `x.com/i/bookmarks`, a profile, a list, or a search.
2. Click the extension icon.
3. Read the banner. It names the page and the save folder.
4. Click Start and keep the X tab visible.
5. Click Download HTML when the status shows Complete.

## 6. Run the pipeline and open the app

```bash
./trove update --dry   # optional: estimate the cost
./trove go
```

`./trove go` classifies and enriches the new posts.
Then it starts the web app and opens `http://127.0.0.1:5174`.
It also starts the wiki server when the `wiki/` folder exists.
Click the sync button (top right) to load the new data.

## 7. Use it

| Route | Use |
|---|---|
| `/tweets` | Search by words and filters. |
| `/dashboard` | Charts that filter each other. |
| `/chat` | Ask questions and get answers with citations. |
| `/categories` | Rename, recolor, and assign categories. |
| `/settings` | Keys, chat model, backup, and restore. |

Press `Cmd+K` (or `Ctrl+K`) anywhere to open a chat popup.
In Settings, click "Load keys from .env" to copy your keys into the browser.
This button works only while `wiki_server.py` runs.

## Next steps

| Need | Read |
|---|---|
| Daily commands and fixes | [workflow.md](workflow.md) |
| How it works | [architecture.md](architecture.md) |
| Put it on your phone | [deployment.md](deployment.md) |
| Use the collection from other agents | [mcp-server.md](mcp-server.md) |
| Add wiki pages | [wiki-schema.md](wiki-schema.md) |
| Change the code | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
