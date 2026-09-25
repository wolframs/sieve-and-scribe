import { describe, expect, it, vi } from 'vitest';
import {
  sendMessageWithTools,
  type LlmStreamFetch,
  type ToolResult,
} from '@/lib/api-client';
import type { ToolDefinition } from '@/lib/civitai-tools';
import type { LlmProxyRequest, LlmStream } from '@/lib/llm-proxy';
import type { ChatMessage, ProviderConfig, StreamChunk } from '@/lib/types';

const provider: ProviderConfig = {
  type: 'openrouter',
  apiKey: 'test-key-never-sent',
  baseURL: 'https://openrouter.ai/api/v1',
  defaultModel: 'openai/gpt-5.6-luna',
};

const messages: ChatMessage[] = [
  { role: 'system', content: 'Use tools when needed.', timestamp: 1 },
  { role: 'user', content: 'Find and stage a rain style. Do not generate.', timestamp: 2 },
];

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_styles',
      description: 'Find grounded styles.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_context',
      description: 'Read the active form.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function okStream(...chunks: string[]): LlmStream {
  return {
    head: { ok: true, status: 200, retryAfter: null },
    chunks: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

function errorStream(status: number, bodyText: string): LlmStream {
  return {
    head: { ok: false, status, retryAfter: null, bodyText },
    chunks: (async function* () {})(),
  };
}

function contentSse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n`;
}

function scriptedTransport(
  responders: Array<(request: LlmProxyRequest) => LlmStream>
): { requests: LlmProxyRequest[]; streamFetch: LlmStreamFetch } {
  const requests: LlmProxyRequest[] = [];
  const streamFetch: LlmStreamFetch = vi.fn(async (request) => {
    requests.push(request);
    const responder = responders.shift();
    if (!responder) throw new Error('Unexpected completion request');
    return responder(request);
  });
  return { requests, streamFetch };
}

async function collect(
  stream: AsyncGenerator<StreamChunk>
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('assistant tool-calling protocol', () => {
  it.each([
    [{ error: { code: 'provider_error', message: 'Upstream classifier rejected the response' } }, /provider_error.*classifier/],
    [{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }, /content-filter.*content_filter/],
    [{ choices: [{ delta: {}, finish_reason: 'error' }] }, /error but supplied no details/],
  ])('surfaces HTTP-200 stream failure events without retrying (%j)', async (event, expected) => {
    const transport = scriptedTransport([() => okStream(`data: ${JSON.stringify(event)}\n`, 'data: [DONE]\n')]);
    const executeTool = vi.fn(async () => '{}');
    await expect(collect(sendMessageWithTools(messages, provider, {
      tools, executeTool, streamFetch: transport.streamFetch,
    }))).rejects.toThrow(expected as RegExp);
    expect(transport.requests).toHaveLength(1);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('preserves text on the same chunk as a token-limit failure and never runs truncated tools', async () => {
    const event = { choices: [{ delta: { content: 'The last useful sentence.', tool_calls: [{
      index: 0, id: 'cut-off', function: { name: 'search_styles', arguments: '{"query":' },
    }] }, finish_reason: 'length' }] };
    const transport = scriptedTransport([() => okStream(`data: ${JSON.stringify(event)}\n`)]);
    const executeTool = vi.fn(async () => '{}');
    const stream = sendMessageWithTools(messages, provider, { tools, executeTool, streamFetch: transport.streamFetch });
    expect((await stream.next()).value).toMatchObject({ delta: 'The last useful sentence.' });
    await expect(stream.next()).rejects.toThrow(/output-token limit/);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('reports an empty continuation after a successful tool instead of silently ending on old narration', async () => {
    const event = { choices: [{ delta: { content: 'Let me search.', tool_calls: [{
      index: 0, id: 'lookup', function: { name: 'search_styles', arguments: '{}' },
    }] }, finish_reason: 'tool_calls' }] };
    const transport = scriptedTransport([
      () => okStream(`data: ${JSON.stringify(event)}\n`, 'data: [DONE]\n'),
      () => okStream('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n', 'data: [DONE]\n'),
    ]);
    const chunks: StreamChunk[] = [];
    const run = async () => {
      for await (const chunk of sendMessageWithTools(messages, provider, {
        tools, executeTool: async () => '{}', streamFetch: transport.streamFetch,
      })) chunks.push(chunk);
    };
    await expect(run()).rejects.toThrow(/empty response/);
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('Let me search.');
    expect(chunks.at(-1)).toMatchObject({ toolStatus: null });
  });

  it('reports a disconnected stream after preserving partial text', async () => {
    const transport = scriptedTransport([() => okStream(contentSse('Partial answer.'))]);
    const stream = sendMessageWithTools(messages, provider, { tools: [], executeTool: async () => '{}', streamFetch: transport.streamFetch });
    expect((await stream.next()).value).toMatchObject({ delta: 'Partial answer.' });
    await expect(stream.next()).rejects.toThrow(/before a completion signal/);
  });

  it('accepts a terminal finish without DONE and ignores comments and usage-only frames', async () => {
    const transport = scriptedTransport([() => okStream(
      ': OPENROUTER PROCESSING\n', 'data: {malformed}\n', contentSse('Complete answer.'),
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
      'data: {"choices":[],"usage":{"total_tokens":20}}\n',
    )]);
    const chunks = await collect(sendMessageWithTools(messages, provider, { tools: [], executeTool: async () => '{}', streamFetch: transport.streamFetch }));
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('Complete answer.');
  });

  it('displays a provider refusal field rather than treating it as an unexplained empty reply', async () => {
    const event = { choices: [{ delta: { content: '', refusal: 'I cannot help with that request.' }, finish_reason: 'stop' }] };
    const transport = scriptedTransport([() => okStream(`data: ${JSON.stringify(event)}\n`, 'data: [DONE]\n')]);
    const chunks = await collect(sendMessageWithTools(messages, provider, { tools: [], executeTool: async () => '{}', streamFetch: transport.streamFetch }));
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('I cannot help with that request.');
  });
  it.each([false, true])('returns thrown tool errors to the model but preserves cancellation (abort=%s)', async (abort) => {
    const transport = scriptedTransport([
      () => okStream(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0, id: 'context', type: 'function', function: { name: 'get_page_context', arguments: '{}' },
      }] }, finish_reason: 'tool_calls' }] })}\n`, 'data: [DONE]\n'),
      (request) => {
        const body = JSON.parse(request.body);
        const result = body.messages.find((message: any) => message.role === 'tool');
        expect(result.tool_call_id).toBe('context');
        expect(JSON.parse(result.content)).toMatchObject({ error: 'Page bridge unavailable', unknown: true });
        return okStream(contentSse('The page could not be read.'), 'data: [DONE]\n');
      },
    ]);
    const executeTool = vi.fn(async () => {
      if (abort) throw new DOMException('Cancelled', 'AbortError');
      throw new Error('Page bridge unavailable');
    });
    const run = collect(sendMessageWithTools(messages, provider, {
      tools, executeTool, streamFetch: transport.streamFetch,
    }));
    if (abort) {
      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      expect(transport.requests).toHaveLength(1);
    } else {
      const chunks = await run;
      expect(chunks.map((chunk) => chunk.delta).join('')).toBe('The page could not be read.');
      expect(transport.requests).toHaveLength(2);
    }
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('assembles fragmented parallel tool calls and keeps image turns after all tool results', async () => {
    const onUsage = vi.fn();
    const firstEvent = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_search',
                type: 'function',
                function: { name: 'search_styles', arguments: '{"query":"rain' },
              },
              {
                index: 1,
                id: 'call_context',
                type: 'function',
                function: { name: 'get_page_context', arguments: '{' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    const secondEvent = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: ' city"}' } },
              { index: 1, function: { arguments: '}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const transport = scriptedTransport([
      () =>
        okStream(
          `data: ${firstEvent.slice(0, 58)}`,
          `${firstEvent.slice(58)}\ndata: ${secondEvent}\n`,
          'data: [DONE]\n'
        ),
      () =>
        okStream(
          contentSse('Ready to review.'),
          `data: ${JSON.stringify({
            choices: [],
            cache_discount: 0.0002,
            usage: {
              prompt_tokens: 120,
              completion_tokens: 15,
              total_tokens: 135,
              cost: 0.001,
              prompt_tokens_details: { cached_tokens: 96, cache_write_tokens: 8 },
            },
          })}\n`,
          'data: [DONE]'
        ),
    ]);
    const executeTool = vi.fn(
      async (name: string): Promise<ToolResult> =>
        name === 'search_styles'
          ? {
              content: JSON.stringify({ id: 42, name: 'Rain City' }),
              images: [{ url: 'data:image/png;base64,fixture', label: 'Style preview' }],
            }
          : JSON.stringify({ route: '/generate', availableFields: ['prompt'] })
    );

    const chunks = await collect(
      sendMessageWithTools(messages, provider, {
        tools,
        executeTool,
        streamFetch: transport.streamFetch,
        onUsage,
        sessionId: 'conversation-1',
      })
    );

    expect(executeTool).toHaveBeenNthCalledWith(1, 'search_styles', '{"query":"rain city"}', undefined);
    expect(executeTool).toHaveBeenNthCalledWith(2, 'get_page_context', '{}', undefined);
    expect(chunks.filter((chunk) => chunk.toolStatus)).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('Ready to review.');
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 120,
      completionTokens: 15,
      totalTokens: 135,
      cost: 0.001,
      cachedTokens: 96,
      cacheWriteTokens: 8,
      cacheDiscount: 0.0002,
    });
    expect(JSON.parse(transport.requests[0].body as string).stream_options).toEqual({
      include_usage: true,
    });
    expect(transport.requests.map((request) => JSON.parse(request.body as string).session_id)).toEqual([
      'conversation-1',
      'conversation-1',
    ]);

    const continuation = JSON.parse(transport.requests[1].body as string);
    expect(continuation.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
      'system',
      'assistant',
      'tool',
      'tool',
      'user',
      'system',
    ]);
    expect(continuation.messages[3].tool_calls).toEqual([
      expect.objectContaining({ id: 'call_search' }),
      expect.objectContaining({ id: 'call_context' }),
    ]);
    expect(continuation.messages[6].content).toEqual([
      { type: 'text', text: 'Style preview:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
    ]);
  });

  it('forces a tool-free completion after the configured tool-round limit', async () => {
    const toolEvent = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_search',
                function: { name: 'search_styles', arguments: '{"query":"rain"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const transport = scriptedTransport([
      () => okStream(`data: ${toolEvent}\n`, 'data: [DONE]\n'),
      () => okStream(contentSse('I stopped after the bounded lookup.'), 'data: [DONE]\n'),
    ]);

    const chunks = await collect(
      sendMessageWithTools(messages, provider, {
        tools,
        maxToolRounds: 1,
        executeTool: async () => '{}',
        streamFetch: transport.streamFetch,
      })
    );

    expect(JSON.parse(transport.requests[0].body as string).tools).toHaveLength(2);
    expect(JSON.parse(transport.requests[1].body as string)).not.toHaveProperty('tools');
    expect(chunks.filter((chunk) => chunk.toolRoundLimit !== undefined)).toEqual([
      { delta: '', finishReason: null, toolRoundLimit: 1 },
    ]);
    expect(JSON.parse(transport.requests[1].body as string).messages.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringMatching(/summar/i),
    });
  });

  it('does not execute provider tool calls after the hard round limit', async () => {
    const event = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'lookup', function: { name: 'search_styles', arguments: '{}' },
    }] }, finish_reason: 'tool_calls' }] })}\n`;
    const transport = scriptedTransport([
      () => okStream(event, 'data: [DONE]\n'),
      () => okStream(event, 'data: [DONE]\n'),
    ]);
    const executeTool = vi.fn(async () => '{}');
    const chunks = await collect(sendMessageWithTools(messages, provider, {
      tools, executeTool, maxToolRounds: 1, streamFetch: transport.streamFetch,
    }));
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(transport.requests).toHaveLength(2);
    expect(chunks.some((chunk) => chunk.toolRoundLimit === 1)).toBe(true);
    expect(chunks.at(-1)?.delta).toContain('it was not run');
  });

  it.each([false, true])('reuses successful catalog lookups but retries failures (failure=%s)', async (fails) => {
    const event = (id: string, args: string) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
      index: 0, id, function: { name: 'search_styles', arguments: args },
    }] }, finish_reason: 'tool_calls' }] })}\n`;
    const transport = scriptedTransport([
      () => okStream(event('first', '{"query":"rain","limit":2}'), 'data: [DONE]\n'),
      () => okStream(event('second', '{"limit":2,"query":"rain"}'), 'data: [DONE]\n'),
      () => okStream(contentSse('Search complete.'), 'data: [DONE]\n'),
    ]);
    const executeTool = vi.fn(async () => JSON.stringify(fails ? { error: 'temporary failure' } : { count: 0 }));
    await collect(sendMessageWithTools(messages, provider, {
      tools, executeTool, cacheableTools: ['search_styles'], streamFetch: transport.streamFetch,
    }));
    expect(executeTool).toHaveBeenCalledTimes(fails ? 2 : 1);
    const final = JSON.parse(transport.requests[2].body as string);
    const result = JSON.parse(final.messages.filter((m: { role: string }) => m.role === 'tool').at(-1).content);
    if (fails) expect(result.error).toBe('temporary failure');
    else expect(result).toMatchObject({ cached: true, result: '{"count":0}' });
  });

  it('executes an identical successful proposal only once within a tool loop', async () => {
    const proposalEvent = (id: string, args: string) => JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            function: { name: 'propose_feed_filter', arguments: args },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const transport = scriptedTransport([
      () => okStream(
        `data: ${proposalEvent('call_first', '{"minReactions":100,"orientations":["portrait"]}')}\n`,
        'data: [DONE]\n'
      ),
      () => okStream(
        `data: ${proposalEvent('call_repeat', '{"orientations":["portrait"],"minReactions":100}')}\n`,
        'data: [DONE]\n'
      ),
      () => okStream(contentSse('The confirmation card is ready.'), 'data: [DONE]\n'),
    ]);
    const executeTool = vi.fn(async () => JSON.stringify({ status: 'proposed' }));

    const chunks = await collect(sendMessageWithTools(messages, provider, {
      tools,
      executeTool,
      streamFetch: transport.streamFetch,
    }));

    expect(executeTool).toHaveBeenCalledTimes(1);
    const finalRequest = JSON.parse(transport.requests[2].body as string);
    expect(JSON.parse(finalRequest.messages.filter((m: { role: string }) => m.role === 'tool').at(-1).content)).toMatchObject({
      status: 'already_proposed',
    });
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('The confirmation card is ready.');
  });

  it('retries without tools only when the provider explicitly rejects tool support', async () => {
    const transport = scriptedTransport([
      () => errorStream(400, 'Invalid parameter: tools are not supported by this model.'),
      () => okStream(contentSse('Plain completion.'), 'data: [DONE]\n'),
    ]);

    const chunks = await collect(
      sendMessageWithTools(messages, provider, {
        tools,
        executeTool: async () => '{}',
        streamFetch: transport.streamFetch,
      })
    );

    expect(transport.requests).toHaveLength(2);
    expect(JSON.parse(transport.requests[1].body as string)).not.toHaveProperty('tools');
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('Plain completion.');
  });

  it('recognizes OpenRouter no-tool-endpoint errors without broad status guessing', async () => {
    const transport = scriptedTransport([
      () => errorStream(404, 'No endpoints found that support tool use.'),
      () => okStream(contentSse('Fallback completion.'), 'data: [DONE]\n'),
    ]);

    await collect(
      sendMessageWithTools(messages, provider, {
        tools,
        executeTool: async () => '{}',
        streamFetch: transport.streamFetch,
      })
    );

    expect(transport.requests).toHaveLength(2);
    expect(JSON.parse(transport.requests[1].body as string)).not.toHaveProperty('tools');
  });

  it('does not hide unrelated 400 responses behind a tool-less retry', async () => {
    const transport = scriptedTransport([
      () => errorStream(400, 'The supplied image exceeds the maximum allowed size.'),
    ]);

    await expect(
      collect(
        sendMessageWithTools(messages, provider, {
          tools,
          executeTool: async () => '{}',
          streamFetch: transport.streamFetch,
        })
      )
    ).rejects.toThrow('The supplied image exceeds the maximum allowed size');
    expect(transport.requests).toHaveLength(1);
  });

  it('stops the rest of a tool batch when an in-flight tool ignores cancellation', async () => {
    const event = JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'first', function: { name: 'search_styles', arguments: '{}' } },
      { index: 1, id: 'second', function: { name: 'get_page_context', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] });
    const transport = scriptedTransport([() => okStream(`data: ${event}\n`, 'data: [DONE]\n')]);
    const abort = new AbortController();
    const executeTool = vi.fn(async () => {
      abort.abort();
      return '{}'; // A non-cancellable page bridge can resolve after Stop was clicked.
    });
    await expect(collect(sendMessageWithTools(messages, provider, {
      tools, executeTool, streamFetch: transport.streamFetch, signal: abort.signal,
    }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(transport.requests).toHaveLength(1);
  });

  it('does not start a tool if cancellation arrives while showing its status', async () => {
    const event = JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'lookup', function: { name: 'search_styles', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] });
    const transport = scriptedTransport([() => okStream(`data: ${event}\n`, 'data: [DONE]\n')]);
    const abort = new AbortController();
    const executeTool = vi.fn(async () => '{}');
    const stream = sendMessageWithTools(messages, provider, {
      tools, executeTool, streamFetch: transport.streamFetch, signal: abort.signal,
    });
    expect((await stream.next()).value).toHaveProperty('toolStatus');
    abort.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('propagates aborts raised while a requested tool is executing', async () => {
    const toolEvent = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_context',
                function: { name: 'get_page_context', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const transport = scriptedTransport([
      () => okStream(`data: ${toolEvent}\n`, 'data: [DONE]\n'),
    ]);

    await expect(
      collect(
        sendMessageWithTools(messages, provider, {
          tools,
          executeTool: async () => {
            throw new DOMException('The operation was aborted.', 'AbortError');
          },
          streamFetch: transport.streamFetch,
        })
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
