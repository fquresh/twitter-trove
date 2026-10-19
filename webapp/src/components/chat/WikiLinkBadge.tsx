import { useState } from 'react';
import { useChatStore } from '../../state/chatStore';
import { WikiDrawer } from './WikiDrawer';

interface Props {
  path: string;
}

// Renders [[wiki path]] citations. Clicking opens the drawer that fetches
// /wiki/read from the local wiki server (Phase 13). Gracefully degrades:
// if the server is off, the drawer shows an "offline" banner instead.
export function WikiLinkBadge({ path }: Props) {
  const wikiServerUrl = useChatStore((s) => s.wikiServerUrl);
  const [open, setOpen] = useState(false);
  const display = path.replace(/\.md$/, '');
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-200 md:min-h-0"
        title={`Open wiki page: ${display}`}
      >
        <span className="mr-1">📖</span>
        <span className="font-mono">{display}</span>
      </button>
      {open && (
        <WikiDrawer
          path={path}
          serverUrl={wikiServerUrl}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
