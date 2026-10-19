// Global keyboard navigation. Mounted once in Layout. Inert when the user is
// typing in an input or when ⌘K-style modifiers are present (those belong
// to the popup chat / browser shortcuts).
//
//   /         focus the search input on /tweets
//   g d       go to dashboard
//   g t       go to tweets
//   g c       go to categories
//   g k       go to chat (full)
//   g i       go to import
//   g s       go to settings
//   ?         show shortcut overlay
//   esc       close shortcut overlay

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const ROUTES: Record<string, string> = {
  d: '/dashboard',
  t: '/tweets',
  c: '/categories',
  k: '/chat',
  i: '/import',
  s: '/settings',
};

export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [helpOpen, setHelpOpen] = useState(false);
  const lastKey = useRef<{ key: string; at: number } | null>(null);

  const isTyping = (e: KeyboardEvent): boolean => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable === true;
  };

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        setHelpOpen(false);
        return;
      }
      if (isTyping(e)) return;

      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }

      if (e.key === '/') {
        // Focus the first visible search input on the page.
        e.preventDefault();
        const inp = document.querySelector<HTMLInputElement>(
          'input[placeholder*="Search" i], input[placeholder*="search" i]',
        );
        inp?.focus();
        return;
      }

      // Two-letter sequences starting with `g`.
      const now = performance.now();
      if (lastKey.current && lastKey.current.key === 'g' && now - lastKey.current.at < 800) {
        const target = ROUTES[e.key.toLowerCase()];
        lastKey.current = null;
        if (target) {
          e.preventDefault();
          navigate({ pathname: target, search: params.toString() });
        }
        return;
      }
      if (e.key === 'g') {
        lastKey.current = { key: 'g', at: now };
      } else {
        lastKey.current = null;
      }
    },
    [navigate, params],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  if (!helpOpen) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="card max-w-md p-5 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="label mb-2">Keyboard shortcuts</div>
        <ul className="space-y-1.5 text-ink-700 dark:text-ink-200">
          <Row k="⌘K" v="open the quick-chat popup" />
          <Row k="/" v="focus search" />
          <Row k="g d" v="go to dashboard" />
          <Row k="g t" v="go to tweets" />
          <Row k="g c" v="go to categories" />
          <Row k="g k" v="go to chat" />
          <Row k="g i" v="go to import" />
          <Row k="g s" v="go to settings" />
          <Row k="?" v="show this help" />
          <Row k="esc" v="close popups" />
        </ul>
        <div className="mt-3 text-xs text-ink-400">Press esc or click outside to dismiss.</div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-ink-500 dark:text-ink-300">{v}</span>
      <kbd className="rounded border border-canvas-300 bg-canvas-100 px-1.5 py-0.5 font-mono text-xs text-ink-800 dark:border-white/10 dark:bg-white/5 dark:text-ink-100">
        {k}
      </kbd>
    </li>
  );
}
