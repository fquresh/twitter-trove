// Bottom-right launcher for the floating chat popup. Clicking opens the
// drawer; ⌘K (or ctrl+K) toggles from anywhere on the page. The pulse
// + cyan glow signal that this is a live AI surface.

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { usePopupChat } from '../../state/popupChatStore';

export function FloatingChatButton() {
  const open = usePopupChat((s) => s.open);
  const toggle = usePopupChat((s) => s.toggle);
  const onChatRoute = useLocation().pathname.startsWith('/chat');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        // On /chat the conversation is already open: put the caret in its
        // composer instead of opening a second chat panel over it.
        if (onChatRoute) {
          document.querySelector<HTMLTextAreaElement>('[data-chat-composer]')?.focus();
          return;
        }
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, onChatRoute]);

  // On /chat the full surface is already open; the launcher would only sit
  // on top of the composer's Send button. ⌘K keeps working there.
  if (open || onChatRoute) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      title="Open quick chat (⌘K)"
      style={{
        bottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        right: 'max(1.5rem, env(safe-area-inset-right))',
      }}
      className="fixed z-30 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_40px_-12px_rgba(124,58,237,0.55)] transition-all hover:scale-[1.03] hover:bg-accent-500 hover:shadow-[0_22px_44px_-10px_rgba(124,58,237,0.7)]"
    >
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-70" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
      </span>
      <span>Ask the agent</span>
      <kbd className="ml-1 rounded-md bg-white/15 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
        ⌘K
      </kbd>
    </button>
  );
}
