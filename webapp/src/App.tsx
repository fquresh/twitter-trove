import { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';

// Routes are lazy-loaded so the initial bundle stays small.  Recharts and the
// chat agent loop are the heavy bits; both live in their own chunks now.
const ImportRoute = lazy(() =>
  import('./routes/ImportRoute').then((m) => ({ default: m.ImportRoute })),
);
const TweetsRoute = lazy(() =>
  import('./routes/TweetsRoute').then((m) => ({ default: m.TweetsRoute })),
);
const ArticlesRoute = lazy(() =>
  import('./routes/ArticlesRoute').then((m) => ({ default: m.ArticlesRoute })),
);
const DashboardRoute = lazy(() =>
  import('./routes/DashboardRoute').then((m) => ({ default: m.DashboardRoute })),
);
const AccountsRoute = lazy(() =>
  import('./routes/AccountsRoute').then((m) => ({ default: m.AccountsRoute })),
);
const ListAccountsRoute = lazy(() =>
  import('./routes/ListAccountsRoute').then((m) => ({ default: m.ListAccountsRoute })),
);
const CategoriesRoute = lazy(() =>
  import('./routes/CategoriesRoute').then((m) => ({ default: m.CategoriesRoute })),
);
const ChatRoute = lazy(() =>
  import('./routes/ChatRoute').then((m) => ({ default: m.ChatRoute })),
);
const SettingsRoute = lazy(() =>
  import('./routes/SettingsRoute').then((m) => ({ default: m.SettingsRoute })),
);
const NotFoundRoute = lazy(() =>
  import('./routes/NotFoundRoute').then((m) => ({ default: m.NotFoundRoute })),
);

function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-ink-400">
      Loading…
    </div>
  );
}

const wrap = (el: React.ReactNode) => (
  <Suspense fallback={<RouteFallback />}>{el}</Suspense>
);

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'import', element: wrap(<ImportRoute />) },
      { path: 'tweets', element: wrap(<TweetsRoute />) },
      { path: 'articles', element: wrap(<ArticlesRoute />) },
      { path: 'dashboard', element: wrap(<DashboardRoute />) },
      { path: 'accounts', element: wrap(<AccountsRoute />) },
      { path: 'list-accounts', element: wrap(<ListAccountsRoute />) },
      { path: 'categories', element: wrap(<CategoriesRoute />) },
      { path: 'chat', element: wrap(<ChatRoute />) },
      { path: 'settings', element: wrap(<SettingsRoute />) },
      // Anything else lands on a real screen instead of a blank <Outlet />.
      { path: '*', element: wrap(<NotFoundRoute />) },
    ],
  },
]);
