// Parser for the Python classifier's categorized_tweets.json output.
//
// Shape (observed):
// {
//   metadata: { total_tweets, files_processed, date_range, categories_discovered },
//   taxonomy: { "Path > Child": { count, percentage }, ... },
//   tweets: [
//     {
//       id, author, handle (includes @), text,
//       timestamp (human-readable),
//       source_file, urls, tickers,
//       media: { type, urls },
//       categories: ["Crypto > AI > Agents", ...],
//       engagement: {}
//     }, ...
//   ]
// }
//
// The one concession we make: classifier category names are stored in the DB
// verbatim as the full "Parent > Child > Grandchild" path. The UI can collapse
// by top-level.

export interface ClassifierTweet {
  id: string;
  categories: string[];
  // Full tweet content. categorized_tweets.json carries this, and it's the
  // ONLY source of tweet rows in cloud mode (no HTML files are served there).
  // Null/empty when absent (e.g. minimal test fixtures).
  author: string | null;
  handle: string | null;
  text: string | null;
  timestamp: string | null;
  images: string[];
  hasVideo: boolean;
  /** True/false when the classifier ran on extension v1.1+ exports; undefined
   * (JSON null) when the underlying exports predate article detection. */
  isArticle?: boolean;
  articleTitle?: string;
  likeCount: number;
  retweetCount: number;
}

export interface ParsedClassifier {
  tweets: ClassifierTweet[];
  /** All category names that appeared - used to upsert the category table. */
  categories: string[];
  errors: Array<{ index: number; reason: string }>;
}

export function parseClassifierJson(text: string): ParsedClassifier {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      tweets: [],
      categories: [],
      errors: [{ index: -1, reason: `Invalid JSON: ${(e as Error).message}` }],
    };
  }
  return parseClassifierObject(raw);
}

// Parse from an already-deserialized object - lets the sync path JSON.parse the
// payload once and route without a second parse.
export function parseClassifierObject(raw: unknown): ParsedClassifier {
  const outer = raw as Record<string, unknown>;
  const tweetsIn = Array.isArray(outer.tweets) ? (outer.tweets as unknown[]) : null;
  if (!tweetsIn) {
    return {
      tweets: [],
      categories: [],
      errors: [{ index: -1, reason: 'JSON lacks a "tweets" array' }],
    };
  }

  const tweets: ClassifierTweet[] = [];
  const categorySet = new Set<string>();
  const errors: ParsedClassifier['errors'] = [];

  for (let i = 0; i < tweetsIn.length; i++) {
    const item = tweetsIn[i] as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) {
      errors.push({ index: i, reason: 'missing id' });
      continue;
    }
    const cats = Array.isArray(item.categories)
      ? (item.categories as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    for (const c of cats) categorySet.add(c.trim());

    const media = (item.media ?? {}) as { type?: unknown; urls?: unknown };
    const mediaType = typeof media.type === 'string' ? media.type : 'none';
    const mediaUrls = Array.isArray(media.urls)
      ? (media.urls as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
    const eng = (item.engagement ?? {}) as { like_count?: unknown; retweet_count?: unknown };
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    tweets.push({
      id,
      categories: cats.map((c) => c.trim()),
      author: typeof item.author === 'string' ? item.author : null,
      handle: typeof item.handle === 'string' ? item.handle : null,
      text: typeof item.text === 'string' ? item.text : null,
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : null,
      images: mediaType === 'image' ? mediaUrls : [],
      hasVideo: mediaType === 'video',
      isArticle: typeof item.is_article === 'boolean' ? item.is_article : undefined,
      articleTitle:
        typeof item.article_title === 'string' && item.article_title !== ''
          ? item.article_title
          : undefined,
      likeCount: num(eng.like_count),
      retweetCount: num(eng.retweet_count),
    });
  }

  return { tweets, categories: Array.from(categorySet), errors };
}
