import { memo, useMemo, useState, useEffect } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useDb } from '../lib/dbContext';
import { setFavorite } from '../db/queries/tweets';
import { formatDateTime, formatNumber } from '../lib/format';
import { tweetUrl, tweetProfileUrl, articleUrl } from '../lib/tweetLinks';
import type { TweetRow } from '../db/queries/tweets';
import type { CategoryRow } from '../db/queries/categories';
import { paramsFromFilters } from '../filters/urlSync';
import type { FilterSet } from '../filters/types';
import { useAskAgent } from './chat/useAskAgent';

interface Props {
  tweet: TweetRow;
  categories: CategoryRow[];
  filters: FilterSet;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

function processText(text: string): Array<{ kind: 'text' | 'ticker' | 'hashtag'; v: string }> {
  const out: Array<{ kind: 'text' | 'ticker' | 'hashtag'; v: string }> = [];
  const re = /(\$[A-Z]{2,6}\b)|(#\w+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'text', v: text.slice(last, m.index) });
    if (m[1]) out.push({ kind: 'ticker', v: m[1] });
    else if (m[2]) out.push({ kind: 'hashtag', v: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', v: text.slice(last) });
  return out;
}

export const TweetCard = memo(function TweetCard({
  tweet,
  categories,
  filters,
  selected = false,
  onToggleSelect,
}: Props) {
  const handle = useDb();
  const queryClient = useQueryClient();
  const [, setParams] = useSearchParams();
  const askAgent = useAskAgent();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(tweetUrl(tweet));
      setCopied(true);
    } catch {
      // Fallback for contexts where the Clipboard API is unavailable.
    }
  };

  const images = useMemo<string[] | null>(() => {
    if (!tweet.image_urls) return null;
    try {
      const parsed = JSON.parse(tweet.image_urls);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  }, [tweet.image_urls]);

  const favMut = useMutation({
    mutationFn: async (v: boolean) => {
      setFavorite(handle.db, tweet.id, v);
      handle.markDirty();
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });

  const addAuthorFilter = () => {
    const next = { ...filters, authors: [...new Set([...filters.authors, tweet.author_handle])] };
    setParams(paramsFromFilters(next));
  };

  const addCategoryFilter = (name: string) => {
    const next = { ...filters, categories: [...new Set([...filters.categories, name])] };
    setParams(paramsFromFilters(next));
  };

  const addTickerFilter = (raw: string) => {
    const sym = raw.replace(/^\$/, '').toUpperCase();
    const next = { ...filters, tickers: [...new Set([...filters.tickers, sym])] };
    setParams(paramsFromFilters(next));
  };
  const addHashtagFilter = (raw: string) => {
    const tag = raw.replace(/^#/, '').toLowerCase();
    const next = { ...filters, hashtags: [...new Set([...filters.hashtags, tag])] };
    setParams(paramsFromFilters(next));
  };

  return (
    <article className="card relative flex flex-col gap-3 p-4">
      <header className="flex items-start gap-2">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(tweet.id)}
            className="mt-1 h-4 w-4 accent-accent-500"
            aria-label={`Select tweet by @${tweet.author_handle}`}
          />
        )}
        <div className="flex-1 min-w-0">
          <a
            href={tweetProfileUrl(tweet)}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-left text-sm font-semibold text-ink-900 hover:text-accent-600 dark:text-ink-50 dark:hover:text-accent-400"
            title="Open profile on x.com"
          >
            {tweet.author_display_name || tweet.author_handle}
          </a>
          <div className="text-xs text-ink-500 dark:text-ink-300">
            <a
              href={tweetProfileUrl(tweet)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-accent-600 hover:underline dark:hover:text-accent-400"
              title="Open profile on x.com"
            >
              @{tweet.author_handle.replace(/^@/, '')}
            </a>
            {' · '}{formatDateTime(tweet.created_at)}
          </div>
        </div>
        <button
          type="button"
          onClick={addAuthorFilter}
          title={`Filter by @${tweet.author_handle.replace(/^@/, '')}`}
          className="grid min-h-11 min-w-11 place-items-center text-ink-400 hover:text-accent-600 dark:text-ink-300 dark:hover:text-accent-400 md:min-h-0 md:min-w-0"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
        </button>
        <button
          type="button"
          title={tweet.is_favorite ? 'Unfavorite' : 'Favorite'}
          onClick={() => favMut.mutate(!tweet.is_favorite)}
          className="grid min-h-11 min-w-11 place-items-center text-lg text-ink-400 hover:text-accent-600 dark:text-ink-300 dark:hover:text-accent-400 md:min-h-0 md:min-w-0"
        >
          {tweet.is_favorite ? '★' : '☆'}
        </button>
      </header>

      {tweet.is_article === 1 && tweet.article_title && (
        <a
          href={articleUrl(tweet)}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-base font-semibold leading-snug text-ink-900 hover:text-accent-600 dark:text-ink-50 dark:hover:text-accent-400"
          title="Read article on x.com"
        >
          {tweet.article_title}
        </a>
      )}

      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-800 dark:text-ink-100">
        {processText(tweet.content).map((chunk, i) => {
          if (chunk.kind === 'text') return <span key={i}>{chunk.v}</span>;
          if (chunk.kind === 'ticker') return (
            <button
              key={i}
              type="button"
              onClick={() => addTickerFilter(chunk.v)}
              className="ticker cursor-pointer transition-colors hover:bg-accent-200 dark:hover:bg-accent-500/30"
              title={`Filter by ${chunk.v}`}
            >
              {chunk.v}
            </button>
          );
          return (
            <button
              key={i}
              type="button"
              onClick={() => addHashtagFilter(chunk.v)}
              className="hashtag cursor-pointer"
              title={`Filter by ${chunk.v}`}
            >
              {chunk.v}
            </button>
          );
        })}
      </div>

      {images && images.length > 0 && (
        <div
          className={`grid gap-1 overflow-hidden rounded-lg ${
            images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
          }`}
        >
          {images.slice(0, 4).map((url, i) => (
            <img
              key={i}
              src={url}
              alt=""
              loading="lazy"
              className="max-h-64 w-full object-cover"
            />
          ))}
        </div>
      )}

      {tweet.has_video === 1 && (
        <div className="inline-flex w-fit items-center gap-1 rounded-md bg-accent-100 px-2 py-0.5 text-xs text-accent-700 dark:bg-accent-500/20 dark:text-accent-300">
          ▶ video
        </div>
      )}

      {tweet.is_article === 1 && (
        <a
          href={articleUrl(tweet)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 rounded-md bg-accent-100 px-2 py-0.5 text-xs text-accent-700 hover:bg-accent-200 dark:bg-accent-500/20 dark:text-accent-300 dark:hover:bg-accent-500/30"
          title="Read the long-form article on x.com"
        >
          ▤ article
        </a>
      )}

      <footer className="flex flex-wrap items-center gap-2 text-xs text-ink-500 dark:text-ink-300">
        <span>❤ {formatNumber(tweet.like_count)}</span>
        <span>⟳ {formatNumber(tweet.retweet_count)}</span>
        {tweet.is_thread === 1 && <span>🧵 thread</span>}
        <button
          type="button"
          onClick={() =>
            askAgent(
              `What's the context behind this tweet by @${tweet.author_handle.replace(/^@/, '')}? [^${tweet.id}]\n\n> ${tweet.content.replace(/\n/g, ' ').slice(0, 200)}`,
            )
          }
          className="hidden rounded-full border border-accent-200 bg-accent-50 px-2 py-0.5 text-[11px] text-accent-700 hover:border-accent-400 hover:bg-accent-100 md:inline-flex dark:border-accent-500/30 dark:bg-accent-500/5 dark:text-accent-200 dark:hover:border-accent-400/60 dark:hover:bg-accent-500/15"
          title="Ask the agent about this tweet"
        >
          ✦ ask
        </button>
        <button
          type="button"
          onClick={() =>
            askAgent(
              `Find tweets similar to this one and explain the through-line:\n\n> ${tweet.content.replace(/\n/g, ' ').slice(0, 240)}`,
            )
          }
          className="hidden rounded-full border border-canvas-300 bg-white px-2 py-0.5 text-[11px] text-ink-700 hover:border-ink-400 md:inline-flex dark:border-white/10 dark:bg-white/5 dark:text-ink-200 dark:hover:border-white/20"
          title="Find similar tweets in the archive"
        >
          ↻ similar
        </button>
        <div className="ml-auto inline-flex items-center gap-2">
          <button
            type="button"
            onClick={copyLink}
            className={`inline-flex min-h-8 items-center text-ink-500 underline underline-offset-2 hover:text-accent-600 dark:text-ink-300 dark:hover:text-accent-400 ${
              copied ? 'text-emerald-600 dark:text-emerald-400' : ''
            }`}
            title="Copy tweet link to clipboard"
          >
            {copied ? 'Copied!' : 'Copy link'}
          </button>
          {tweet.link && (
            <a
              href={tweetUrl(tweet)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-8 items-center text-ink-500 underline underline-offset-2 hover:text-accent-600 dark:text-ink-300 dark:hover:text-accent-400"
            >
              open on X ↗
            </a>
          )}
        </div>
      </footer>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => addCategoryFilter(c.name)}
              className="inline-flex items-center gap-1 rounded-full border border-canvas-300 bg-white px-2 py-0.5 text-[10px] font-medium text-ink-700 hover:bg-canvas-150 dark:border-white/10 dark:bg-transparent dark:text-ink-100 dark:hover:bg-white/10"
              style={{ borderColor: c.color ? c.color + '55' : undefined }}
              title={c.source === 'manual' ? 'manual category' : 'classifier category'}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: c.color ?? '#64748b' }}
              />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </article>
  );
});
