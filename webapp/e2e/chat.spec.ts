import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 9 - chat e2e (SQL-only path).
//
// We can't hit live LLM/embedding APIs in CI, so we mock both:
//   - api.voyageai.com  → return a deterministic 1024-dim vector
//   - api.anthropic.com → return a single-turn text completion that
//     references a tweet from the seed via [^<id>] so the citation card
//     renders.
//
// The Web Worker exercises the *real* hybrid retrieval against the seeded
// 5,000 embeddings. That's the bit we want to keep honest.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_HTML = resolve(__dirname, '..', 'public', 'seed', 'tweets.html');
const SEED_JSON = resolve(__dirname, '..', 'public', 'seed', 'classifier.json');
const SEED_ENRICHED = resolve(__dirname, '..', 'public', 'seed', 'enriched.json');

// A known seed tweet id (see scripts/seed.ts). The author is read from the
// fixture rather than hardcoded, so regenerating the seed cannot silently
// break the drill-down assertion below.
const SEED_TWEET_ID = '1800000000000000358';
const SEED_TWEET_HANDLE = (() => {
  const html = readFileSync(SEED_HTML, 'utf8');
  const m = html.match(/const tweetsData = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('seed HTML: tweetsData block not found');
  const rows = JSON.parse(m[1]!.replace(/\\u005d;/g, '];')) as Array<{ id: string; handle: string }>;
  const row = rows.find((r) => r.id === SEED_TWEET_ID);
  if (!row) throw new Error(`seed HTML: tweet ${SEED_TWEET_ID} not found`);
  return row.handle;
})();

test.describe('chat', () => {
  test('import → keys → ask → citation → drill', async ({ page }) => {
    // ---- Mock embeddings + LLM before any chat traffic. ----
    await page.route('**/api.voyageai.com/v1/embeddings', async (route) => {
      // Deterministic 1024-dim float vector. The values don't matter for the
      // worker - it just needs the shape to match.
      const v: number[] = new Array(1024).fill(0);
      for (let i = 0; i < 1024; i++) v[i] = Math.sin(i * 0.07);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ embedding: v }],
          usage: { total_tokens: 4 },
        }),
      });
    });

    // Force the wiki server to look unreachable.  The dev may have it running
    // locally on :8765 (set up by ./trove); aborting at the route level keeps
    // the test deterministic regardless.
    await page.route(
      (url) =>
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
        url.port === '8765',
      (route) => route.abort('failed'),
    );

    // Chat goes through DeepSeek's native OpenAI-compatible endpoint (see
    // src/chat/client.ts). Single non-streaming turn - no tool use. Includes a
    // tweet citation and a wiki link so we can exercise both bubbles.
    await page.route('**/api.deepseek.com/chat/completions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'chatcmpl_test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `Juno Halvorsen's three "changed my mind in 2025" notes are a good summary [^${SEED_TWEET_ID}]. See [[people/jhalvorsen]] for the running brief.`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 50 },
        }),
      });
    });

    // ---- Import the seed (HTML + classifier + enriched). ----
    await page.goto('/import');
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({
      timeout: 15_000,
    });
    await page.setInputFiles('input[type="file"]', [SEED_HTML, SEED_JSON, SEED_ENRICHED]);

    await expect(page.getByText('Import summary')).toBeVisible({ timeout: 30_000 });
    const summary = page.getByText('Import summary').locator('..');
    await expect(summary).toContainText('5000');
    // Embeddings imported counter should appear (label: "Embeddings imported").
    await expect(summary.getByText(/Embeddings imported/i)).toBeVisible();

    // ---- Settings: paste keys + acknowledge risk. ----
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByText('AI / Chat')).toBeVisible({ timeout: 10_000 });

    // Both password fields render side-by-side. Fill them, then click each
    // adjacent Save button.
    await page.locator('input[type="password"]').first().fill('sk-ant-test-mock');
    await page.locator('input[type="password"]').nth(1).fill('pa-test-mock');
    // Two Save buttons in the AI section + one in Wiki section. We just want
    // the first two.
    await page.locator('button:has-text("Save")').nth(0).click();
    await page.locator('button:has-text("Save")').nth(1).click();

    // ---- Chat: ask the question. ----
    await page.getByRole('link', { name: 'Chat' }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();

    // Worker indicator should turn green once embeddings are mirrored.
    await expect(page.getByText('🟢 ready')).toBeVisible({ timeout: 15_000 });

    const composer = page.getByPlaceholder(/Ask the agent/);
    await composer.fill('What did jhalvorsen change his mind about in 2025?');
    await page.getByRole('button', { name: /^Send$/ }).click();

    // The mocked completion includes the citation marker; the citation card
    // should render (links to /tweets?id=<SEED_TWEET_ID>).
    const citation = page.locator(`a[href="/tweets?id=${SEED_TWEET_ID}"]`);
    await expect(citation).toBeVisible({ timeout: 15_000 });

    // "Ask" from inside the conversation must stay in the conversation: it used
    // to open the floating popup on top of the chat the reader was already in
    // (a second chat, with its own session). It should fill this route's
    // composer instead.
    await page.getByTitle('Ask the agent about this tweet').first().click();
    await expect(page.getByTestId('chat-popup')).toHaveCount(0);
    await expect(page).toHaveURL(/\/chat/);
    await expect(composer).toHaveValue(/context behind this tweet/);
    await composer.fill('');

    // ⌘K on /chat belongs to the same composer, not to a second panel.
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('chat-popup')).toHaveCount(0);
    await expect(composer).toBeFocused();

    // The wiki link badge should also render. Clicking opens the drawer; the
    // wiki server is intentionally NOT running in this test, so the drawer
    // shows the graceful "unreachable" banner.
    const wikiBadge = page.getByRole('button', { name: /people\/jhalvorsen/ });
    await expect(wikiBadge).toBeVisible();
    await wikiBadge.click();
    const drawer = page.getByTestId('wiki-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(/Wiki server unreachable/i)).toBeVisible({
      timeout: 5_000,
    });
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).not.toBeVisible();

    // Click the citation → drill into Tweets route with ?id=.
    await citation.click();
    await expect(page).toHaveURL(new RegExp(`/tweets\\?id=${SEED_TWEET_ID}`));
    const pinnedSection = page
      .getByText('Pinned from chat citation')
      .locator('..')
      .locator('..');
    await expect(pinnedSection).toBeVisible();
    await expect(pinnedSection.getByText(`@${SEED_TWEET_HANDLE}`).first()).toBeVisible();

    // The in-app link carries its origin, so the pinned card offers a direct
    // way back to the conversation without touching browser history.
    await page.getByRole('button', { name: /Back to chat/ }).click();
    await expect(page).toHaveURL(/\/chat\?s=/);
    await expect(page.locator(`a[href="/tweets?id=${SEED_TWEET_ID}"]`)).toBeVisible();

    // Off /chat, the same action still opens the floating panel with the prompt
    // ready to send - the two surfaces are exclusive, not merged.
    await page.goto(`/tweets?id=${SEED_TWEET_ID}`);
    await page.getByTitle('Ask the agent about this tweet').first().click();
    const popup = page.getByTestId('chat-popup');
    await expect(popup).toBeVisible();
    await expect(popup.getByPlaceholder(/Ask the agent/)).toHaveValue(/context behind this tweet/);
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    // The panel stays mounted while closed, so dismissing it never throws away
    // a half-typed question.
    await page.keyboard.press('Meta+k');
    await expect(popup).toBeVisible();
    await expect(popup.getByPlaceholder(/Ask the agent/)).toHaveValue(/context behind this tweet/);
  });
});
