// Real-browser test for the collector's scroll engine.
//
//   node x-collector/test/run.mjs            # current engine, 400 posts
//   node x-collector/test/run.mjs --old path # run another content.js (e.g. the previous version)
//   node x-collector/test/run.mjs --n 1000
//
// Loads test/fake-timeline.html (a virtualized timeline that mimics X: paged
// loading, unmounting off-screen posts, one Retry failure) in headless
// Chromium, shims the chrome.* APIs the content script uses, injects
// source.js + content.js, and checks that every post on the timeline was
// captured.
//
// The fixture is served from file://, which source.js classifies as "not-x".
// That is deliberate: the engine must never gate on the address (the popup owns
// that policy), so the same loop can be exercised offline.
//
// Uses the Playwright + Chromium already installed for webapp.

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'webapp', 'package.json'));
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const scriptPath = opt('--old', path.join(here, '..', 'content.js'));
const total = Number(opt('--n', 400));
const failPage = Number(opt('--fail', 6));
const lag = Number(opt('--lag', 250));
const overscan = Number(opt('--overscan', 0.4));
const timeoutMs = Number(opt('--timeout', 300000));

const contentJs = fs.readFileSync(scriptPath, 'utf8');
const sourceJs = fs.readFileSync(path.join(here, '..', 'source.js'), 'utf8');
const knownJs = fs.existsSync(path.join(here, '..', 'known.js'))
  ? fs.readFileSync(path.join(here, '..', 'known.js'), 'utf8')
  : null;
const pageUrl = `file://${path.join(here, 'fake-timeline.html')}?n=${total}&fail=${failPage}&lag=${lag}&overscan=${overscan}`;

// Minimal chrome.* shim: message bus + in-memory storage.local.
const shim = `
  (() => {
    const listeners = [];
    const store = {};
    const changeListeners = [];
    window.__sent = [];
    window.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (msg) => { window.__sent.push(msg); return Promise.resolve(); },
        getManifest: () => ({ version: 'test' }),
      },
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) if (k in store) out[k] = JSON.parse(store[k]);
            cb(out);
          },
          set: (obj, cb) => {
            for (const [k, v] of Object.entries(obj)) store[k] = JSON.stringify(v);
            if (cb) cb();
          },
          remove: (keys, cb) => { for (const k of [].concat(keys)) delete store[k]; if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
    };
    window.__dispatch = (msg) => new Promise((resolve) => {
      let responded = false;
      for (const fn of listeners) fn(msg, {}, (r) => { responded = true; resolve(r); });
      if (!responded) resolve(undefined);
    });
    window.__store = () => Object.fromEntries(Object.entries(store).map(([k, v]) => [k, JSON.parse(v)]));
    window.__seed = (key, value) => { store[key] = JSON.stringify(value); };
  })();
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});

await page.route('**/pbs.twimg.com/**', (r) => r.abort()); // no network for fixture images
await page.goto(pageUrl);
await page.evaluate(shim);
await page.addScriptTag({ content: sourceJs });
if (knownJs) await page.addScriptTag({ content: knownJs });
await page.addScriptTag({ content: contentJs });

// Wait until the engine reports completion (new engine: storage status;
// old engine: a 'complete' runtime message).
async function waitForResult(deadline) {
  while (Date.now() < deadline) {
    const found = await page.evaluate(() => {
      const s = window.__store();
      if (s.xlc && ['complete', 'stopped', 'error'].includes(s.xlc.status)) {
        return { engine: 'new', status: s.xlc.status, stats: s.xlc.stats, error: s.xlc.error, tweets: s.xlcTweets || [] };
      }
      const done = window.__sent.find((m) => m.type === 'complete' || m.type === 'error');
      if (done) return { engine: 'old', status: done.type, tweets: done.tweets || [], error: done.error };
      return null;
    });
    if (found) return found;
    await page.waitForTimeout(500);
  }
  return null;
}

const t0 = Date.now();
await page.evaluate(() => window.__dispatch({ action: 'start', dateRange: {}, merge: false }));

// Pause/resume scenario (new engine only): the count must freeze while paused.
const isNew = /xlcTweets/.test(contentJs);
let pauseOk = null;
if (isNew) {
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__dispatch({ action: 'pause' }));
  await page.waitForTimeout(1500);
  const a = await page.evaluate(() => window.__store().xlc.stats.count);
  await page.waitForTimeout(2500);
  const b = await page.evaluate(() => window.__store().xlc.stats.count);
  const st = await page.evaluate(() => window.__store().xlc.status);
  pauseOk = a === b && st === 'paused' && a > 0;
  await page.evaluate(() => window.__dispatch({ action: 'resume' }));
}

const result = await waitForResult(t0 + timeoutMs);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const fake = await page.evaluate(() => window.__fake);

// Merge scenario: a second run with merge=true must end with the same set,
// no duplicates, and must not re-persist a smaller array mid-run.
let mergeOk = null;
if (isNew && result && result.status === 'complete') {
  await page.evaluate(() => window.__dispatch({ action: 'start', dateRange: {}, merge: true }));
  await page.waitForTimeout(1500);
  const early = await page.evaluate(() => (window.__store().xlcTweets || []).length);
  await page.evaluate(() => window.__dispatch({ action: 'stop' }));
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const t = window.__store().xlcTweets || [];
    return { n: t.length, unique: new Set(t.map((x) => x.id)).size, status: window.__store().xlc.status };
  });
  mergeOk = early === result.tweets.length && after.n === result.tweets.length && after.unique === after.n && after.status === 'stopped';
  if (!mergeOk) console.log('merge detail:', { early, after, expected: result.tweets.length });
}

// Already-collected scenario: with the index seeded, a re-scan must emit only
// the posts that were missing - never the ones an earlier run already has.
let knownOk = null;
let knownDetail = null;
if (isNew && knownJs && result && result.status === 'complete') {
  const seeded = await page.evaluate(() => {
    const ids = window.__fake.ids.slice(0, 100);
    window.__seed('xlcKnownIds', { 'not-x|||': ids });
    return ids.length;
  });
  await page.evaluate(() => window.__dispatch({ action: 'start', dateRange: {}, merge: false, skipKnown: true }));
  const knownResult = await waitForResult(Date.now() + timeoutMs);
  if (knownResult) {
    const seededIds = new Set(await page.evaluate(() => window.__fake.ids.slice(0, 100)));
    const gotIds = new Set(knownResult.tweets.map((t) => t.id));
    const leaked = [...gotIds].filter((id) => seededIds.has(id));
    const expected = fake.ids.filter((id) => !seededIds.has(id));
    const missed = expected.filter((id) => !gotIds.has(id));
    knownOk =
      knownResult.status === 'complete' &&
      leaked.length === 0 &&
      missed.length === 0 &&
      gotIds.size === expected.length &&
      knownResult.stats.skippedKnown === seededIds.size;
    knownDetail = {
      seeded: seededIds.size,
      collected: gotIds.size,
      expected: expected.length,
      leaked: leaked.length,
      missed: missed.length,
      skippedKnown: knownResult.stats.skippedKnown,
      status: knownResult.status,
    };
  } else {
    knownDetail = { seeded, timeout: true };
  }
}

await browser.close();

if (!result) {
  console.error(`TIMEOUT after ${elapsed}s`);
  process.exit(2);
}

const got = new Set(result.tweets.map((t) => t.id));
const missing = fake.ids.filter((id) => !got.has(id));
const extra = [...got].filter((id) => !fake.ids.includes(id));
const sample = result.tweets.find((t) => t.text.includes('#2 ')) || result.tweets[1];

console.log(`engine=${result.engine} script=${path.relative(root, scriptPath)}`);
console.log(`status=${result.status} elapsed=${elapsed}s`);
console.log(`timeline=${fake.ids.length} collectable (+${fake.promoted} promoted, correctly ignored)`);
console.log(`collected=${got.size} missing=${missing.length} extra=${extra.length}`);
if (result.stats) {
  const { scrolls, scrollPx, retries, imageCount, videoCount, articleCount, maxStepLagMs } = result.stats;
  const pxPerStep = scrolls ? Math.round(scrollPx / scrolls) : 0;
  const perMinute = scrolls ? Math.round((got.size / (Number(elapsed) / 60))) : 0;
  console.log(
    `stats: scrolls=${scrolls} avgStep=${pxPerStep}px lag=${maxStepLagMs ?? '-'}ms retries=${retries} images=${imageCount} videos=${videoCount} articles=${articleCount}`
  );
  console.log(`speed: ${got.size} posts in ${elapsed}s = ${perMinute} posts/min`);
}
if (missing.length) console.log('first missing ids:', missing.slice(0, 8).join(', '));
if (sample) {
  console.log('sample:', JSON.stringify({ username: sample.username, handle: sample.handle, text: sample.text, images: sample.images, likeCount: sample.likeCount }));
}

// Data-quality assertions (only meaningful for the new engine's extractor).
const problems = [];
if (missing.length) problems.push(`${missing.length} tweets missed`);
if (result.engine === 'new') {
  if (!sample.username.includes('🔥')) problems.push('emoji dropped from display name');
  if (!sample.text.includes('📈')) problems.push('emoji dropped from tweet text');
  const quoteLeak = result.tweets.filter((t) => (t.images || []).some((u) => u.includes('/media/Q'))).length;
  if (quoteLeak) problems.push(`${quoteLeak} tweets picked up quoted-tweet images`);
  const noHandle = result.tweets.filter((t) => t.handle === 'unknown').length;
  if (noHandle) problems.push(`${noHandle} tweets without handle`);
  // Timeline position must be recorded under both the new and the legacy name,
  // and must number the collected set 0..n-1 without gaps.
  const positions = result.tweets.map((t) => t.sourceIndex);
  const badPos = positions.some((v, i) => v !== i) || result.tweets.some((t) => t.likeIndex !== t.sourceIndex);
  if (badPos) problems.push('sourceIndex/likeIndex are not a contiguous timeline position');
  if (result.status !== 'complete') problems.push(`status ${result.status}: ${result.error || ''}`);
  if (result.stats.endVerified !== true) problems.push('the end-of-timeline marker was not detected');
  if (pauseOk === false) problems.push('pause did not freeze collection');
  if (mergeOk === false) problems.push('merge run changed the collected set');
  if (knownOk === false) problems.push(`already-collected posts were not skipped correctly: ${JSON.stringify(knownDetail)}`);
  console.log(`scenarios: pause=${pauseOk ? 'ok' : pauseOk} merge=${mergeOk ? 'ok' : mergeOk} known=${knownOk ? 'ok' : knownOk}`);
  if (knownDetail) console.log('known scenario:', JSON.stringify(knownDetail));
}
if (problems.length) {
  console.log('PROBLEMS: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
