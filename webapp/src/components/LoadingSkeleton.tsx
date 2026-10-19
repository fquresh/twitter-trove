// Loading placeholders. The fill is theme-aware: a translucent white reads as
// nothing on the light surface, which is the default theme.
export function LoadingSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card h-40 animate-pulse bg-canvas-200/80 dark:bg-white/[0.03]" />
      ))}
    </div>
  );
}

/** Row-shaped placeholder for list panes, so the loaded layout does not jump. */
export function RowSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="card flex h-14 animate-pulse items-center gap-3 bg-canvas-200/80 px-4 dark:bg-white/[0.03]"
        >
          <div className="h-4 w-40 rounded-full bg-canvas-300 dark:bg-white/10" />
          <div className="h-4 w-16 rounded-full bg-canvas-300 dark:bg-white/10" />
        </div>
      ))}
    </div>
  );
}

export function BarSkeleton() {
  return <div className="h-64 w-full animate-pulse rounded-xl bg-canvas-200/80 dark:bg-white/[0.03]" />;
}
