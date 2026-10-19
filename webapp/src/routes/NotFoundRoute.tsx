// Catch-all for unknown URLs. Without it an unmatched path rendered the Layout
// with an empty <Outlet /> - a blank page with no way back.
import { Link, useLocation } from 'react-router-dom';

export function NotFoundRoute() {
  const { pathname } = useLocation();
  return (
    <div className="card mx-auto flex max-w-lg flex-col items-center gap-3 p-10 text-center">
      <div className="text-3xl">🧭</div>
      <h1 className="h-display">Nothing here</h1>
      <p className="text-sm text-ink-500 dark:text-ink-300">
        <span className="font-mono">{pathname}</span> is not a page in this archive.
      </p>
      <div className="mt-1 flex gap-2">
        <Link to="/dashboard" className="btn-primary">
          Dashboard
        </Link>
        <Link to="/tweets" className="btn-outline">
          Tweets
        </Link>
      </div>
    </div>
  );
}
