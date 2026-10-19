// @vitest-environment node
//
// Persistence layer for chat sessions/messages. We exercise the queries
// against a real sql.js DB built up via applyMigrations, so this also
// catches any schema regression in MIGRATION_V2's chat tables.

import { describe, expect, it, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { applyMigrations } from '../db/sqlite';
import {
  appendMessage,
  createSession,
  deleteSession,
  getSession,
  listMessages,
  listSessions,
  messageCount,
  setSessionTitle,
} from '../db/queries/chat';
import { emptyFilterSet } from '../filters/types';

const WASM = resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  'sql.js',
  'dist',
  'sql-wasm.wasm',
);

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => WASM });
});

function freshDb(): Database {
  const db = new SQL.Database();
  applyMigrations(db);
  return db;
}

describe('chat persistence', () => {
  it('round-trips a session and its messages', () => {
    const db = freshDb();
    const sid = 'sess-1';
    createSession(db, sid, 'claude-haiku-4-5', emptyFilterSet());

    appendMessage(db, {
      session_id: sid,
      role: 'user',
      content: 'first question',
      retrieved_ids: ['t1', 't2'],
    });
    appendMessage(db, {
      session_id: sid,
      role: 'assistant',
      content: 'an answer with [^1234567890]',
      citations: ['1234567890'],
      retrieved_ids: ['t1', 't2'],
      tool_calls: [{ name: 'search_tweets', input: { query: 'q' }, output: { hits: [] } }],
      token_input: 200,
      token_output: 50,
    });

    const msgs = listMessages(db, sid);
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('first question');
    expect(msgs[1].role).toBe('assistant');
    expect(JSON.parse(msgs[1].citations_json!)).toEqual(['1234567890']);
    expect(msgs[1].token_input).toBe(200);
    expect(messageCount(db, sid)).toBe(2);
  });

  it('updates session.updated_at when a message is appended', () => {
    const db = freshDb();
    const sid = 'sess-2';
    const session = createSession(db, sid, 'claude-haiku-4-5', emptyFilterSet());
    const t0 = session.updated_at;
    // Sleep across a second boundary so the comparison is meaningful.
    const wait = Date.now() + 1100;
    while (Date.now() < wait) {/* spin */}
    appendMessage(db, { session_id: sid, role: 'user', content: 'hi' });
    const after = getSession(db, sid)!;
    expect(after.updated_at).toBeGreaterThan(t0);
  });

  it('lists sessions newest-first by updated_at', () => {
    const db = freshDb();
    createSession(db, 'a', 'm', emptyFilterSet());
    const wait = Date.now() + 1100;
    while (Date.now() < wait) {/* spin */}
    createSession(db, 'b', 'm', emptyFilterSet());
    const list = listSessions(db);
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('setSessionTitle persists the title', () => {
    const db = freshDb();
    createSession(db, 'sess-3', 'm', emptyFilterSet());
    setSessionTitle(db, 'sess-3', 'agentic search');
    expect(getSession(db, 'sess-3')!.title).toBe('agentic search');
  });

  it('deleteSession cascades to messages', () => {
    const db = freshDb();
    createSession(db, 'sess-4', 'm', emptyFilterSet());
    appendMessage(db, { session_id: 'sess-4', role: 'user', content: 'one' });
    appendMessage(db, { session_id: 'sess-4', role: 'assistant', content: 'two' });
    expect(messageCount(db, 'sess-4')).toBe(2);
    deleteSession(db, 'sess-4');
    expect(getSession(db, 'sess-4')).toBeNull();
    expect(messageCount(db, 'sess-4')).toBe(0);
  });
});
