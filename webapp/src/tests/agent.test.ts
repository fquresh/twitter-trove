// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../db/sqlite';
import { runTurn, type AgentClient, type AgentEvent } from '../chat/agent';
import type { ToolEnv } from '../chat/tools';
import { emptyFilterSet } from '../filters/types';
import type { RetrievalHit } from '../chat/retrievalCore';

const __dirname = dirname(fileURLToPath(import.meta.url));
let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({
    locateFile: () =>
      resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
});

function freshDb(): Database {
  const db = new SQL.Database();
  applyMigrations(db);
  return db;
}

function insertTweet(db: Database, id: string, handle = 'alice', text = 'tweet text'): void {
  db.exec(`
    INSERT INTO tweets (id, author_handle, content, like_count, created_at, imported_at)
    VALUES ('${id}', '${handle}', '${text}', 100, 1700000000, 1700000000);
  `);
}

// Builds a fake Anthropic client that returns scripted message responses.
// Each script entry is one round; the dispatcher walks them in order.
function fakeClient(scripts: Array<{ content: any[]; stop_reason: string; usage?: { input: number; output: number } }>): AgentClient {
  let i = 0;
  return {
    messages: {
      async create() {
        const s = scripts[i++];
        if (!s) throw new Error('fakeClient script exhausted');
        return {
          content: s.content,
          stop_reason: s.stop_reason,
          usage: { input_tokens: s.usage?.input ?? 100, output_tokens: s.usage?.output ?? 50 },
        };
      },
    },
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function makeEnv(db: Database, hits: RetrievalHit[] = []): ToolEnv {
  return {
    db,
    baseFilters: emptyFilterSet(),
    searchHandler: async () => hits,
  };
}

describe('runTurn (no tools)', () => {
  it('emits text deltas and a turn_complete with finalText', async () => {
    const db = freshDb();
    insertTweet(db, '1');
    const client = fakeClient([
      {
        content: [{ type: 'text', text: 'I see one tweet [^1] in the archive.' }],
        stop_reason: 'end_turn',
      },
    ]);
    const events = await collectEvents(
      runTurn(
        {
          client,
          toolEnv: makeEnv(db, [
            { tweetId: '1', ftsRank: null, vecRank: 1, fusedScore: 0.5, hasUrlEnrich: false, hasImgEnrich: false },
          ]),
          model: 'claude-sonnet-4-6',
          systemPrompt: 'sys',
          wikiEnabled: false,
        },
        {
          userInput: 'How many tweets do I have?',
          priorMessages: [],
          prefetchedHits: [
            { tweetId: '1', ftsRank: null, vecRank: 1, fusedScore: 0.5, hasUrlEnrich: false, hasImgEnrich: false },
          ],
        },
      ),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('context');
    expect(types).toContain('text_delta');
    expect(types).toContain('turn_complete');
    const turnComplete = events.find((e) => e.type === 'turn_complete')!;
    expect(turnComplete.finalText).toContain('I see one tweet [^1]');
    expect(turnComplete.toolCalls).toEqual([]);
    expect(turnComplete.usage?.input).toBe(100);
    db.close();
  });
});

describe('runTurn (with tool round-trip)', () => {
  it('dispatches a tool, feeds tool_result back, completes', async () => {
    const db = freshDb();
    insertTweet(db, '1', 'alice', 'btc on chain');
    insertTweet(db, '2', 'bob', 'eth gas spike');

    const client = fakeClient([
      // Round 1: model asks for count_tweets
      {
        content: [
          { type: 'text', text: 'Let me count first.' },
          { type: 'tool_use', id: 'tu_1', name: 'count_tweets', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      // Round 2: model gets tool_result, emits final text
      {
        content: [{ type: 'text', text: 'You have 2 tweets in the archive.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const events = await collectEvents(
      runTurn(
        {
          client,
          toolEnv: makeEnv(db),
          model: 'claude-sonnet-4-6',
          systemPrompt: 'sys',
          wikiEnabled: false,
        },
        {
          userInput: 'How many tweets total?',
          priorMessages: [],
          prefetchedHits: [],
        },
      ),
    );

    const toolUse = events.find((e) => e.type === 'tool_use');
    const toolResult = events.find((e) => e.type === 'tool_result');
    const turnComplete = events.find((e) => e.type === 'turn_complete')!;
    expect(toolUse?.tool?.name).toBe('count_tweets');
    expect(toolResult?.tool?.name).toBe('count_tweets');
    expect((toolResult?.result as { count: number })?.count).toBe(2);
    expect(turnComplete.finalText).toContain('2 tweets');
    expect(turnComplete.toolCalls).toHaveLength(1);
    expect(turnComplete.toolCalls?.[0]?.name).toBe('count_tweets');
    db.close();
  });
});

describe('runTurn - tool round cap', () => {
  it('forces convergence on the final round when the model keeps calling tools', async () => {
    const db = freshDb();
    // Script the upper bound (12 rounds - see MAX_TOOL_ROUNDS in agent.ts).
    // Rounds 0..10 ask for a tool every time; round 11 mixes a text answer in
    // alongside one final stray tool_use. The agent should converge on the
    // text and emit turn_complete without an error event, since round 11 is
    // forced text-only in production (no tools defined in the request).
    const scripts = [
      ...Array.from({ length: 11 }, () => ({
        content: [{ type: 'tool_use', id: 'tu_x', name: 'count_tweets', input: {} }],
        stop_reason: 'tool_use',
      })),
      {
        content: [
          { type: 'text', text: 'Forced answer on final round.' },
          { type: 'tool_use', id: 'tu_last', name: 'count_tweets', input: {} },
        ],
        stop_reason: 'tool_use',
      },
    ];
    const client = fakeClient(scripts);

    const events = await collectEvents(
      runTurn(
        {
          client,
          toolEnv: makeEnv(db),
          model: 'deepseek/deepseek-v4-pro',
          systemPrompt: 'sys',
          wikiEnabled: false,
        },
        {
          userInput: 'loop forever',
          priorMessages: [],
          prefetchedHits: [],
        },
      ),
    );

    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeUndefined();
    const turnComplete = events.find((e) => e.type === 'turn_complete');
    expect(turnComplete?.finalText).toContain('Forced answer on final round');
    db.close();
  });
});

describe('runTurn - wiki-disabled tool fallback', () => {
  it("returns wiki_unreachable when the agent calls a wiki tool but env.wiki is undefined", async () => {
    const db = freshDb();
    const client = fakeClient([
      {
        content: [{ type: 'tool_use', id: 'tu_w', name: 'list_wiki_pages', input: { category: 'concepts' } }],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'wiki server appears to be off, falling back to SQL.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const events = await collectEvents(
      runTurn(
        {
          client,
          toolEnv: makeEnv(db),
          model: 'claude-sonnet-4-6',
          systemPrompt: 'sys',
          wikiEnabled: true,
        },
        {
          userInput: 'what do I think about agents?',
          priorMessages: [],
          prefetchedHits: [],
        },
      ),
    );

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect((toolResult?.result as { error: string })?.error).toBe('wiki_unreachable');
    db.close();
  });
});

describe('runTurn (streaming client)', () => {
  it('relays onDelta chunks as text_delta events in order and does not duplicate the final text', async () => {
    const db = freshDb();
    const client: AgentClient = {
      messages: {
        async create(params: Record<string, unknown>) {
          const onDelta = params.onDelta as (d: { kind: string; text: string }) => void;
          onDelta({ kind: 'reasoning', text: 'let me think' });
          onDelta({ kind: 'text', text: 'Hel' });
          onDelta({ kind: 'text', text: 'lo' });
          return {
            content: [{ type: 'text', text: 'Hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    const events = await collectEvents(
      runTurn(
        { client, toolEnv: makeEnv(db), model: 'm', systemPrompt: 's', wikiEnabled: false },
        { userInput: 'hi', priorMessages: [], prefetchedHits: [] },
      ),
    );
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.status?.phase);
    expect(statuses).toEqual(['thinking', 'reasoning']);
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.text);
    expect(deltas).toEqual(['Hel', 'lo']);
    const done = events.find((e) => e.type === 'turn_complete');
    expect(done?.finalText).toBe('Hello');
  });

  it('emits the remainder when the final text extends past what streamed', async () => {
    const db = freshDb();
    const client: AgentClient = {
      messages: {
        async create(params: Record<string, unknown>) {
          (params.onDelta as (d: { kind: string; text: string }) => void)({ kind: 'text', text: 'Hel' });
          return {
            content: [{ type: 'text', text: 'Hello there' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    const events = await collectEvents(
      runTurn(
        { client, toolEnv: makeEnv(db), model: 'm', systemPrompt: 's', wikiEnabled: false },
        { userInput: 'hi', priorMessages: [], prefetchedHits: [] },
      ),
    );
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['Hel', 'lo there']);
    expect(events.find((e) => e.type === 'turn_complete')?.finalText).toBe('Hello there');
  });

  it('separates text emitted alongside a tool call from the next round with a blank line', async () => {
    const db = freshDb();
    insertTweet(db, '1');
    const client = fakeClient([
      {
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 't1', name: 'get_tweet_by_id', input: { id: '1' } },
        ],
        stop_reason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'Found it [^1].' }], stop_reason: 'end_turn' },
    ]);
    const events = await collectEvents(
      runTurn(
        { client, toolEnv: makeEnv(db), model: 'm', systemPrompt: 's', wikiEnabled: false },
        { userInput: 'hi', priorMessages: [], prefetchedHits: [] },
      ),
    );
    expect(events.find((e) => e.type === 'turn_complete')?.finalText).toBe('Let me look.\n\nFound it [^1].');
  });

  it('propagates an aborted request as a rejection', async () => {
    const db = freshDb();
    const client: AgentClient = {
      messages: {
        async create(params: Record<string, unknown>) {
          const signal = params.signal as AbortSignal;
          expect(signal).toBeInstanceOf(AbortSignal);
          throw new DOMException('The operation was aborted.', 'AbortError');
        },
      },
    };
    const ac = new AbortController();
    await expect(
      collectEvents(
        runTurn(
          { client, toolEnv: makeEnv(db), model: 'm', systemPrompt: 's', wikiEnabled: false, signal: ac.signal },
          { userInput: 'hi', priorMessages: [], prefetchedHits: [] },
        ),
      ),
    ).rejects.toThrow(/aborted/);
  });
});
