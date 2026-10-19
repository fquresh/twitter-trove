// Entity extraction for tweet text.
//
// Tickers: requires `$` followed by 2–6 uppercase letters and a word boundary.
// The lower bound drops noisy single-letter matches, and the upper bound
// covers most real tickers. Common false positives ($USD etc.) are
// filtered via a small ignore list.
//
// Hashtags: `#word`.
// Mentions: `@handle` (excluding email-like contexts).

export interface Entities {
  tickers: string[];
  hashtags: string[];
  mentions: string[];
}

const TICKER_RE = /\$([A-Z]{2,6})\b/g;
const HASHTAG_RE = /(?:^|[^&\w])#([A-Za-z][A-Za-z0-9_]*)/g;
// Mentions: preceded by start or non-word (to avoid email domains);
// NOT preceded by a character that would make it part of a URL or email.
const MENTION_RE = /(?:^|[^\w/])@([A-Za-z0-9_]{1,15})\b/g;

// Common cashtag false positives. Uppercase.
const TICKER_IGNORE = new Set<string>([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY',
  'NULL', 'TRUE', 'FALSE', 'NAN',
]);

export function extractEntities(text: string): Entities {
  const tickers = new Set<string>();
  const hashtags = new Set<string>();
  const mentions = new Set<string>();

  // Reset regex state since they're /g.
  TICKER_RE.lastIndex = 0;
  HASHTAG_RE.lastIndex = 0;
  MENTION_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = TICKER_RE.exec(text))) {
    const v = m[1];
    if (!TICKER_IGNORE.has(v)) tickers.add(v);
  }
  while ((m = HASHTAG_RE.exec(text))) {
    hashtags.add(m[1].toLowerCase());
  }
  while ((m = MENTION_RE.exec(text))) {
    mentions.add(m[1].toLowerCase());
  }

  return {
    tickers: [...tickers],
    hashtags: [...hashtags],
    mentions: [...mentions],
  };
}
