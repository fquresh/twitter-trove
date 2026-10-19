import { test, expect, type Page } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_HTML = resolve(__dirname, '..', 'public', 'seed', 'tweets.html');
const SEED_JSON = resolve(__dirname, '..', 'public', 'seed', 'classifier.json');

function expectedMonthRange(bucket: string): { from: string; to: string } {
  const [y, m] = bucket.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

// Regression: a ~15px overflow widened the layout viewport to ~405px, which
// pushed the fixed tab bar off screen and clipped the "Articles" chip.
async function expectNoHorizontalOverflow(page: Page, route: string) {
  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    navRight: document.querySelector('nav[aria-label="Mobile navigation"]')?.getBoundingClientRect().right ?? 0,
    articlesRight:
      [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Articles'))?.getBoundingClientRect().right ?? 0,
  }));
  expect(m.scrollWidth, `${route} scrollWidth`).toBe(390);
  expect(m.innerWidth, `${route} layout viewport`).toBe(390);
  expect(m.navRight, `${route} tab bar right edge`).toBeLessThanOrEqual(390);
  expect(m.articlesRight, `${route} Articles chip right edge`).toBeLessThanOrEqual(390);
}

test.describe('mobile iOS shell', () => {
  test('import + tab bar + date picker + screenshots', async ({ page }, testInfo) => {
    await page.goto('/import');
    await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible({ timeout: 15_000 });

    await page.setInputFiles('input[type="file"]', [SEED_HTML, SEED_JSON]);
    await expect(page.getByText('Import summary')).toBeVisible({ timeout: 30_000 });

    // Bottom tab bar should be visible after import.
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();

    // Tweets tab works.
    await page.getByRole('link', { name: 'Tweets' }).click();
    await expect(page).toHaveURL(/\/tweets/);
    await expect(page.getByRole('heading', { name: 'Tweets' })).toBeVisible();
    await expect(page.getByText(/\bmatching\b/i)).toBeVisible();

    await expectNoHorizontalOverflow(page, '/tweets');
    await page.screenshot({ path: testInfo.outputPath('mobile-tweets-light.png') });

    // Dashboard tab works and stat cards appear.
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.getByText(/Total tweets/)).toBeVisible();

    await expectNoHorizontalOverflow(page, '/dashboard');
    await page.screenshot({ path: testInfo.outputPath('mobile-dashboard-light.png') });

    // ── Date picker (light mode) ────────────────────────────────────────
    await page.getByTestId('date-range-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Date range' })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('mobile-date-sheet-light.png') });

    // Pick a preset and verify it commits to the URL.
    await page.getByTestId('date-preset-last7').click();
    await expect(page).toHaveURL(/[?&]from=/);
    await expect(page).toHaveURL(/[?&]to=/);

    // Filter row shows a date chip and Clear all.
    await page.getByRole('link', { name: 'Tweets' }).click();
    await expect(page.getByTestId('chip-date')).toBeVisible();
    await expect(page.getByTestId('clear-all')).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('mobile-filter-row-date-chip.png') });

    // Clear via the date chip's × affordance.
    await page.getByTestId('chip-date').click();
    await expect(page).not.toHaveURL(/[?&]from=/);

    // ── Date picker (dark mode) ───────────────────────────────────────────
    await page.getByRole('link', { name: 'Dashboard' }).click();
    const themeButton = page.getByRole('button', { name: 'Toggle theme' });
    await themeButton.click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('date-range-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Date range' })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('mobile-date-sheet-dark.png') });

    // Pick a calendar range: tap start day then end day, then Apply.
    // Day buttons are inside the calendar wrapper; click two distinct days.
    const calendar = page.getByTestId('date-calendar');
    await calendar.locator('button:has-text("15")').first().click();
    await calendar.locator('button:has-text("22")').first().click();
    await page.getByTestId('date-apply').click();

    await expect(page).toHaveURL(/[?&]from=/);
    await expect(page).toHaveURL(/[?&]to=/);

    // Clear all from the filter row.
    await page.getByRole('link', { name: 'Tweets' }).click();
    await page.getByTestId('clear-all').click();
    await expect(page).not.toHaveURL(/[?&]from=/);

    // ── Dashboard chart tap accuracy ──────────────────────────────────────
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Wait for bars to render.
    const bars = page.locator('.recharts-bar-rectangle path[data-bucket]');
    await expect(bars.first()).toBeVisible({ timeout: 10_000 });

    // Click a middle-ish bar and assert the URL's from/to match that bucket.
    const count = await bars.count();
    expect(count).toBeGreaterThan(0);
    const mid = bars.nth(Math.floor(count / 2));
    const bucket = await mid.getAttribute('data-bucket');
    expect(bucket).toMatch(/^\d{4}-\d{2}$/);
    const { from, to } = expectedMonthRange(bucket!);
    await mid.click({ force: true });

    await expect(page).toHaveURL(new RegExp(`[?&]from=${from}`));
    await expect(page).toHaveURL(new RegExp(`[?&]to=${to}`));

    await page.screenshot({ path: testInfo.outputPath('mobile-dashboard-after-bar-tap.png') });

    // Chat tab works; new-session button visible.
    await page.getByRole('link', { name: 'Chat' }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();

    await expectNoHorizontalOverflow(page, '/chat');
    await page.screenshot({ path: testInfo.outputPath('mobile-chat-light.png') });

    // More sheet surfaces the hidden routes (Categories is now in More).
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('link', { name: 'Categories' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Accounts now lives directly on the mobile tab bar.
    await page.getByRole('link', { name: 'Accounts' }).click();
    await expect(page).toHaveURL(/\/accounts/);
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();

    await expectNoHorizontalOverflow(page, '/accounts');
    const screenshotPath = testInfo.outputPath('mobile-accounts-light.png');
    await page.screenshot({ path: screenshotPath });
  });
});
