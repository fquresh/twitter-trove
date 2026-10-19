import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatNumber } from '../lib/format';
import { articleUrl, tweetProfileUrl } from '../lib/tweetLinks';
import type { TweetRow } from '../db/queries/tweets';

// Card for the /articles section: title-forward, since article posts have no
// tweet text - the article title and cover image ARE the content. Actions are
// deliberately minimal (read on X, jump to the full TweetCard via the
// /tweets?id= pin); favoriting/notes live on the main list.
export const ArticleCard = memo(function ArticleCard({ tweet }: { tweet: TweetRow }) {
  const cover = useMemo<string | null>(() => {
    if (!tweet.image_urls) return null;
    try {
      const parsed = JSON.parse(tweet.image_urls);
      return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
    } catch {
      return null;
    }
  }, [tweet.image_urls]);

  const handle = tweet.author_handle.replace(/^@/, '');

  return (
    <article className="card flex flex-col gap-3 p-4">
      {cover && (
        <a
          href={articleUrl(tweet)}
          target="_blank"
          rel="noopener noreferrer"
          className="-mx-4 -mt-4 block overflow-hidden rounded-t-lg"
          title="Read article on x.com"
        >
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="max-h-48 w-full object-cover transition-transform hover:scale-[1.02]"
          />
        </a>
      )}

      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold leading-snug text-ink-900 dark:text-ink-50">
          <a
            href={articleUrl(tweet)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-accent-600 dark:hover:text-accent-400"
            title="Read article on x.com"
          >
            {tweet.article_title || 'Untitled article'}
          </a>
        </h2>
        <span className="inline-flex w-fit shrink-0 items-center gap-1 rounded-md bg-accent-100 px-2 py-0.5 text-xs text-accent-700 dark:bg-accent-500/20 dark:text-accent-300">
          ▤ article
        </span>
      </div>

      <div className="text-xs text-ink-500 dark:text-ink-300">
        <a
          href={tweetProfileUrl(tweet)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-ink-700 hover:text-accent-600 dark:text-ink-200 dark:hover:text-accent-400"
          title="Open profile on x.com"
        >
          {tweet.author_display_name || handle}
        </a>
        {' · '}@{handle}
        {' · '}{formatDateTime(tweet.created_at)}
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-2 text-xs text-ink-500 dark:text-ink-300">
        <span>❤ {formatNumber(tweet.like_count)}</span>
        <span>⟳ {formatNumber(tweet.retweet_count)}</span>
        <div className="ml-auto inline-flex items-center gap-3">
          <Link
            to={`/tweets?id=${tweet.id}`}
            className="inline-flex min-h-8 items-center text-ink-500 underline underline-offset-2 hover:text-accent-600 dark:text-ink-300 dark:hover:text-accent-400"
            title="Open the post in the Tweets view"
          >
            view post
          </Link>
          <a
            href={articleUrl(tweet)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-8 items-center text-ink-500 underline underline-offset-2 hover:text-accent-600 dark:text-ink-300 dark:hover:text-accent-400"
          >
            read on X ↗
          </a>
        </div>
      </footer>
    </article>
  );
});
