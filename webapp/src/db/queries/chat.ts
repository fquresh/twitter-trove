// chat_sessions / chat_messages queries. Persistence-only - the agent loop
// itself doesn't touch this; ChatRoute calls these after each completed turn.

import type { Database } from 'sql.js';
import { all, get, run, scalar } from '../exec';
import type { FilterSet } from '../../filters/types';

export interface ChatSessionRow {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  model: string | null;
  filters_json: string | null;
}

export interface ChatMessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  citations_json: string | null;
  retrieved_ids_json: string | null;
  tool_calls_json: string | null;
  created_at: number;
  token_input: number | null;
  token_output: number | null;
}

export function createSession(
  db: Database,
  id: string,
  model: string,
  filters: FilterSet,
  title: string | null = null,
): ChatSessionRow {
  const now = Math.floor(Date.now() / 1000);
  run(
    db,
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, model, filters_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, title, now, now, model, JSON.stringify(filters)],
  );
  return {
    id,
    title,
    created_at: now,
    updated_at: now,
    model,
    filters_json: JSON.stringify(filters),
  };
}

export function listSessions(db: Database, limit = 100): ChatSessionRow[] {
  return all<ChatSessionRow>(
    db,
    `SELECT id, title, created_at, updated_at, model, filters_json
     FROM chat_sessions
     ORDER BY updated_at DESC
     LIMIT ?`,
    [limit],
  );
}

export function getSession(db: Database, id: string): ChatSessionRow | null {
  return get<ChatSessionRow>(
    db,
    `SELECT id, title, created_at, updated_at, model, filters_json
     FROM chat_sessions WHERE id = ?`,
    [id],
  );
}

export function deleteSession(db: Database, id: string): void {
  run(db, `DELETE FROM chat_sessions WHERE id = ?`, [id]);
}

export function setSessionTitle(db: Database, id: string, title: string): void {
  const now = Math.floor(Date.now() / 1000);
  run(db, `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`, [title, now, id]);
}

export interface AppendMessageInput {
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  citations?: string[];
  retrieved_ids?: string[];
  tool_calls?: Array<{ name: string; input: unknown; output: unknown }>;
  token_input?: number;
  token_output?: number;
}

export function appendMessage(db: Database, m: AppendMessageInput): number {
  const now = Math.floor(Date.now() / 1000);
  run(
    db,
    `INSERT INTO chat_messages
       (session_id, role, content, citations_json, retrieved_ids_json,
        tool_calls_json, created_at, token_input, token_output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.session_id,
      m.role,
      m.content,
      m.citations ? JSON.stringify(m.citations) : null,
      m.retrieved_ids ? JSON.stringify(m.retrieved_ids) : null,
      m.tool_calls ? JSON.stringify(m.tool_calls) : null,
      now,
      m.token_input ?? null,
      m.token_output ?? null,
    ],
  );
  run(db, `UPDATE chat_sessions SET updated_at = ? WHERE id = ?`, [now, m.session_id]);
  const id = scalar<number>(db, 'SELECT last_insert_rowid()') ?? 0;
  return id;
}

export function listMessages(db: Database, sessionId: string): ChatMessageRow[] {
  return all<ChatMessageRow>(
    db,
    `SELECT id, session_id, role, content, citations_json, retrieved_ids_json,
            tool_calls_json, created_at, token_input, token_output
     FROM chat_messages
     WHERE session_id = ?
     ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
}

export function messageCount(db: Database, sessionId: string): number {
  return scalar<number>(db, `SELECT COUNT(*) FROM chat_messages WHERE session_id = ?`, [sessionId]) ?? 0;
}
