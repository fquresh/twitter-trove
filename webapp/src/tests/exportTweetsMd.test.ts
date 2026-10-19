// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { exportTweetsToMarkdown, exportFilename } from '../lib/exportTweetsMd';
import type { TweetRow } from '../db/queries/tweets';

function makeTweet(over: Partial<TweetRow>): TweetRow {
  return {
    id: '1234567890',
    author_handle: 'ada_fieldstone',
    author_display_name: 'Ada Fieldstone',
    content: 'GPT-5 will be a step change.',
    created_at: 1705276800, // 2024-01-15 UTC
    liked_at: 1705276800,
    like_count: 9001,
    retweet_count: 100,
    reply_count: 0,
    is_thread: 0,
    thread_id: null,
    image_urls: null,
    source_file: null,
    imported_at: 0,
    is_favorite: 0,
    user_notes: null,
    has_video: 0,
    link: null,
    is_article: null,
    article_title: null,
    ...over,
  };
}

describe('exportTweetsToMarkdown', () => {
  it('formats one tweet with H2 header, blockquote body, and X link footer', () => {
    const md = exportTweetsToMarkdown([makeTweet({})]);
    expect(md).toContain('## Ada Fieldstone ([@ada_fieldstone](https://x.com/ada_fieldstone))');
    expect(md).toContain('> GPT-5 will be a step change.');
    // No explicit link in fixture - falls back to constructed URL.
    expect(md).toContain('https://x.com/ada_fieldstone/status/1234567890');
    expect(md).toContain('· 2024-01-15');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('uses the tweet handle when display name is missing', () => {
    const md = exportTweetsToMarkdown([
      makeTweet({ author_display_name: null }),
    ]);
    expect(md.split('\n')[0]).toBe('## ada_fieldstone ([@ada_fieldstone](https://x.com/ada_fieldstone))');
  });

  it('prefers an explicit tweet.link when present', () => {
    const md = exportTweetsToMarkdown([
      makeTweet({ link: 'https://x.com/foo/status/9999' }),
    ]);
    expect(md).toContain('[Open on X →](https://x.com/foo/status/9999)');
  });

  it('preserves multi-line tweets as a continuous blockquote', () => {
    const md = exportTweetsToMarkdown([
      makeTweet({
        content: 'Line one.\nLine two.\n\nLine four after blank.',
      }),
    ]);
    expect(md).toContain('> Line one.\n> Line two.\n>\n> Line four after blank.');
  });

  it('separates multiple tweets with a horizontal rule and blank lines', () => {
    const md = exportTweetsToMarkdown([
      makeTweet({ id: '111', author_handle: 'alice', content: 'first' }),
      makeTweet({ id: '222', author_handle: 'bob', content: 'second' }),
    ]);
    const blocks = md.split('\n\n---\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('alice');
    expect(blocks[0]).toContain('> first');
    expect(blocks[1]).toContain('bob');
    expect(blocks[1]).toContain('> second');
  });

  it('returns empty string for an empty selection', () => {
    expect(exportTweetsToMarkdown([])).toBe('');
  });
});

describe('exportFilename', () => {
  it('pluralizes correctly', () => {
    expect(exportFilename(1)).toMatch(/-1-tweet\.md$/);
    expect(exportFilename(7)).toMatch(/-7-tweets\.md$/);
  });

  it('starts with the project prefix', () => {
    expect(exportFilename(3)).toMatch(/^trove-\d{4}-\d{2}-\d{2}-3-tweets\.md$/);
  });
});
