// One-time: build a fresh browser profile (/tmp/trove-demo-profile) that holds ONLY the synthetic seed.
// 1. Puts the DeepSeek and Voyage keys from the environment into the chat settings store (never printed).
// 2. Loads tweets.html, classifier.json and enriched.json from public/seed/ through the app's own Import page.
// 3. Aborts if the database does not hold exactly the 5,000 synthetic posts.
import { chromium } from '@playwright/test';
import { rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { PROFILE, BASE } from './lib.mjs';

const SEED = 'public/seed';
const { DEEPSEEK_API_KEY, VOYAGE_API_KEY } = process.env;
if (!DEEPSEEK_API_KEY || !VOYAGE_API_KEY) throw new Error('Set DEEPSEEK_API_KEY and VOYAGE_API_KEY (source .env first).');
// The app auto-reads from the wiki server at :8765 and that server serves real data. Refuse to run if anything listens.
try { execSync('lsof -i :8765 -sTCP:LISTEN', { stdio: 'pipe' }); throw new Error('Something listens on :8765. Stop it first.'); }
catch (e) { if (String(e.message).startsWith('Something')) throw e; }
if (PROFILE.includes('trove-profile')) throw new Error('Refusing to use the old profile that may hold real data.');
if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, { viewport: { width: 1280, height: 800 } });
const p = ctx.pages()[0] ?? await ctx.newPage();
p.on('console', (m) => { if (m.type() === 'error') console.log('ERR', m.text().slice(0, 150)); });
await p.goto(BASE + '/import');
await p.evaluate(([ds, vo]) => localStorage.setItem('trove-chat', JSON.stringify({
  state: { deepseekApiKey: ds, voyageApiKey: vo, chatModel: 'deepseek-v4-flash', embedModel: 'voyage-3-large', acknowledgedKeyRisk: true, wikiServerUrl: 'http://localhost:8765' },
  version: 3,
})), [DEEPSEEK_API_KEY, VOYAGE_API_KEY]);
await p.reload();
await p.waitForTimeout(2000);
// HTML first (creates the posts), then classifier (categories), then enriched (embeddings).
await p.locator('input[type=file]').setInputFiles([`${SEED}/tweets.html`, `${SEED}/classifier.json`, `${SEED}/enriched.json`]);
await p.getByText(/Import complete|Imported|Done/i).first().waitFor({ timeout: 180000 }).catch(() => {});
await p.waitForTimeout(8000);
console.log((await p.locator('main').innerText()).slice(0, 900));
await p.goto(BASE + '/dashboard'); await p.waitForTimeout(4000);
const body = await p.locator('body').innerText();
const m = body.match(/([\d,]+) (?:tweets|posts)/i);
console.log('count on screen:', m?.[0]);
if (!m || m[1].replace(/,/g, '') !== '5000') { await ctx.close(); throw new Error('ABORT: post count is not the 5,000 synthetic posts.'); }
await ctx.close();
