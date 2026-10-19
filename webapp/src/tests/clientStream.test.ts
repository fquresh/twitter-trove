// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readSseData, collectStream, type StreamDelta } from '../chat/client';

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = lines.join('\n') + '\n';
  // Split at awkward byte offsets to exercise buffering across chunks.
  const chunks = [text.slice(0, 17), text.slice(17, 40), text.slice(40)];
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('readSseData', () => {
  it('yields data payloads across chunk boundaries and skips comments/blank lines', async () => {
    const body = sseBody([
      ': keep-alive',
      'data: {"a":1}',
      '',
      'event: ping',
      'data: {"b":2}',
      'data: [DONE]',
    ]);
    expect(await collect(readSseData(body))).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('flushes a final payload with no trailing newline', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"x":1}'));
        c.close();
      },
    });
    expect(await collect(readSseData(body))).toEqual(['{"x":1}']);
  });
});

async function* fromArray(items: string[]): AsyncGenerator<string> {
  for (const i of items) yield i;
}

describe('collectStream', () => {
  it('accumulates text deltas, reports them, and captures usage', async () => {
    const deltas: StreamDelta[] = [];
    const resp = await collectStream(
      fromArray([
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
        JSON.stringify({ choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
        '[DONE]',
      ]),
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual([
      { kind: 'reasoning', text: 'hmm ' },
      { kind: 'text', text: 'Hello' },
      { kind: 'text', text: ' world' },
    ]);
    expect(resp.choices[0]!.message.content).toBe('Hello world');
    expect(resp.choices[0]!.finish_reason).toBe('stop');
    expect(resp.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3 });
  });

  it('reassembles tool call arguments streamed in fragments', async () => {
    const resp = await collectStream(
      fromArray([
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_tweets', arguments: '' } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"ag' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ents"}' } }] } }] }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'count_tweets', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        }),
      ]),
      () => {},
    );
    const msg = resp.choices[0]!.message;
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'search_tweets', arguments: '{"query":"agents"}' } },
      { id: 'call_2', type: 'function', function: { name: 'count_tweets', arguments: '{}' } },
    ]);
    expect(resp.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('surfaces an in-stream error object as a thrown error', async () => {
    await expect(
      collectStream(fromArray([JSON.stringify({ error: { message: 'rate limited' } })]), () => {}),
    ).rejects.toThrow(/rate limited/);
  });

  it('ignores malformed payloads instead of aborting the stream', async () => {
    const resp = await collectStream(
      fromArray(['not json', JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]),
      () => {},
    );
    expect(resp.choices[0]!.message.content).toBe('ok');
  });
});
