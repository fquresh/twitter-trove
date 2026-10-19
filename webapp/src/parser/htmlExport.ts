// Parser for the Chrome extension's HTML export format.
//
// The extension writes an HTML file containing a `<script>` block with
// `const tweetsData = [...]`. We extract that array verbatim. The Python
// pipeline (parse_and_classify.py) uses the same regex, so both readers see
// identical posts on the same input file.

import { safeHttpUrl } from '../lib/tweetLinks';

export interface RawTweet {
  id: string;
  username: string;
  handle: string;
  text: string;
  link: string;
  timestamp: string; // ISO 8601 from the extension
  date: string; // human-readable, e.g. "Apr 15, 2026"
  images: string[] | null;
  hasVideo: boolean;
  /** Extension v1.1+: true when the scrape detected an X long-form article
   * post (a card linking to /article/{same-id}). Undefined on legacy exports
   * that predate article detection - importers must treat that as "unknown"
   * and preserve any previously stored flag. */
  isArticle?: boolean;
  /** Extension v1.1+: article card title captured at scrape time. */
  articleTitle?: string;
  likeCount: number;
  retweetCount: number;
}

export interface ParsedExport {
  tweets: RawTweet[];
  /** List of parse-time validation issues, one per malformed tweet. */
  errors: Array<{ index: number; reason: string }>;
}

const TWEETS_DATA_RE = /const tweetsData = (\[[\s\S]*?\]);/;

export function parseHtmlExport(html: string): ParsedExport {
  const match = html.match(TWEETS_DATA_RE);
  if (!match) {
    return {
      tweets: [],
      errors: [{ index: -1, reason: 'No tweetsData block found in HTML' }],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch (e) {
    return {
      tweets: [],
      errors: [{ index: -1, reason: `Invalid JSON in tweetsData: ${(e as Error).message}` }],
    };
  }
  if (!Array.isArray(raw)) {
    return {
      tweets: [],
      errors: [{ index: -1, reason: 'tweetsData is not an array' }],
    };
  }

  const tweets: RawTweet[] = [];
  const errors: ParsedExport['errors'] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) {
      errors.push({ index: i, reason: 'missing id' });
      continue;
    }
    if (typeof item.timestamp !== 'string') {
      errors.push({ index: i, reason: `tweet ${id}: missing/invalid timestamp` });
      continue;
    }
    const t = Date.parse(item.timestamp);
    if (Number.isNaN(t)) {
      errors.push({ index: i, reason: `tweet ${id}: unparseable timestamp ${item.timestamp}` });
      continue;
    }
    tweets.push({
      id,
      username: typeof item.username === 'string' ? item.username : 'Unknown',
      handle: typeof item.handle === 'string' ? item.handle : 'unknown',
      text: typeof item.text === 'string' ? item.text : '',
      link:
        safeHttpUrl(typeof item.link === 'string' ? item.link : null) ??
        `https://x.com/${typeof item.handle === 'string' ? encodeURIComponent(item.handle.replace(/^@/, '')) : 'i/web'}/status/${encodeURIComponent(id)}`,
      timestamp: item.timestamp,
      date: typeof item.date === 'string' ? item.date : '',
      images: Array.isArray(item.images)
        ? (item.images as unknown[]).filter((u): u is string => typeof u === 'string')
        : null,
      hasVideo: Boolean(item.hasVideo),
      isArticle: typeof item.isArticle === 'boolean' ? item.isArticle : undefined,
      articleTitle:
        typeof item.articleTitle === 'string' && item.articleTitle !== ''
          ? item.articleTitle
          : undefined,
      likeCount: typeof item.likeCount === 'number' ? item.likeCount : 0,
      retweetCount: typeof item.retweetCount === 'number' ? item.retweetCount : 0,
    });
  }

  return { tweets, errors };
}

export function parseHtmlExportFiles(files: Array<{ name: string; html: string }>): {
  tweets: Array<RawTweet & { source_file: string }>;
  errors: Array<{ file: string; index: number; reason: string }>;
} {
  const tweets: Array<RawTweet & { source_file: string }> = [];
  const errors: Array<{ file: string; index: number; reason: string }> = [];
  for (const f of files) {
    const { tweets: ts, errors: es } = parseHtmlExport(f.html);
    for (const t of ts) tweets.push({ ...t, source_file: f.name });
    for (const e of es) errors.push({ file: f.name, ...e });
  }
  return { tweets, errors };
}
