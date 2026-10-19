import { NavLink, useLocation } from 'react-router-dom';

interface Props {
  onMore: () => void;
}

const tabs = [
  { to: '/tweets', label: 'Tweets', icon: TweetsIcon },
  { to: '/dashboard', label: 'Dashboard', icon: DashboardIcon },
  { to: '/chat', label: 'Chat', icon: ChatIcon },
  { to: '/accounts', label: 'Accounts', icon: AccountsIcon },
];

export function MobileTabBar({ onMore }: Props) {
  const location = useLocation();
  const moreActive =
    location.pathname === '/articles' ||
    location.pathname === '/list-accounts' ||
    location.pathname === '/categories' ||
    location.pathname === '/import' ||
    location.pathname === '/settings';

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex min-h-16 items-stretch justify-around border-t border-canvas-300 bg-white/90 shadow-[0_-4px_24px_rgba(0,0,0,0.06)] backdrop-blur-xl md:hidden dark:border-white/10 dark:bg-ink-900/90"
      style={{
        // The bar floats above the home indicator; the shell reserves the
        // matching space. `--keyboard-height` lifts it above the iOS keyboard.
        bottom: 'calc(env(safe-area-inset-bottom) + var(--keyboard-height, 0px))',
      }}
      aria-label="Mobile navigation"
    >
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={{ pathname: t.to, search: location.search }}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
              isActive
                ? 'text-ios-blue dark:text-ios-teal'
                : 'text-ink-500 dark:text-ink-300'
            }`
          }
        >
          <t.icon className="h-6 w-6" />
          <span>{t.label}</span>
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onMore}
        className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
          moreActive
            ? 'text-ios-blue dark:text-ios-teal'
            : 'text-ink-500 dark:text-ink-300'
        }`}
      >
        <MoreIcon className="h-6 w-6" />
        <span>More</span>
      </button>
    </nav>
  );
}

function TweetsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function AccountsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}
