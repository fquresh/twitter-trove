import { describe, it, expect } from 'vitest';
import { safeHttpUrl, tweetUrl } from '../lib/tweetLinks';
import { parseHtmlExport } from '../parser/htmlExport';
import type { TweetRow } from '../db/queries/tweets';

const row = (link: string | null) =>
  ({ id: '123', author_handle: '@dummy', link }) as unknown as TweetRow;

describe('safeHttpUrl', () => {
  it('accepts http and https only', () => {
    expect(safeHttpUrl('https://x.com/a/status/1')).toBe('https://x.com/a/status/1');
    expect(safeHttpUrl('http://example.com/')).toBe('http://example.com/');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(safeHttpUrl('/relative')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe('tweetUrl', () => {
  it('uses a safe stored link', () => {
    expect(tweetUrl(row('https://x.com/dummy/status/123'))).toBe('https://x.com/dummy/status/123');
  });
  it('falls back to the canonical status URL for an unsafe link', () => {
    expect(tweetUrl(row('javascript:alert(1)'))).toBe('https://x.com/dummy/status/123');
    expect(tweetUrl(row(null))).toBe('https://x.com/dummy/status/123');
  });
});

describe('parseHtmlExport link sanitising', () => {
  it('replaces a javascript: link with the canonical status URL', () => {
    const data = [
      { id: '555', handle: 'dummy', username: 'D', text: 't', link: 'javascript:alert(1)', timestamp: '2024-01-01T00:00:00Z' },
    ];
    const html = `<script>const tweetsData = ${JSON.stringify(data)};</script>`;
    const { tweets } = parseHtmlExport(html);
    expect(tweets[0].link).toBe('https://x.com/dummy/status/555');
  });
});
