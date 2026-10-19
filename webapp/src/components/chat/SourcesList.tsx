// "Sources" footer under an assistant message: one numbered tweet card per
// cited [^tweetid], in citation order. The full tweet lives here (author,
// date, text, media, engagement) so the answer can be checked against what
// the archive actually says without leaving the conversation.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { useDb } from '../../lib/dbContext';
import { getTweetById, type TweetRow } from '../../db/queries/tweets';
import { formatDate, formatNumber } from '../../lib/format';
import { tweetUrl, tweetProfileUrl, articleUrl } from '../../lib/tweetLinks';
import { usePopupChat } from '../../state/popupChatStore';
import { useAskAgent } from './useAskAgent';
import { sourceDomId, type CitationIndex } from './citationContext';

const CLAMP_CHARS = 280;

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function parseImages(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function SourceCard({
  n,
  tweet,
  scope,
  compact,
}: {
  n: number;
  tweet: TweetRow;
  scope: string;
  /** Hide the "ask" action (the popup is already the chat). */
  compact?: boolean;
}) {
  const hidePopup = usePopupChat((s) => s.hide);
  const askAgent = useAskAgent();
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  const images = useMemo(() => parseImages(tweet.image_urls), [tweet.image_urls]);
  const clean = tweet.author_handle.replace(/^@/, '');
  const name = tweet.author_display_name || clean;
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const long = tweet.content.length > CLAMP_CHARS;
  const text = expanded || !long ? tweet.content : tweet.content.slice(0, CLAMP_CHARS).trimEnd() + '…';

  return (
    <article
      id={sourceDomId(scope, tweet.id)}
      className="chat-source flex min-w-0 flex-col gap-2 rounded-xl border border-canvas-200 bg-canvas-50/70 p-3 text-xs transition-colors dark:border-white/10 dark:bg-white/[0.03]"
    >
      <header className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-accent-500/15 text-[10px] font-bold tabular-nums text-accent-700 dark:text-accent-200">
          {n}
        </span>
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-500/20 text-[11px] font-bold text-accent-700 dark:text-accent-100">
          {initial}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <a
            href={tweetProfileUrl(tweet)}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-semibold text-ink-900 hover:text-accent-600 dark:text-ink-50 dark:hover:text-accent-300"
          >
            {name}
          </a>
          <div className="truncate text-[11px] text-ink-500 dark:text-ink-400">
            @{clean} · {formatDate(tweet.created_at)}
          </div>
        </div>
        <a
          href={tweetUrl(tweet)}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on X"
          aria-label={`Open tweet by @${clean} on X`}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-400 transition-colors hover:bg-accent-500/15 hover:text-accent-700 dark:hover:text-accent-100 md:h-6 md:w-6"
        >
          <XLogo />
        </a>
      </header>

      {tweet.is_article === 1 && tweet.article_title && (
        <a
          href={articleUrl(tweet)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold leading-snug text-ink-900 hover:text-accent-600 dark:text-ink-50 dark:hover:text-accent-300"
        >
          ▤ {tweet.article_title}
        </a>
      )}

      <p className="whitespace-pre-wrap break-words leading-relaxed text-ink-800 dark:text-ink-100">
        {text}
        {long && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-1 text-accent-600 hover:underline dark:text-accent-300"
          >
            {expanded ? 'less' : 'more'}
          </button>
        )}
      </p>

      {images.length > 0 && (
        <div className={`grid gap-1 overflow-hidden rounded-lg ${images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {images.slice(0, 2).map((url, i) => (
            <img key={i} src={url} alt="" loading="lazy" className="max-h-40 w-full object-cover" />
          ))}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500 dark:text-ink-400">
        <span>❤ {formatNumber(tweet.like_count)}</span>
        <span>⟳ {formatNumber(tweet.retweet_count)}</span>
        {tweet.has_video === 1 && <span>▶ video</span>}
        {tweet.is_thread === 1 && <span>🧵 thread</span>}
        <span className="ml-auto inline-flex items-center gap-3">
          {!compact && (
            <button
              type="button"
              onClick={() =>
                askAgent(
                  `What's the context behind this tweet by @${clean}? [^${tweet.id}]\n\n> ${tweet.content.replace(/\n/g, ' ').slice(0, 200)}`,
                )
              }
              className="text-accent-700 hover:underline dark:text-accent-300"
              title="Ask the agent about this tweet"
            >
              ✦ ask
            </button>
          )}
          <Link
            to={`/tweets?id=${tweet.id}`}
            // Remember where the reader came from so the Tweets page can offer
            // a "Back to chat" link instead of relying on browser history.
            state={{ from: location.pathname + location.search, fromLabel: 'chat' }}
            onClick={() => {
              if (compact) hidePopup();
            }}
            className="font-medium text-ink-700 underline decoration-ink-300 underline-offset-2 hover:text-accent-600 dark:text-ink-200 dark:decoration-white/20 dark:hover:text-accent-300"
            title="View this tweet in the archive"
          >
            View in archive
          </Link>
        </span>
      </footer>
    </article>
  );
}

export function SourcesList({
  index,
  compact,
}: {
  index: CitationIndex;
  compact?: boolean;
}) {
  const handle = useDb();
  const ids = useMemo(
    () => [...index.numbers.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id),
    [index.numbers],
  );
  const [open, setOpen] = useState(true);
  const q = useQuery({
    queryKey: ['chat-sources', ids.join(',')],
    enabled: ids.length > 0,
    queryFn: () => ids.map((id) => getTweetById(handle.db, id)),
    staleTime: 60_000,
  });

  if (ids.length === 0) return null;
  const rows = (q.data ?? []).filter((t): t is TweetRow => t !== null);
  const missing = ids.length - rows.length;

  return (
    <section className="mt-3 border-t border-canvas-200 pt-2 dark:border-white/10" data-sources-scope={index.scope}>
      <button
        type="button"
        data-sources-toggle
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between py-1 text-left"
      >
        <span className="label">
          Sources · {ids.length}
          {q.isSuccess && missing > 0 && (
            <span className="ml-1 normal-case tracking-normal text-amber-600 dark:text-amber-300">
              ({missing} not in archive)
            </span>
          )}
        </span>
        <span className="text-xs text-ink-400">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="mt-1 grid grid-cols-1 gap-2 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
          {rows.map((t) => (
            <SourceCard key={t.id} n={index.numbers.get(t.id) ?? 0} tweet={t} scope={index.scope} compact={compact} />
          ))}
        </div>
      )}
    </section>
  );
}
