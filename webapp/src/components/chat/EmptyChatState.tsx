// First-run panel for an empty conversation. Offers a few starter questions
// built from the archive itself (top authors and categories in the current
// filter scope) so the first click already exercises the agent's strengths.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDb } from '../../lib/dbContext';
import { topAccounts, categoryBreakdown } from '../../db/queries/analytics';
import type { FilterSet } from '../../filters/types';

interface Props {
  filters: FilterSet;
  onPick: (prompt: string) => void;
  disabled?: boolean;
  /** Fewer suggestions, tighter layout (popup). */
  compact?: boolean;
}

const STATIC_PROMPTS = [
  'What are the through-lines in what I have been liking lately?',
  'Which ideas keep coming back across different authors?',
  'Where do the authors I follow disagree with each other?',
];

export function buildSuggestions(
  authors: Array<{ handle: string }>,
  categories: Array<{ name: string }>,
  limit: number,
): string[] {
  const out: string[] = [];
  const a0 = authors[0]?.handle.replace(/^@/, '');
  const a1 = authors[1]?.handle.replace(/^@/, '');
  const c0 = categories[0]?.name;
  const c1 = categories[1]?.name;
  if (a0) out.push(`What does @${a0} keep coming back to, and how has it shifted over time?`);
  if (c0) out.push(`Summarize my position on ${c0}. Who shaped it most?`);
  if (a0 && a1) out.push(`Where do @${a0} and @${a1} agree, and where do they diverge?`);
  if (c1) out.push(`What changed in how I read ${c1} over the last year?`);
  for (const p of STATIC_PROMPTS) {
    if (out.length >= limit) break;
    out.push(p);
  }
  return out.slice(0, limit);
}

export function EmptyChatState({ filters, onPick, disabled, compact }: Props) {
  const handle = useDb();
  const q = useQuery({
    queryKey: ['chat-suggestions', filters],
    queryFn: () => ({
      authors: topAccounts(handle.db, filters, 3),
      categories: categoryBreakdown(handle.db, filters, 3),
    }),
    staleTime: 5 * 60_000,
  });
  const prompts = useMemo(
    () => buildSuggestions(q.data?.authors ?? [], q.data?.categories ?? [], compact ? 3 : 5),
    [q.data, compact],
  );

  return (
    <div className="rounded-2xl border border-dashed border-canvas-300 bg-canvas-100 p-5 dark:border-white/10 dark:bg-transparent">
      <p className="text-sm text-ink-700 dark:text-ink-200">
        Ask anything about your archive. Answers cite the tweets they draw on.
      </p>
      <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
        Filters on the Tweets page scope the search. Try one of these to start:
      </p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {prompts.map((p) => (
          <li key={p}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p)}
              className="w-full rounded-xl border border-canvas-200 bg-white px-3 py-2 text-left text-xs text-ink-800 transition-colors hover:border-accent-300 hover:bg-accent-50 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-ink-100 dark:hover:border-accent-500/40 dark:hover:bg-accent-500/10"
            >
              <span className="mr-1.5 text-accent-600 dark:text-accent-300" aria-hidden="true">
                ✦
              </span>
              {p}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
