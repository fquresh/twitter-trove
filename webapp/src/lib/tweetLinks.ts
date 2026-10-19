import type { TweetRow } from '../db/queries/tweets';

export function tweetProfileUrl(t: TweetRow): string {
  const handle = t.author_handle.replace(/^@/, '');
  return `https://x.com/${handle}`;
}

/** Returns the URL only when it parses and uses http(s); otherwise null. Guards
 *  against `javascript:` / `data:` links smuggled in through a crafted export. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function tweetUrl(t: TweetRow): string {
  return (
    safeHttpUrl(t.link) ??
    `https://x.com/${encodeURIComponent(t.author_handle.replace(/^@/, ''))}/status/${encodeURIComponent(t.id)}`
  );
}

/** X long-form articles share the post's numeric id under the /article/ path. */
export function articleUrl(t: Pick<TweetRow, 'id' | 'author_handle'>): string {
  return `https://x.com/${t.author_handle.replace(/^@/, '')}/article/${t.id}`;
}
