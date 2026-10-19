// Shared tooltip used by every Recharts panel. Recharts' default tooltip
// renders `name : value` with a stray space before the colon and uses the
// dataKey verbatim as the label - both look amateurish at a glance. This
// custom content owns rendering so we can drop the colon, format numbers,
// and add a thin cyan accent so the tooltip reads as part of the same
// design language as the rest of the app.

import type { TooltipProps } from 'recharts';
import { formatBucket } from '../lib/format';

interface Options {
  /** Override the label entirely - used by TimeSeriesChart to localize buckets. */
  labelFormat?: (raw: string | number) => string;
  /** Map a series dataKey to a display label (e.g. count -> "tweets"). */
  seriesLabel?: (key: string) => string;
  /** Whether the label is a time bucket (so we can format YYYY-MM correctly). */
  bucketLabel?: boolean;
}

export function makeChartTooltip(opts: Options = {}) {
  return function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
    if (!active || !payload || payload.length === 0) return null;
    const display =
      opts.labelFormat?.(label as string)
        ?? (opts.bucketLabel ? formatBucket(label as string) : (label as string));
    return (
      <div
        className="rounded-xl border border-accent-200 bg-white/95 px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(124,58,237,0.35)] backdrop-blur dark:border-accent-500/30 dark:bg-ink-900/95 dark:shadow-[0_8px_24px_-4px_rgba(124,58,237,0.4)]"
        role="tooltip"
      >
        <div className="mb-1 font-semibold text-ink-900 dark:text-ink-50">{display}</div>
        <ul className="space-y-0.5">
          {payload.map((p, i) => {
            const key = String(p.dataKey ?? p.name ?? '');
            const labelText = opts.seriesLabel?.(key) ?? key;
            const v = typeof p.value === 'number' ? p.value.toLocaleString() : String(p.value ?? '');
            return (
              <li key={i} className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: (p.color as string) || '#7c3aed' }}
                />
                <span className="text-ink-500 dark:text-ink-300">{labelText}</span>
                <span className="ml-auto font-mono text-ink-900 tabular-nums dark:text-ink-50">
                  {v}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };
}
