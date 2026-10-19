# capture-media

These scripts record the screenshots and GIFs in [docs/media/](../../docs/media/).
They drive the local web app with Playwright, and ffmpeg converts the recordings to GIFs.

## Run

```bash
cd "$(git rev-parse --show-toplevel)"
set -a; source .env; set +a
lsof -i :8765                           # must print nothing: wiki_server.py serves real data, do not start it
(cd webapp && nohup npm run dev > /tmp/trove-web.log 2>&1 &)
sleep 8
cd webapp
cp ../scripts/capture-media/*.mjs .     # @playwright/test resolves only from webapp/
node setup.mjs                          # builds a fresh /tmp/trove-demo-profile: keys from env, seed via the Import page
node capture.mjs stills                 # hero.png, filters.png, mobile.png
node capture.mjs search                 # records the search video
node capture.mjs chat                   # records the chat video; set Q="..." to change the question
node popup.mjs                          # popup.png
rm lib.mjs setup.mjs capture.mjs popup.mjs
../scripts/capture-media/gif.sh search  # writes docs/media/search.gif
pkill -f vite
```

## Notes

- The captures use only the synthetic seed in `webapp/public/seed/` (5,000 posts, ids like 18000000...).
  `setup.mjs` aborts if the post count is not 5,000, if port 8765 has a listener, or if the profile is the old `/tmp/trove-profile`.
  Never start `wiki_server.py` for captures. The chat header then shows `Wiki: off`, and the agent uses its SQL tools only.
  The keys come from the environment (`DEEPSEEK_API_KEY`, `VOYAGE_API_KEY`) and the scripts never print them.
  Never capture the Settings page.
- `chat.gif` plays the long agent wait at 6x speed.
  Trim 0-7 s at 1x, 7-26 s at 6x, and 26-39 s at 1x, then use a 96-color palette with `dither=none`.
  The default question is `What do I keep liking about AI agents?`, because the seed repeats that topic.
- `mobile.png` and `popup.png` use a device scale factor of 2.
- `mobile.png` uses real mobile emulation (`isMobile: true`).
