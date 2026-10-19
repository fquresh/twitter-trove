import { chromium, devices } from '@playwright/test';
export const BASE = 'http://127.0.0.1:5174';
export const PROFILE = '/tmp/trove-demo-profile';
export async function open({ video, width = 1280, height = 800, mobile = false } = {}) {
  const opts = { viewport: { width, height }, deviceScaleFactor: 1 };
  if (video) opts.recordVideo = { dir: video, size: { width, height } };
  if (mobile) Object.assign(opts, { deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: devices['iPhone 14'].userAgent });
  const ctx = await chromium.launchPersistentContext(PROFILE, opts);
  const page = ctx.pages()[0] ?? await ctx.newPage();
  return { ctx, page };
}
