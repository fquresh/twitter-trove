// DeepSeek chat client. Implements the same `AgentClient` shape that
// `agent.ts` already expects (Anthropic-style `messages.create()` returning
// `{ content: [...], stop_reason, usage }`), so the agent loop and tool
// definitions don't have to change. Internally translates to DeepSeek's
// OpenAI-compatible /chat/completions endpoint.
//
// Why an adapter and not a rewrite of agent.ts? The internal request/response
// shape we already use is closer to Anthropic's, and the translation here is
// fully contained - touching this file alone lets us swap providers later
// without ripping through the agent or tool code.
//
// Chat is DeepSeek-direct (native API at api.deepseek.com). OpenRouter stays
// only in the offline Python pipeline (reclassify_canonical.py, enrich.py).

import type { AgentClient } from './agent';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const PROXY_MODE = import.meta.env.VITE_USE_API_PROXY === 'true';

interface ToolBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface TextBlock {
  type: 'text';
  text: string;
}
type Block = ToolBlock | TextBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: unknown;
}
interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

function translateMessages(
  system: string | undefined,
  messages: AnthropicMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    // Anthropic packs tool_result blocks under a synthetic "user" message.
    // OpenAI uses a distinct `tool` role per result.
    if (m.role === 'user' && Array.isArray(m.content)) {
      const blocks = m.content as Array<{
        type: string;
        tool_use_id?: string;
        content?: string;
      }>;
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id ?? '',
            content: tr.content ?? '',
          });
        }
        // If there's also raw text in the block array (rare), pass it as user.
        const texts = blocks.filter((b) => b.type === 'text') as Array<{ text?: string }>;
        const concat = texts.map((b) => b.text ?? '').join('');
        if (concat) out.push({ role: 'user', content: concat });
        continue;
      }
    }

    // Anthropic assistant turn with content blocks (text + tool_use).
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocks = m.content as Block[];
      const text = blocks
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = blocks.filter((b): b is ToolBlock => b.type === 'tool_use');
      const msg: OpenAIMessage = {
        role: 'assistant',
        content: text || null,
      };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {}),
          },
        }));
      }
      out.push(msg);
      continue;
    }

    // Plain string content.
    out.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    });
  }
  return out;
}

function translateTools(tools: AnthropicToolDef[] | undefined): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

interface OpenAIChoice {
  finish_reason: string;
  message: {
    content: string | null;
    // DeepSeek's native API returns chain-of-thought from reasoning models in
    // `reasoning_content`. OpenRouter used `reasoning`; we accept both so a
    // future provider swap or a passthrough field never silently drops the
    // reasoning-only fallback. Usually the real answer is still in `content`,
    // but on length-truncated turns the model can spend its whole budget on
    // reasoning and leave `content` null - in which case the trailing chunk
    // of reasoning IS the only output we have to show.
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
}
interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
}

function translateResponse(data: OpenAIResponse): {
  content: Block[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
} {
  if (data.error) {
    throw new Error(`DeepSeek: ${data.error.message ?? 'unknown error'}`);
  }
  const choice = data.choices?.[0];
  if (!choice) throw new Error('DeepSeek: empty choices in response');
  const msg = choice.message;

  const content: Block[] = [];
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  } else if (
    !msg.tool_calls?.length &&
    typeof msg.reasoning_content === 'string' &&
    msg.reasoning_content.trim().length > 0
  ) {
    // Reasoning-only fallback: model burned its budget on chain-of-thought
    // and never emitted a final `content`. Surface the reasoning so the user
    // sees *something* instead of an empty bubble. Strip any <think> wrapper
    // some providers emit literally.
    const reasoning = msg.reasoning_content.replace(/<\/?think>/gi, '').trim();
    content.push({ type: 'text', text: reasoning });
  } else if (
    !msg.tool_calls?.length &&
    typeof msg.reasoning === 'string' &&
    msg.reasoning.trim().length > 0
  ) {
    // Legacy/passthrough `reasoning` field (OpenRouter shape) - kept as a
    // secondary fallback so the adapter is provider-agnostic.
    const reasoning = msg.reasoning.replace(/<\/?think>/gi, '').trim();
    content.push({ type: 'text', text: reasoning });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        // Some providers stream arguments; treat malformed as empty.
        parsedInput = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      });
    }
  }

  // Map OpenAI finish_reason to Anthropic's stop_reason vocabulary so the
  // existing agent loop's `stop_reason === 'tool_use'` check still works.
  let stop_reason: string | null = choice.finish_reason ?? null;
  if (stop_reason === 'tool_calls') stop_reason = 'tool_use';
  else if (stop_reason === 'stop') stop_reason = 'end_turn';
  else if (stop_reason === 'length') stop_reason = 'max_tokens';

  return {
    content,
    stop_reason,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

/** Incremental output from a streamed completion. `reasoning` deltas come
 *  from reasoning models' chain-of-thought (DeepSeek `reasoning_content`);
 *  `text` deltas are the user-visible answer. */
export interface StreamDelta {
  kind: 'text' | 'reasoning';
  text: string;
}

interface OpenAIStreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; code?: number };
}

/** Splits an SSE byte stream into `data:` payloads. Exported for tests. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
    }
    const rest = buf.trim();
    if (rest.startsWith('data:')) {
      const payload = rest.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Folds a stream of OpenAI-compatible chunks into the same non-streaming
 *  response shape `translateResponse` consumes, invoking `onDelta` as content
 *  arrives. Exported for tests. */
export async function collectStream(
  payloads: AsyncIterable<string>,
  onDelta: (d: StreamDelta) => void,
): Promise<OpenAIResponse> {
  let content = '';
  let reasoning = '';
  let finish: string | null = null;
  let usage: OpenAIResponse['usage'];
  const tools = new Map<number, { id: string; name: string; args: string }>();

  for await (const payload of payloads) {
    if (payload === '[DONE]') break;
    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIStreamChunk;
    } catch {
      continue; // keep-alive noise or a partial line; skip
    }
    if (chunk.error) {
      throw new Error(`DeepSeek: ${chunk.error.message ?? 'unknown error'}`);
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === 'string' && r) {
      reasoning += r;
      onDelta({ kind: 'reasoning', text: r });
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta({ kind: 'text', text: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const slot = tools.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      tools.set(idx, slot);
    }
  }

  const tool_calls = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id,
      type: 'function' as const,
      function: { name: t.name, arguments: t.args },
    }));

  return {
    choices: [
      {
        finish_reason: finish ?? (tool_calls.length > 0 ? 'tool_calls' : 'stop'),
        message: {
          content: content || null,
          reasoning_content: reasoning || null,
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
        },
      },
    ],
    usage: usage ?? undefined,
  };
}

export function makeDeepseekClient(apiKey?: string): AgentClient {
  if (!PROXY_MODE && !apiKey) {
    throw new Error('DeepSeek API key required (or build with VITE_USE_API_PROXY=true).');
  }
  return {
    messages: {
      async create(params: Record<string, unknown>) {
        const messages = (params.messages ?? []) as AnthropicMessage[];
        const system = params.system as string | undefined;
        const tools = params.tools as AnthropicToolDef[] | undefined;
        // Client-side extras - never forwarded to the API.
        const onDelta = params.onDelta as ((d: StreamDelta) => void) | undefined;
        const signal = params.signal as AbortSignal | undefined;

        const body: Record<string, unknown> = {
          model: params.model,
          max_tokens: params.max_tokens,
          temperature: 0,
          messages: translateMessages(system, messages),
        };
        const oaTools = translateTools(tools);
        if (oaTools) {
          body.tools = oaTools;
          body.tool_choice = 'auto';
        }
        if (onDelta) {
          body.stream = true;
          body.stream_options = { include_usage: true };
        }

        const url = PROXY_MODE ? '/api/chat' : DEEPSEEK_URL;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (!PROXY_MODE) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        const resp = await fetch(url, {
          method: 'POST',
          credentials: PROXY_MODE ? 'include' : 'omit',
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`${PROXY_MODE ? '/api/chat' : 'DeepSeek'} HTTP ${resp.status}: ${text.slice(0, 500)}`);
        }
        // A streaming request normally answers with text/event-stream. If the
        // server (or a test mock) replies with plain JSON instead, fall back
        // to the non-streaming path so the caller still gets a full response.
        const isSse = /text\/event-stream/i.test(resp.headers.get('Content-Type') ?? '');
        if (onDelta && isSse && resp.body) {
          const data = await collectStream(readSseData(resp.body), onDelta);
          return translateResponse(data);
        }
        const data = (await resp.json()) as OpenAIResponse;
        return translateResponse(data);
      },
    },
  };
}

/** Quick smoke test - small ping with the chosen model. Used by Settings "Test" button. */
export async function pingDeepseek(
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const client = makeDeepseekClient(apiKey);
    const resp = await client.messages.create({
      model,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return {
      ok: true,
      message: `OK - ${resp.usage.input_tokens}+${resp.usage.output_tokens} tokens (${model})`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
