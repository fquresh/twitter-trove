import { useSearchParams } from 'react-router-dom';
import type { FilterSet } from '../filters/types';
import { filtersFromParams, paramsFromFilters } from '../filters/urlSync';

interface ToggleProps {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  title: string;
}

function Toggle({ active, onClick, icon, label, title }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors md:min-h-0 ${
        active
          ? 'border-accent-400 bg-accent-100 text-accent-800 dark:border-accent-400/60 dark:bg-accent-500/20 dark:text-accent-100'
          : 'border-canvas-300 bg-white text-ink-700 hover:border-accent-300 hover:bg-accent-50 dark:border-white/10 dark:bg-white/5 dark:text-ink-200 dark:hover:bg-white/10'
      }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function FilterToolbar() {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);

  const mutate = (fn: (f: FilterSet) => FilterSet) => {
    setParams(paramsFromFilters(fn({ ...filters })));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Toggle
        active={filters.favorite}
        onClick={() => mutate((f) => ({ ...f, favorite: !f.favorite }))}
        icon="★"
        label="Favorites"
        title="Show only favorited tweets"
      />
      <Toggle
        active={filters.thread}
        onClick={() => mutate((f) => ({ ...f, thread: !f.thread }))}
        icon="🧵"
        label="Threads"
        title="Show only thread tweets"
      />
      <Toggle
        active={filters.article}
        onClick={() => mutate((f) => ({ ...f, article: !f.article }))}
        icon="▤"
        label="Articles"
        title="Show only X articles (long-form posts)"
      />
    </div>
  );
}
