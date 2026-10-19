// Inline footnote marker rendered where the assistant writes [^tweetid].
//
// Reads like a citation ("[2] @jhalvorsen"), and clicking it scrolls to the
// matching card in the message's Sources list and flashes it. The card is
// where the full tweet, the in-app link, and the open-on-X link live; the
// chip stays small so it does not break the flow of the prose.

import { useQuery } from '@tanstack/react-query';
import { useDb } from '../../lib/dbContext';
import { getTweetById } from '../../db/queries/tweets';
import { sourceDomId, useCitationIndex } from './citationContext';

export function flashSource(scope: string, tweetId: string): void {
  const el = document.getElementById(sourceDomId(scope, tweetId));
  if (!el) {
    // The reader collapsed this message's Sources list, so the card is not in
    // the DOM. Re-open it, then scroll to the card the chip points at.
    const toggle = document.querySelector<HTMLButtonElement>(
      `[data-sources-scope="${scope}"] [data-sources-toggle]`,
    );
    if (!toggle) return;
    toggle.click();
    requestAnimationFrame(() => {
      const card = document.getElementById(sourceDomId(scope, tweetId));
      if (card) flashSource(scope, tweetId);
    });
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el.classList.add('chat-source-flash');
  window.setTimeout(() => el.classList.remove('chat-source-flash'), 1600);
}

export function CitationChip({ tweetId }: { tweetId: string }) {
  const handle = useDb();
  const { scope, numbers } = useCitationIndex();
  const n = numbers.get(tweetId);
  const q = useQuery({
    queryKey: ['tweet-by-id', tweetId],
    queryFn: () => getTweetById(handle.db, tweetId),
    staleTime: 60_000,
  });

  const t = q.data;
  const clean = t ? t.author_handle.replace(/^@/, '') : null;

  if (!q.isLoading && !t) {
    // Not in the local archive: the model may have cited an id from a tool
    // result that was since deleted, or hallucinated. Still offer X.
    return (
      <a
        href={`https://x.com/i/web/status/${tweetId}`}
        target="_blank"
        rel="noopener noreferrer"
        title={`Tweet ${tweetId} is not in your archive. Open it on X.`}
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-px align-baseline text-[11px] font-medium leading-tight text-amber-700 no-underline hover:bg-amber-500/20 dark:text-amber-300"
      >
        {n ? `[${n}]` : '[?]'} not in archive
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => flashSource(scope, tweetId)}
      title={t ? `@${clean}: ${t.content.slice(0, 160)}` : 'Loading…'}
      aria-label={t ? `Source ${n ?? ''}: tweet by @${clean}` : 'Loading source'}
      className="mx-0.5 inline-flex max-w-[11rem] items-center gap-1 rounded-md border border-accent-500/30 bg-accent-500/[0.08] px-1.5 py-px align-baseline text-[11px] font-medium leading-tight text-accent-700 transition-colors hover:border-accent-500/60 hover:bg-accent-500/[0.16] dark:text-accent-200"
    >
      <span className="tabular-nums">[{n ?? '·'}]</span>
      {clean && <span className="truncate">@{clean}</span>}
    </button>
  );
}
