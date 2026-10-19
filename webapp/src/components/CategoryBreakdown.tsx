import type { CategoryCount } from '../db/queries/analytics';

interface Props {
  data: CategoryCount[];
  onSelect: (name: string) => void;
}

export function CategoryBreakdown({ data, onSelect }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-full min-h-32 items-center justify-center text-sm text-ink-500 dark:text-ink-300">
        No categorized tweets in this window.
      </div>
    );
  }
  const max = Math.max(...data.map((d) => d.count));
  return (
    <ul className="space-y-1.5">
      {data.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onSelect(c.name)}
            className="group flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left hover:bg-canvas-150 dark:hover:bg-white/5"
          >
            <span className="flex-1 truncate text-xs text-ink-800 dark:text-ink-100">{c.name}</span>
            <span className="relative h-2 w-40 overflow-hidden rounded-full bg-canvas-200 dark:bg-white/5">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${(c.count / max) * 100}%`,
                  background: c.color ?? '#7c3aed',
                }}
              />
            </span>
            <span className="w-12 text-right text-xs tabular-nums text-ink-500 dark:text-ink-300">
              {c.count.toLocaleString()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
