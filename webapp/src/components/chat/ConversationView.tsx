import type { ChatMessageRow } from '../../db/queries/chat';
import { MessageBubble } from './MessageBubble';
import { ToolSteps, toolLabel, type ToolCall } from './ToolSteps';
import { RetrievalInspector } from './RetrievalInspector';
import type { RetrievalHit } from '../../chat/retrievalCore';
import type { TurnPhase } from '../../chat/useChatTurn';

interface Props {
  messages: ChatMessageRow[];
  pendingUser?: string;
  pendingAssistant?: string;
  pendingPhase?: TurnPhase | null;
  pendingHits?: RetrievalHit[];
  pendingToolCalls?: ToolCall[];
  pendingElapsedMs?: number;
  /** Compact sources (no "ask" action) - used by the popup. */
  compact?: boolean;
}

export function phaseLabel(phase: TurnPhase): string {
  switch (phase.kind) {
    case 'embedding':
      return 'Embedding your question…';
    case 'searching':
      return 'Searching the archive…';
    case 'thinking':
      return phase.round > 1 ? `Thinking (round ${phase.round})…` : 'Thinking…';
    case 'reasoning':
      return phase.round > 1 ? `Reasoning (round ${phase.round})…` : 'Reasoning…';
    case 'tool':
      return `${toolLabel(phase.name)}…`;
    case 'writing':
      return 'Writing…';
  }
}

function StatusLine({ phase }: { phase: TurnPhase }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-1 text-xs text-ink-500 dark:text-ink-400"
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-500" />
      </span>
      <span>{phaseLabel(phase)}</span>
    </div>
  );
}

/**
 * True once the in-flight question already exists as the last persisted row.
 * useChatTurn writes the user row mid-turn and refetches, so for the rest of
 * the turn the same question would render twice (persisted + optimistic).
 */
export function isPendingUserPersisted(
  messages: ReadonlyArray<{ role: string; content: string }>,
  pendingUser: string | undefined,
): boolean {
  if (!pendingUser) return false;
  const last = messages[messages.length - 1];
  return !!last && last.role === 'user' && last.content === pendingUser;
}

export function ConversationView({
  messages,
  pendingUser,
  pendingAssistant,
  pendingPhase,
  pendingHits,
  pendingToolCalls,
  pendingElapsedMs,
  compact,
}: Props) {
  const hasPendingText = (pendingAssistant ?? '').length > 0;
  const showStatus = !!pendingPhase && pendingPhase.kind !== 'writing';
  const pendingCalls = pendingToolCalls ?? [];

  return (
    <div className="flex flex-col gap-3">
      {messages.map((m) => {
        const toolCalls = m.tool_calls_json ? safeParse<ToolCall[]>(m.tool_calls_json) : null;
        return (
          <div key={m.id} className="space-y-1.5">
            {m.role === 'assistant' && toolCalls && toolCalls.length > 0 && (
              <ToolSteps calls={toolCalls} />
            )}
            <MessageBubble
              role={m.role === 'tool' ? 'tool' : (m.role as 'user' | 'assistant')}
              content={m.content}
              scope={String(m.id)}
              compact={compact}
              meta={{
                createdAt: m.created_at,
                tokenInput: m.token_input,
                tokenOutput: m.token_output,
              }}
            />
          </div>
        );
      })}

      {pendingUser && (
        <div className="space-y-1.5">
          {!isPendingUserPersisted(messages, pendingUser) && (
            <MessageBubble role="user" content={pendingUser} />
          )}
          {pendingHits && pendingHits.length > 0 && (
            <RetrievalInspector hits={pendingHits} elapsedMs={pendingElapsedMs} />
          )}
        </div>
      )}

      {(pendingPhase || hasPendingText || pendingCalls.length > 0) && (
        <div className="space-y-1.5">
          {pendingCalls.length > 0 && <ToolSteps calls={pendingCalls} live />}
          {hasPendingText && <MessageBubble role="assistant" content={pendingAssistant ?? ''} pending compact={compact} />}
          {showStatus && pendingPhase && <StatusLine phase={pendingPhase} />}
        </div>
      )}
    </div>
  );
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
