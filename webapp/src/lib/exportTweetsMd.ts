// Markdown export tuned for Obsidian. Each tweet becomes a small,
// self-contained block: H2 author header (linked to profile), blockquote
// body, footer with link + date, then a horizontal rule between entries.
//
// Why this shape:
// - H2 puts the author in Obsidian's outline pane.
// - Blockquote visually separates the tweet from any notes the user adds.
// - Multi-line tweets stay coherent because every line (including blank
//   lines) is prefixed with "> " - that's the Markdown convention for
//   multi-paragraph blockquotes.
// - The `---` separator + surrounding blank lines preserves spacing when
//   exporting many tweets.

import type { TweetRow } from '../db/queries/tweets';
import { tweetUrl, tweetProfileUrl } from './tweetLinks';

function formatTweet(t: TweetRow): string {
  const handle = t.author_handle.replace(/^@/, '');
  const display = t.author_display_name?.trim() || handle;
  const date = new Date(t.created_at * 1000).toISOString().slice(0, 10);
  const url = tweetUrl(t);
  const profileUrl = tweetProfileUrl(t);

  // Prefix every line - including blank ones - with "> " so the blockquote
  // continues uninterrupted through paragraph breaks. Trim trailing space
  // afterward to keep the file lint-clean.
  const quoted = t.content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : '> ' + line))
    .join('\n');

  return [
    `## ${display} ([@${handle}](${profileUrl}))`,
    '',
    quoted,
    '',
    `[Open on X →](${url}) · ${date}`,
  ].join('\n');
}

export function exportTweetsToMarkdown(rows: TweetRow[]): string {
  if (rows.length === 0) return '';
  // Blank line + rule + blank line between entries; trailing newline at EOF.
  return rows.map(formatTweet).join('\n\n---\n\n') + '\n';
}

/** Filename like `trove-2026-06-01-5-tweets.md`. */
export function exportFilename(count: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return `trove-${today}-${count}-tweet${count === 1 ? '' : 's'}.md`;
}
