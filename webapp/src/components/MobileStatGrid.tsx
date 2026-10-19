import type { TweetStats } from '../db/queries/analytics';

interface Props {
  stats: TweetStats | undefined;
  timeFieldLabel: string;
}

export function MobileStatGrid({ stats, timeFieldLabel }: Props) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-28 animate-pulse bg-canvas-200/80 dark:bg-white/[0.03]" />
        ))}
      </div>
    );
  }

  const cards = [
    { label: 'Total tweets', value: stats.total, color: 'bg-ios-blue' },
    { label: `This month (${timeFieldLabel})`, value: stats.thisMonth, color: 'bg-ios-green' },
    { label: 'Favorites', value: stats.favorites, color: 'bg-ios-pink' },
    { label: 'Accounts', value: stats.authors, color: 'bg-ios-purple' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="card flex flex-col justify-between p-4"
        >
          <div className="text-xs font-medium text-ink-400 dark:text-ink-300">{c.label}</div>
          <div className="text-2xl font-bold tracking-tight text-ink-900 dark:text-white">
            {c.value.toLocaleString()}
          </div>
          <div className={`h-1.5 w-8 rounded-full ${c.color}`} />
        </div>
      ))}
    </div>
  );
}
