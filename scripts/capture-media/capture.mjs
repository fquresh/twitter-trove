// Usage (dev server on :5174, wiki on :8765, profile already synced via setup.mjs):
//   cd webapp && node ../scripts/capture-media/capture.mjs   (needs @playwright/test resolvable)
import { open, BASE } from './lib.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
// Repo root, so the script works from any copy location inside the checkout.
const OUT = `${execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()}/docs/media`;
const VID = '/tmp/trove-video'; mkdirSync(VID, { recursive: true });
const hideFab = (p) => p.evaluate(() => { for (const b of document.querySelectorAll('button')) if (b.textContent.includes('Ask the agent')) b.style.display = 'none'; });
const only = process.argv[2];
const want = (n) => !only || only === n;

if (want('stills')) {
  const { ctx, page: p } = await open();
  await p.goto(BASE + '/dashboard'); await p.waitForTimeout(3500); await hideFab(p);
  await p.screenshot({ path: `${OUT}/hero.png` });
  // drill into a category from the dashboard: filter chips + filtered tweet grid
  await p.getByText('AI > Agents').first().click(); await p.waitForTimeout(3500); await hideFab(p);
  await p.screenshot({ path: `${OUT}/filters.png` });
  await ctx.close();
  const m = await open({ width: 390, height: 844, mobile: true });
  await m.page.goto(BASE + '/dashboard'); await m.page.waitForTimeout(3500); await hideFab(m.page);
  await m.page.screenshot({ path: `${OUT}/mobile.png` });
  await m.ctx.close();
}

async function record(name, fn) {
  const { ctx, page: p } = await open({ video: VID });
  const t0 = Date.now();
  await p.goto(BASE + '/tweets'); await p.waitForTimeout(3500);
  const start = (Date.now() - t0) / 1000;
  await fn(p);
  await p.waitForTimeout(1500);
  const end = (Date.now() - t0) / 1000;
  const v = p.video(); await ctx.close();
  writeFileSync(`${VID}/${name}.json`, JSON.stringify({ path: await v.path(), start, end }));
}

if (want('search')) await record('search', async (p) => {
  await hideFab(p);
  const box = p.getByPlaceholder('Search tweets, authors…');
  await box.click(); await p.waitForTimeout(500);
  await box.pressSequentially('AI agents', { delay: 90 });
  await p.waitForTimeout(500); await box.press('Enter'); await p.waitForTimeout(3500);
});

if (want('chat')) await record('chat', async (p) => {
  await p.goto(BASE + '/chat'); await p.waitForTimeout(2500);
  await p.getByText('+ New conversation').click(); await p.waitForTimeout(500);
  const box = p.getByPlaceholder(/Ask the agent/);
  await box.click();
  await box.pressSequentially(process.env.Q || 'What do I keep liking about AI agents?', { delay: 60 });
  await p.waitForTimeout(400); await box.press('Enter');
  await p.getByText('Copy').first().waitFor({ timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(4000);
  await p.mouse.wheel(0, 380); await p.waitForTimeout(2500);
});
