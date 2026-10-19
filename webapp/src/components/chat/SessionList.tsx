import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDb } from '../../lib/dbContext';
import { listSessions, deleteSession } from '../../db/queries/chat';

interface Props {
  activeId: string | null;
  onNew: () => void;
}

export function SessionList({ activeId, onNew }: Props) {
  const handle = useDb();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sessions = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: () => listSessions(handle.db),
  });

  const onDelete = async (id: string) => {
    if (!confirm('Delete this conversation?')) return;
    deleteSession(handle.db, id);
    handle.markDirty();
    await handle.flush();
    void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
    // Deleting the conversation on screen would otherwise leave ?s=<dead id>
    // in the URL, and the next message would be written to a session row that
    // no longer exists.
    if (activeId === id) {
      const next = new URLSearchParams(params);
      next.delete('s');
      navigate({ pathname: '/chat', search: next.toString() }, { replace: true });
    }
  };

  return (
    <aside className="card flex flex-col gap-2 p-3 text-sm">
      <button type="button" className="btn-outline" onClick={onNew}>
        + New conversation
      </button>
      {sessions.data && sessions.data.length === 0 && (
        <p className="px-1 text-xs text-ink-400">No saved conversations.</p>
      )}
      {sessions.data?.map((s) => {
        const params2 = new URLSearchParams(params);
        params2.set('s', s.id);
        return (
          <div
            key={s.id}
            className={`group rounded-md px-2 py-2 ${
              activeId === s.id
                ? 'bg-accent-100 text-accent-900 dark:bg-accent-500/15 dark:text-accent-200'
                : 'text-ink-700 hover:bg-canvas-100 dark:text-ink-200 dark:hover:bg-white/5'
            }`}
          >
            <Link to={`/chat?${params2.toString()}`} className="block">
              <div className="truncate text-sm">{s.title ?? '(untitled)'}</div>
              <div className="text-[0.65rem] text-ink-500 dark:text-ink-400">
                {new Date(s.updated_at * 1000).toLocaleDateString()}
              </div>
            </Link>
            <button
              type="button"
              className="text-[0.65rem] text-red-600 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 dark:text-red-400"
              onClick={() => void onDelete(s.id)}
            >
              delete
            </button>
          </div>
        );
      })}
    </aside>
  );
}
