// Tool-using chat agent.
//
// Stages a single user turn through the model:
//   1. Pre-fetch hybrid retrieval over the user's question.
//   2. Build the user message with the context block + the question.
//   3. Stream the assistant's response. On tool_use blocks, dispatch via
//      tools.ts and feed the tool_result back; cap at MAX_TOOL_ROUNDS.
//   4. Yield events to the caller (text deltas, tool calls, completion).
//
// The Anthropic SDK is injected - the tests pass a fake client that yields
// scripted events, so we never actually hit the network in CI.

import { formatContextBlock } from './prompts';
import {
  buildToolset,
  dispatchTool,
  type ToolEnv,
} from './tools';
import { fetchHitsForContextBlock } from '../db/queries/agentTools';
import type { RetrievalHit } from './retrievalCore';

// Some models (notably DeepSeek-V4-Pro) call tools more aggressively than
// Claude. 12 gives plenty of headroom; the last round is forced to text-only
// below so we always produce *something* for the user.
const MAX_TOOL_ROUNDS = 12;

export interface AgentEvent {
  type:
    | 'context'
    | 'status'
    | 'text_delta'
    | 'tool_use'
    | 'tool_result'
    | 'message_complete'
    | 'turn_complete'
    | 'error';
  // Discriminated payload - see consumers.
  text?: string;
  /** For `status`: what the agent is doing right now. `thinking` = a model
   *  request is in flight; `reasoning` = chain-of-thought tokens are
   *  streaming (reasoning models only); `round` carries the 1-based round. */
  status?: { phase: 'thinking' | 'reasoning'; round: number };
  tool?: { id: string; name: string; input: Record<string, unknown> };
  result?: unknown;
  error?: string;
  retrievedIds?: string[];
  /** Final assistant text accumulated for the entire turn. */
  finalText?: string;
  /** Cumulative tool calls for the turn (for chat_messages.tool_calls_json). */
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; output: unknown }>;
  /** Token totals across the turn (for chat_messages.token_*). */
  usage?: { input: number; output: number };
}

type AnthropicMessageBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
};

export interface AgentClient {
  // Subset of the SDK we actually use - easier to mock in tests.
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: AnthropicMessageBlock[];
      stop_reason: string | null;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface RunTurnDeps {
  client: AgentClient;
  toolEnv: ToolEnv;
  model: string;
  systemPrompt: string;
  wikiEnabled: boolean;
  maxTokens?: number;
  /** Aborts the in-flight model request. Tool execution is not interrupted
   *  (tools are local SQL and finish in milliseconds). */
  signal?: AbortSignal;
}

/** Minimal async channel: producers `push`, one consumer iterates until
 *  `close`. Lets a callback-driven stream (fetch SSE) feed a generator. */
function makeChannel<T>() {
  const queue: T[] = [];
  let waiter: (() => void) | null = null;
  let closed = false;
  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  return {
    push(v: T) {
      if (closed) return;
      queue.push(v);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => {
          waiter = r;
        });
      }
    },
  };
}

export interface RunTurnInput {
  userInput: string;
  // Conversation history excluding the current user turn (already DB-backed).
  priorMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  // Pre-computed retrieval hits for the user's question - the caller embeds
  // and runs hybridSearch before calling runTurn.
  prefetchedHits: RetrievalHit[];
}

export async function* runTurn(
  deps: RunTurnDeps,
  input: RunTurnInput,
): AsyncGenerator<AgentEvent, void, unknown> {
  // 8k by default: reasoning models (DeepSeek-V4-Pro, o1, etc.) routinely
  // spend 500–4000 tokens on chain-of-thought before the actual answer, so
  // 4k leaves complex tool-using turns truncated with `content` null.
  const { client, toolEnv, model, systemPrompt, wikiEnabled, maxTokens = 8192, signal } = deps;
  const { userInput, priorMessages, prefetchedHits } = input;

  // 1. Build the context block from prefetched hits.
  const hitDocs = fetchHitsForContextBlock(toolEnv.db, prefetchedHits.map((h) => h.tweetId));
  const contextBlock = formatContextBlock(hitDocs);
  const retrievedIds = prefetchedHits.map((h) => h.tweetId);
  yield { type: 'context', text: contextBlock, retrievedIds };

  // 2. Stage the message list.
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: `${contextBlock}\n\n${userInput}` },
  ];

  const toolCalls: NonNullable<AgentEvent['toolCalls']> = [];
  let totalInput = 0;
  let totalOutput = 0;
  let finalText = '';

  // 3. Tool-use loop.
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // On the last round, omit tools entirely. This forces the model to emit
    // a final text answer instead of looping on another search call. Without
    // this, an agent that loves tools (DeepSeek does) can burn the whole
    // round budget without ever producing a response.
    const isFinalRound = round === MAX_TOOL_ROUNDS - 1;
    yield { type: 'status', status: { phase: 'thinking', round: round + 1 } };

    // Stream the model's answer as it arrives. The client calls `onDelta`
    // for each chunk; a channel relays those into this generator so the UI
    // renders tokens progressively instead of one flush per round. Clients
    // that ignore `onDelta` (tests, non-streaming providers) simply never
    // push, and the full text is emitted after the response below.
    const channel = makeChannel<{ kind: 'text' | 'reasoning'; text: string }>();
    let streamedText = '';
    const pending = client.messages
      .create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        ...(isFinalRound ? {} : { tools: buildToolset({ wikiEnabled }) }),
        messages,
        onDelta: (d: { kind: 'text' | 'reasoning'; text: string }) => channel.push(d),
        signal,
      })
      .finally(() => channel.close());
    // Swallow here; the awaited `pending` below rethrows to the caller.
    pending.catch(() => {});

    let reasoningAnnounced = false;
    for await (const d of channel) {
      if (d.kind === 'reasoning') {
        if (!reasoningAnnounced) {
          reasoningAnnounced = true;
          yield { type: 'status', status: { phase: 'reasoning', round: round + 1 } };
        }
        continue;
      }
      streamedText += d.text;
      finalText += d.text;
      yield { type: 'text_delta', text: d.text };
    }
    const resp = await pending;
    totalInput += resp.usage.input_tokens;
    totalOutput += resp.usage.output_tokens;

    // Emit whatever text the response holds beyond what already streamed.
    // Non-streaming clients: everything. Streaming clients: normally nothing,
    // unless the final text differs from the deltas (reasoning-only fallback).
    const textBlocks = resp.content.filter((b): b is AnthropicMessageBlock & { text: string } => b.type === 'text' && typeof b.text === 'string');
    const roundText = textBlocks.map((tb) => tb.text).join('');
    if (roundText) {
      const remainder = roundText.startsWith(streamedText)
        ? roundText.slice(streamedText.length)
        : roundText;
      if (remainder) {
        finalText += remainder;
        yield { type: 'text_delta', text: remainder };
      }
    }

    const toolBlocks = resp.content.filter((b) => b.type === 'tool_use');

    // Converge if (a) the model gave us no tool calls, (b) it gave us tools
    // but its stop_reason wasn't 'tool_use' (rare, but means "done"), or
    // (c) this was the forced-text final round - in which case we accept
    // whatever the model produced and stop, even if it tried to call tools.
    if (isFinalRound || toolBlocks.length === 0 || resp.stop_reason !== 'tool_use') {
      yield {
        type: 'message_complete',
        finalText,
        toolCalls,
        usage: { input: totalInput, output: totalOutput },
      };
      yield { type: 'turn_complete', finalText, toolCalls, usage: { input: totalInput, output: totalOutput } };
      return;
    }

    // Append the assistant's content (text + tool_use blocks) so subsequent
    // messages reference these tool_use_ids when supplying tool_result.
    messages.push({ role: 'assistant', content: resp.content });

    // Text emitted alongside a tool call ("Let me check…") would otherwise
    // run straight into the next round's answer. Separate the rounds.
    if (roundText && !finalText.endsWith('\n\n')) {
      finalText += '\n\n';
      yield { type: 'text_delta', text: '\n\n' };
    }

    // 4. Run each tool, collect tool_results.
    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
    for (const tb of toolBlocks) {
      const toolEvent = {
        id: tb.id ?? '',
        name: tb.name ?? '',
        input: (tb.input ?? {}) as Record<string, unknown>,
      };
      yield { type: 'tool_use', tool: toolEvent };
      let result: unknown;
      try {
        result = await dispatchTool(toolEnv, toolEvent.name, toolEvent.input);
      } catch (e) {
        result = { error: 'tool_error', message: (e as Error).message };
      }
      toolCalls.push({ name: toolEvent.name, input: toolEvent.input, output: result });
      yield { type: 'tool_result', tool: toolEvent, result };
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolEvent.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Defensive: the loop body always returns by the final round (isFinalRound
  // branch) so this is unreachable, but keep an error event so a future
  // regression doesn't silently produce no output.
  yield {
    type: 'error',
    error: `agent exceeded ${MAX_TOOL_ROUNDS} tool rounds without converging`,
    finalText,
    toolCalls,
    usage: { input: totalInput, output: totalOutput },
  };
}
