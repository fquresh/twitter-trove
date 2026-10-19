// Static popup shot. chrome.* APIs do not exist on file://, so a minimal stub supplies the manifest version,
// an empty storage and an x.com likes tab URL. No collected data is faked: all counters stay at their real idle zero state.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
// Repo root, so the script works from any copy location inside the checkout.
const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const ver = JSON.parse(readFileSync(`${ROOT}/x-collector/manifest.json`, 'utf8')).version;
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 400, height: 1000 }, deviceScaleFactor: 2 })).newPage();
await p.addInitScript((ver) => {
  const ev = { addListener() {} };
  window.chrome = {
    runtime: { getManifest: () => ({ version: ver }), onMessage: ev, sendMessage: async () => undefined },
    storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() }, onChanged: ev },
    tabs: { query: async () => [{ id: 1, url: 'https://x.com/i/history/likes' }], sendMessage: async () => undefined },
    scripting: { executeScript: async () => [] }, downloads: { download: async () => {} },
  };
}, ver);
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 120)));
await p.goto(`file://${ROOT}/x-collector/popup.html`); await p.waitForTimeout(1000);
const h = await p.evaluate(() => Math.ceil(document.querySelector('.container').getBoundingClientRect().bottom) + 12);
await p.screenshot({ path: `${ROOT}/docs/media/popup.png`, clip: { x: 0, y: 0, width: 400, height: h } });
await b.close();
