// Regression: the "You" bubble rendered twice mid-turn, because useChatTurn
// persists the user row (and refetches) while pendingUser is still set.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationView, isPendingUserPersisted } from '../components/chat/ConversationView';
import type { ChatMessageRow } from '../db/queries/chat';

const row = (id: number, role: string, content: string) =>
  ({ id, session_id: 's', role, content, created_at: 1, tool_calls_json: null }) as unknown as ChatMessageRow;

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('ConversationView pending user bubble', () => {
  const q = 'what did ada_fieldstone say about agents?';

  it('shows the question once before it is persisted', () => {
    const html = renderToStaticMarkup(<ConversationView messages={[]} pendingUser={q} pendingPhase={{ kind: 'searching' }} />);
    expect(count(html, q)).toBe(1);
  });

  it('shows the question once while the persisted row and pendingUser coexist', () => {
    const html = renderToStaticMarkup(
      <ConversationView messages={[row(1, 'user', q)]} pendingUser={q} pendingPhase={{ kind: 'thinking', round: 1 }} />,
    );
    expect(count(html, q)).toBe(1);
  });

  it('still shows a repeated question when the last row is the assistant answer', () => {
    const msgs = [row(1, 'user', q), row(2, 'assistant', 'a')];
    expect(isPendingUserPersisted(msgs, q)).toBe(false);
  });
});
