import type { AccountCount } from '../db/queries/analytics';
import { formatNumber } from '../lib/format';

interface Props {
  data: AccountCount[];
  onSelect: (handle: string) => void;
}

export function TopAccountsTable({ data, onSelect }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-full min-h-32 items-center justify-center text-sm text-ink-500 dark:text-ink-300">
        No accounts in this window.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-canvas-200 dark:border-white/5">
      <table className="w-full text-sm">
        <thead className="bg-canvas-100 text-[11px] uppercase tracking-[0.14em] text-ink-500 dark:bg-white/[0.03] dark:text-ink-300">
          <tr>
            <th className="px-3 py-2 text-left">Handle</th>
            <th className="px-3 py-2 text-right">Tweets</th>
            <th className="px-3 py-2 text-right">Avg ♥</th>
            <th className="px-3 py-2 text-right">Share</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr
              key={a.handle}
              className="cursor-pointer border-t border-canvas-200 hover:bg-canvas-100 dark:border-white/5 dark:hover:bg-white/[0.04]"
              onClick={() => onSelect(a.handle)}
            >
              <td className="px-3 py-2">
                <div className="font-medium text-ink-900 dark:text-ink-50">
                  {a.display_name ?? a.handle}
                </div>
                <a
                  href={`https://x.com/${a.handle.replace(/^@/, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-ink-500 hover:text-accent-600 hover:underline dark:text-ink-300 dark:hover:text-accent-400"
                  title="Open on x.com"
                >
                  @{a.handle.replace(/^@/, '')}
                </a>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-800 dark:text-ink-100">{a.count}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-800 dark:text-ink-100">{formatNumber(a.avg_likes)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-500 dark:text-ink-300">{a.pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
