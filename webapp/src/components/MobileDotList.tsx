import { useMemo } from 'react';

interface Item {
  id: string;
  name: string;
  count: number;
  color?: string | null;
  pct?: number;
}

interface Props {
  title: string;
  data: Item[];
  total: number;
  onSelect: (name: string) => void;
}

const IOS_DOTS = [
  '#007aff',
  '#34c759',
  '#af52de',
  '#ff9500',
  '#ff2d55',
  '#5ac8fa',
  '#ffcc00',
  '#5856d6',
];

export function MobileDotList({ title, data, total, onSelect }: Props) {
  const rows = useMemo(() => {
    return data.map((d, i) => {
      const pct =
        d.pct !== undefined
          ? d.pct
          : total > 0
            ? Math.round((d.count / total) * 1000) / 10
            : 0;
      return { ...d, pct, color: d.color ?? IOS_DOTS[i % IOS_DOTS.length] };
    });
  }, [data, total]);

  if (rows.length === 0) {
    return (
      <div className="card flex min-h-32 items-center justify-center p-4 text-sm text-ink-400">
        No data for this window.
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        <span className="text-xs text-ink-400">{rows.length} shown</span>
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.name)}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-canvas-150/50 active:scale-[0.99] dark:hover:bg-white/5"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: r.color }}
              />
              <span className="flex-1 line-clamp-2 break-words text-sm font-medium text-ink-800 dark:text-ink-100">
                {r.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-ink-500 dark:text-ink-300">
                {r.count.toLocaleString()}
              </span>
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-400">
                {r.pct}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
