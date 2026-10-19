export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-center">
      <div className="text-3xl">∅</div>
      <h3 className="text-base font-semibold text-ink-900 dark:text-ink-100">{title}</h3>
      {hint && <p className="text-sm text-ink-500 dark:text-ink-300">{hint}</p>}
    </div>
  );
}
