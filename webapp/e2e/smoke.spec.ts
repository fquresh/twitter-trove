import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end smoke: upload HTML → tweets appear → search → drill down from
// chart → export markdown. Uses the deterministic seed fixture (run
// `npm run seed` if /seed/*.* is missing).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_HTML = resolve(__dirname, '..', 'public', 'seed', 'tweets.html');
const SEED_JSON = resolve(__dirname, '..', 'public', 'seed', 'classifier.json');

// The list is newest-first, so page 1 starts with the newest seeded tweet. Read
// its handle from the fixture rather than hardcoding one: regenerating the seed
// then cannot silently break this assertion (the same pattern chat.spec.ts uses).
const NEWEST_HANDLE = (() => {
  const html = readFileSync(SEED_HTML, 'utf8');
  const m = html.match(/const tweetsData = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('seed HTML: tweetsData block not found');
  const rows = JSON.parse(m[1]!.replace(/\\u005d;/g, '];')) as Array<{
    handle: string;
    timestamp: string;
  }>;
  return [...rows].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )[0]!.handle;
})();

test.describe('smoke', () => {
  test('import → list → filter → drill down → export', async ({ page }, testInfo) => {
    // Use a 1440px desktop viewport for the date-popover screenshot.
    await page.setViewportSize({ width: 1440, height: 900 });

    // Fresh IndexedDB for each test run - Playwright gives a new context, so
    // the sqlite snapshot store is already empty. We just confirm.
    await page.goto('/import');
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 15_000 });

    // Upload seed HTML + classifier JSON in one shot.
    await page.setInputFiles('input[type="file"]', [SEED_HTML, SEED_JSON]);

    // Import summary appears when done.
    await expect(page.getByText('Import summary')).toBeVisible({ timeout: 30_000 });
    const summaryCard = page.getByText('Import summary').locator('..');
    await expect(summaryCard.getByText('Tweets inserted')).toBeVisible();
    // 5000 inserted - rendered as "5000" without grouping in dd.
    await expect(summaryCard).toContainText('5000');

    // Navigate to list. The filter-chip bar + total count are in the Layout.
    await page.getByRole('link', { name: 'Tweets' }).click();
    await expect(page).toHaveURL(/\/tweets/);
    await expect(page.getByRole('heading', { name: 'Tweets' })).toBeVisible();
    await expect(page.getByText(/5,000 matching/i)).toBeVisible();

    // At least one author we seeded should be visible on page 1.
    await expect(page.getByText(`@${NEWEST_HANDLE}`).first()).toBeVisible();

    // The account name (display name) links to the author's X profile.
    const firstCard = page.locator('article').first();
    const firstAuthorLink = firstCard.locator('header a').first();
    await expect(firstAuthorLink).toHaveAttribute(
      'href',
      new RegExp(`^https://x\\.com/${NEWEST_HANDLE}$`),
    );

    // Copy link button copies the tweet URL to the clipboard.
    await firstCard.getByRole('button', { name: 'Copy link' }).click();
    const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedLink).toMatch(/^https:\/\/x\.com\/\w+\/status\/\d+$/);

    // Filter via search. "compute" is a word we use heavily in templates.
    await page.getByPlaceholder(/Search tweets/).fill('compute');
    await page.getByPlaceholder(/Search tweets/).press('Enter');
    await expect(page.getByText(/\bmatching\b/)).toBeVisible();
    // Result count shrinks below the full 5000.
    await expect(page.getByText(/5,000 matching/)).toHaveCount(0);

    // Clear search via the filter chip "Clear all" to reset for the dashboard.
    await page.getByPlaceholder(/Search tweets/).fill('');
    await page.getByPlaceholder(/Search tweets/).press('Enter');
    await expect(page.getByText(/5,000 matching/i)).toBeVisible();

    // Dashboard: verify chart renders, then click the middle bar to drill in.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();

    // Desktop date popover: presets column + calendar side by side.
    await page.getByTestId('date-range-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Date range' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('desktop-date-popover.png') });
    await page.getByTestId('date-apply').click();
    await expect(page.getByRole('dialog', { name: 'Date range' })).not.toBeVisible();

    // Wait for Recharts to paint at least one bar path.
    const bars = page.locator('.recharts-bar-rectangle path[data-bucket]').first();
    await expect(bars).toBeVisible({ timeout: 10_000 });

    // Click the middle bar. Drill-down writes `from`/`to` into the URL.
    const allBars = page.locator('.recharts-bar-rectangle path[data-bucket]');
    const count = await allBars.count();
    expect(count).toBeGreaterThan(0);
    await allBars.nth(Math.floor(count / 2)).click({ force: true });
    await expect(page).toHaveURL(/[?&]from=/);
    await expect(page).toHaveURL(/[?&]to=/);

    // Back to the tweets list - the date filter carries over via query params.
    await page.getByRole('link', { name: 'Tweets' }).click();
    await expect(page).toHaveURL(/\/tweets/);
    await expect(page).toHaveURL(/[?&]from=/);

    // Select the first tweet and export. Playwright listens for the download
    // triggered by the Export button.
    const firstCheckbox = page.getByRole('checkbox', { name: /^Select tweet by/ }).first();
    await firstCheckbox.check();

    // Export is now a menu with Markdown and Copy URLs options.
    await page.getByRole('button', { name: /Export/ }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download Markdown/ }).click();
    const dl = await downloadPromise;
    expect(dl.suggestedFilename()).toMatch(/trove-\d{4}-\d{2}-\d{2}-1-tweet\.md/);

    // Copy URLs copies the selected tweet URLs to the clipboard.
    await page.getByRole('button', { name: /Export/ }).click();
    await page.getByRole('button', { name: /Copy URLs/ }).click();
    const copiedUrls = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedUrls).toMatch(/^https:\/\/x\.com\/\w+\/status\/\d+$/m);

    // The Favorites toggle writes ?favorite=1 to the URL and filters the list.
    await page.getByRole('button', { name: 'Favorites' }).click();
    await expect(page).toHaveURL(/[?&]favorite=1/);
  });
});
