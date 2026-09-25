import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChatController,
  type ChatControllerRuntime,
  type PageAccess,
} from '@/lib/chat-controller';
import { createActionRecord, generateBlockers } from '@/lib/action-state';
import type { Conversation } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/constants';
import { sendMessageWithTools, type LlmStreamFetch } from '@/lib/api-client';
import type { LlmProxyRequest, LlmStream } from '@/lib/llm-proxy';

let stored: Conversation;
let runtime: Partial<ChatControllerRuntime>;

function page(applyAction: PageAccess['applyAction']): PageAccess {
  return {
    onGeneratePage: async () => true,
    formState: async () => ({ prompt: '', negativePrompt: '' }),
    pageContext: async () => ({}),
    pageImages: async () => [],
    generatorImages: async () => [],
    applyAction,
  };
}

async function seedConversation() {
  const action = createActionRecord(
    { kind: 'prompt', positive: 'rain-soaked Berlin' },
    'turn-1',
    'action-1',
    10
  );
  const conversation: Conversation = {
    id: 'conversation-1',
    title: 'Recovery test',
    messages: [{ role: 'user', content: 'Prepare it', timestamp: 1 }],
    actions: [action],
    createdAt: 1,
    updatedAt: 10,
  };
  stored = structuredClone(conversation);
  runtime = {
    getActiveConversationId: async () => stored.id,
    setActiveConversationId: async () => {},
    getConversation: async (id) => (id === stored.id ? structuredClone(stored) : null),
    saveConversation: async (conversation) => {
      stored = structuredClone(conversation);
    },
    deleteConversation: async () => {},
  };
}

function okStream(...chunks: string[]): LlmStream {
  return {
    head: { ok: true, status: 200, retryAfter: null },
    chunks: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

function toolStream(name: string, args: Record<string, unknown>): LlmStream {
  return okStream(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${name}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n`,
    'data: [DONE]\n'
  );
}

function finalStream(text: string): LlmStream {
  return okStream(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n`,
    'data: [DONE]\n'
  );
}

function scriptedContinuation(finalText: string, requests: LlmProxyRequest[]) {
  return scriptedToolContinuation('propose_generate', {}, finalText, requests);
}

function scriptedToolContinuation(
  toolName: string,
  args: Record<string, unknown>,
  finalText: string,
  requests: LlmProxyRequest[]
) {
  const streams = [toolStream(toolName, args), finalStream(finalText)];
  const streamFetch: LlmStreamFetch = async (request) => {
    requests.push(request);
    const stream = streams.shift();
    if (!stream) throw new Error('unexpected completion');
    return stream;
  };
  runtime.getActiveProvider = async () => ({
    type: 'openrouter',
    apiKey: 'test-only',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-luna',
  });
  runtime.getSettings = async () => ({ ...DEFAULT_SETTINGS, civitaiMcpMode: 'off' });
  runtime.sendMessageWithTools = ((messages, provider, options) =>
    sendMessageWithTools(messages, provider, { ...options, streamFetch })) as any;
}

function textContinuation(text: string) {
  runtime.getActiveProvider = async () => ({
    type: 'openrouter',
    apiKey: 'test-only',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-luna',
  });
  runtime.getSettings = async () => ({ ...DEFAULT_SETTINGS, civitaiMcpMode: 'off' });
  runtime.sendMessageWithTools = (async function* () {
    yield { delta: text, finishReason: 'stop' };
  }) as any;
}

describe('controller-owned action resolution', () => {
  beforeEach(async () => {
    await seedConversation();
  });

  it.each(['', 'Let me search.'])('persists a failed response and keeps tool activity out of its text (%s)', async (partial) => {
    textContinuation('');
    runtime.sendMessageWithTools = (async function* () {
      if (partial) yield { delta: partial, finishReason: null };
      yield { delta: '', finishReason: null, toolStatus: 'Searching CivitAI…' };
      throw new Error('Provider stream error: test failure');
    }) as typeof sendMessageWithTools;
    const update = vi.fn();
    const error = vi.fn();
    const controller = createChatController(page(vi.fn()), runtime);
    await controller.handleSendMessage('Hello', [], vi.fn(), update, vi.fn(), error, vi.fn());
    expect(update).toHaveBeenCalledWith(partial, expect.any(String), 'Searching CivitAI…');
    expect(error).toHaveBeenCalledWith('Provider stream error: test failure');
    const saved = stored.messages.at(-1)?.content;
    expect(saved).toBe(`${partial}\n\nResponse failed: Provider stream error: test failure`.trimStart());
    expect(saved).not.toContain('Searching');
    expect(update).toHaveBeenLastCalledWith(saved, expect.any(String), null, []);
    expect(controller.isBusy()).toBe(false);
  });

  it.each(['', 'A partial answer.'])('stops the response and saves visible cancellation with partial text %s', async (partial) => {
    textContinuation('');
    let signal!: AbortSignal;
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    runtime.sendMessageWithTools = (async function* (_messages, _provider, options) {
      signal = options.signal!;
      if (partial) yield { delta: partial, finishReason: null };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        ready();
      });
    }) as typeof sendMessageWithTools;
    const controller = createChatController(page(vi.fn()), runtime);
    const update = vi.fn();
    const setError = vi.fn();
    const streaming = vi.fn();
    const pending = controller.handleSendMessage('Hello', [], vi.fn(), update, streaming, setError, vi.fn());
    await entered;
    controller.stop();
    expect(signal.aborted).toBe(true);
    expect(controller.isBusy()).toBe(true);
    await pending;
    expect(controller.isBusy()).toBe(false);
    expect(streaming).toHaveBeenLastCalledWith(false);
    expect(setError.mock.calls.every(([error]) => error === null)).toBe(true);
    const expected = `${partial}\n\nResponse stopped.`.trimStart();
    expect(stored.messages.at(-1)?.content).toBe(expected);
    expect(update.mock.calls.at(-1)?.[0]).toBe(expected);
  });

  it.each([false, true])('persists and displays the tool limit even when the final completion fails (%s)', async (fails) => {
    textContinuation('');
    runtime.sendMessageWithTools = (async function* () {
      yield { delta: 'Searching.', finishReason: null };
      yield { delta: '', finishReason: null, toolRoundLimit: 4 };
      if (fails) throw new Error('Final completion unavailable');
      yield { delta: 'No style match verified.', finishReason: 'stop' };
    }) as any;
    const controller = createChatController(page(vi.fn()), runtime);
    const notify = vi.fn();
    const update = vi.fn();
    const setError = vi.fn();
    await controller.handleSendMessage('Find a LoRA', [], vi.fn(), update, vi.fn(), setError, vi.fn(), notify);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Tool limit reached (4 rounds)'));
    expect(stored.messages.at(-1)?.content).toContain('Tool limit reached (4 rounds)');
    expect(update.mock.calls.at(-1)?.[0]).toContain('Tool limit reached (4 rounds)');
    if (fails) expect(setError).toHaveBeenCalledWith('Final completion unavailable');
    else expect(stored.messages.at(-1)?.content).toContain('No style match verified.');
  });

  it('uses the current checkpoint for LoRA searches that omit compatibility arguments', async () => {
    textContinuation('');
    const urls: URL[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return new Response(JSON.stringify(url.pathname.includes('model-versions')
        ? { baseModel: 'Flux.2 D' } : { items: [] }), { status: 200 });
    });
    try {
      runtime.sendMessageWithTools = (async function* (_messages, _provider, options) {
        const result = await options.executeTool('search_civitai_loras', '{}');
        expect(JSON.parse(result as string).baseModel).toBe('Flux.2 D');
        expect(options.cacheableTools).toContain('search_civitai_loras');
        expect(options.cacheableTools).not.toContain('get_form_state');
        yield { delta: 'No compatible match found in this search.', finishReason: 'stop' };
      }) as typeof sendMessageWithTools;
      const access = page(vi.fn());
      access.formState = async () => ({ prompt: '', negativePrompt: '', model: 'Flux.2', modelVersionId: 900 });
      const controller = createChatController(access, runtime);
      const setError = vi.fn();
      await controller.handleSendMessage('Find a LoRA', [], vi.fn(), vi.fn(), vi.fn(), setError, vi.fn());
      expect(urls).toHaveLength(2);
      expect(urls[0].pathname).toBe('/api/v1/model-versions/900');
      expect(urls[1].searchParams.get('baseModels')).toBe('Flux.2 D');
      expect(setError.mock.calls.every(([error]) => error === null)).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('persists a successful action and makes duplicate Apply idempotent', async () => {
    const apply = vi.fn(async () => ({ success: true, error: null }));
    const controller = createChatController(page(apply), runtime);

    expect(await controller.handleResolveAction('action-1', 'apply')).toMatchObject({
      success: true,
      actionStatus: 'applied',
    });
    expect(stored.actions?.[0]).toMatchObject({
      status: 'applied',
      result: { success: true, error: null },
    });

    expect(await controller.handleResolveAction('action-1', 'apply')).toMatchObject({
      success: true,
      actionStatus: 'applied',
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rechecks Generate prerequisites when an existing card is confirmed', async () => {
    stored.actions!.push(createActionRecord({ kind: 'generate' }, 'earlier-turn', 'generate-1', 5));
    const apply = vi.fn(async () => ({ success: true, error: null }));
    const controller = createChatController(page(apply), runtime);

    const blocked = await controller.handleResolveAction('generate-1', 'apply');
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('blocked');
    expect(stored.actions![1].status).toBe('pending');
    expect(apply).not.toHaveBeenCalled();

    await controller.handleResolveAction('action-1', 'apply');
    expect(await controller.handleResolveAction('generate-1', 'apply')).toMatchObject({ success: true });
    expect(apply).toHaveBeenLastCalledWith({ kind: 'generate' });
  });

  it('prevents different cards, inline Apply, answers, and sends from racing a pending mutation', async () => {
    stored.actions!.push(createActionRecord({ kind: 'prompt', positive: 'second' }, 'turn', 'second', 20));
    stored.actions!.push(createActionRecord({ kind: 'question', question: 'Style?', options: ['A', 'B'] }, 'turn', 'question', 20));
    stored.messages.push({ id: 'inline', role: 'assistant', content: '<prompt>third</prompt>', timestamp: 2 });
    textContinuation('Unexpected concurrent send');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const apply = vi.fn(async () => {
      if (apply.mock.calls.length === 1) { started(); await pending; }
      return { success: true, error: null };
    });
    const controller = createChatController(page(apply), runtime);
    const first = controller.handleResolveAction('action-1', 'apply');
    await entered;
    try {
      expect((await controller.handleResolveAction('second', 'apply')).success).toBe(false);
      expect((await controller.handleApplyAssistantMessage('inline', 'replace')).success).toBe(false);
      expect((await controller.handleAnswerQuestion('question', 0)).success).toBe(false);
      const error = vi.fn();
      await controller.handleSendMessage('Another message', [], vi.fn(), vi.fn(), vi.fn(), error, vi.fn());
      expect(error).toHaveBeenCalledWith(expect.stringContaining('action'));
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
    expect(stored.actions!.map((action) => action.status)).toEqual(['applied', 'pending', 'pending']);
  });

  it('does not send an old action result into a newly selected conversation', async () => {
    textContinuation('Unexpected response in the new chat');
    const send = vi.fn(runtime.sendMessageWithTools!);
    runtime.sendMessageWithTools = send;
    let activeId = stored.id;
    const other: Conversation = { id: 'other', title: 'Other', messages: [], actions: [], createdAt: 1, updatedAt: 1 };
    runtime.getActiveConversationId = async () => activeId;
    runtime.getConversation = async (id) => structuredClone(id === other.id ? other : stored);
    const save = runtime.saveConversation!;
    const savedIds: string[] = [];
    runtime.saveConversation = async (conversation) => {
      savedIds.push(conversation.id);
      if (conversation.id === other.id) Object.assign(other, structuredClone(conversation));
      else await save(conversation);
    };
    const controller = createChatController(page(async () => {
      activeId = other.id;
      return { success: true, error: null };
    }), runtime);

    expect(await controller.handleResolveAction('action-1', 'apply', vi.fn(), vi.fn(), vi.fn(), vi.fn()))
      .toMatchObject({ success: true, actionStatus: 'applied' });
    expect(savedIds).not.toContain(other.id);
    expect(send).not.toHaveBeenCalled();
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages.at(-1)).toMatchObject({ internal: true, content: expect.stringContaining('"status":"applied"') });
  });

  it('does not duplicate the assistant reply if its final save fails once', async () => {
    textContinuation('One reply');
    const save = runtime.saveConversation!;
    let failed = false;
    runtime.saveConversation = async (conversation) => {
      // Checkpoints copy the messages array. The final save appends to the live
      // conversation, so fail the second write containing the completed reply.
      if (conversation.messages.at(-1)?.role === 'assistant') {
        if (failed) return save(conversation);
        if (stored.messages.at(-1)?.role === 'assistant') {
          failed = true;
          throw new Error('Temporary storage failure');
        }
      }
      await save(conversation);
    };
    const controller = createChatController(page(async () => ({ success: true, error: null })), runtime);
    const error = vi.fn();
    await controller.handleSendMessage('Hello', [], vi.fn(), vi.fn(), vi.fn(), error, vi.fn());
    expect(failed).toBe(true);
    expect(stored.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(error).toHaveBeenCalledWith('Temporary storage failure');
  });

  it('persists lost acknowledgement as unknown and never retries it', async () => {
    const apply = vi.fn(async () => {
      throw new Error('tab disappeared');
    });
    const controller = createChatController(page(apply), runtime);

    expect(await controller.handleResolveAction('action-1', 'apply')).toMatchObject({
      success: false,
      unknown: true,
      actionStatus: 'unknown',
    });
    expect(stored.actions?.[0].status).toBe('unknown');

    await controller.handleResolveAction('action-1', 'apply');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('persists dismissal without invoking the page', async () => {
    const apply = vi.fn(async () => ({ success: true, error: null }));
    const controller = createChatController(page(apply), runtime);

    expect(await controller.handleResolveAction('action-1', 'dismiss')).toMatchObject({
      success: false,
      actionStatus: 'dismissed',
    });
    expect(stored.actions?.[0].status).toBe('dismissed');
    expect(apply).not.toHaveBeenCalled();
  });

  it('persists a selected question answer before one trusted continuation', async () => {
    const question = createActionRecord(
      { kind: 'question', question: 'Which direction?', options: ['Documentary', 'Neon anime'] },
      'turn-question', 'question-1', 20
    );
    stored.actions = [question];
    const capturedMessages: any[] = [];
    runtime.getActiveProvider = async () => ({
      type: 'openrouter', apiKey: 'test-only', baseURL: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.6-luna',
    });
    runtime.getSettings = async () => ({ ...DEFAULT_SETTINGS, civitaiMcpMode: 'off' });
    runtime.sendMessageWithTools = (async function* (messages: any[]) {
      expect(stored.actions?.[0]).toMatchObject({
        status: 'applied', answer: { optionIndex: 1, text: 'Neon anime' },
      });
      capturedMessages.push(...messages);
      yield { delta: 'I will use the neon anime direction.', finishReason: 'stop' };
    }) as any;
    const apply = vi.fn(async () => ({ success: true, error: null }));
    const controller = createChatController(page(apply), runtime);

    const result = await controller.handleAnswerQuestion(
      'question-1', 1, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()
    );
    expect(result).toMatchObject({ success: true, actionStatus: 'applied' });
    expect(apply).not.toHaveBeenCalled();
    expect(capturedMessages.at(-1).content).toContain('TRUSTED EXTENSION USER ANSWER');
    expect(capturedMessages.at(-1).content).toContain('Neon anime');
    expect(stored.messages.filter((message) => message.internal)).toHaveLength(1);

    await controller.handleAnswerQuestion(
      'question-1', 1, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()
    );
    expect(stored.messages.filter((message) => message.internal)).toHaveLength(1);
  });

  it('rejects an invalid question choice without changing persisted state', async () => {
    stored.actions = [createActionRecord(
      { kind: 'question', question: 'Which direction?', options: ['Documentary', 'Anime'] },
      'turn-question', 'question-1', 20
    )];
    const apply = vi.fn(async () => ({ success: true, error: null }));
    const controller = createChatController(page(apply), runtime);

    await expect(controller.handleAnswerQuestion('question-1', 4)).resolves.toEqual({
      success: false,
      error: 'Choose one of the displayed answers.',
    });
    expect(stored.actions[0].status).toBe('pending');
    expect(stored.actions[0].answer).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });

  it('runs the scripted ask-answer-prompt loop without touching the page', async () => {
    stored.actions = [];
    const requests: LlmProxyRequest[] = [];
    const streams = [
      toolStream('ask_user', {
        question: 'Which direction?',
        options: ['Documentary real', 'Neon anime'],
      }),
      finalStream('Choose a direction and I will continue.'),
      toolStream('propose_prompt', {
        positive: 'neon anime avatar, electric cyan and magenta glow',
        aspectRatio: '1:1',
      }),
      finalStream('I proposed the neon anime prompt; the form is unchanged.'),
    ];
    const streamFetch: LlmStreamFetch = async (request) => {
      requests.push(request);
      const stream = streams.shift();
      if (!stream) throw new Error('unexpected completion');
      return stream;
    };
    runtime.getActiveProvider = async () => ({
      type: 'openrouter', apiKey: 'test-only', baseURL: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.6-luna',
    });
    runtime.getSettings = async () => ({ ...DEFAULT_SETTINGS, civitaiMcpMode: 'off' });
    runtime.sendMessageWithTools = ((messages, provider, options) =>
      sendMessageWithTools(messages, provider, { ...options, streamFetch })) as any;
    const apply = vi.fn(async () => ({ success: true, error: null }));
    const controller = createChatController(page(apply), runtime);

    await controller.handleSendMessage(
      'Make an avatar, but clarify the style first.', [], vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()
    );
    expect(stored.actions.map((record) => record.action.kind)).toEqual(['question']);
    expect(apply).not.toHaveBeenCalled();

    await controller.handleAnswerQuestion(
      stored.actions[0].id, 1, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()
    );
    expect(stored.actions.map((record) => [record.action.kind, record.status])).toEqual([
      ['question', 'applied'],
      ['prompt', 'pending'],
    ]);
    expect(requests).toHaveLength(4);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects a stale card from another conversation', async () => {
    const controller = createChatController(
      page(async () => ({ success: true, error: null })),
      runtime
    );

    expect(await controller.handleResolveAction('missing', 'apply')).toEqual({
      success: false,
      error: 'This action no longer belongs to the active conversation.',
    });
  });

  it('persists a failed result before a hidden trusted continuation turn', async () => {
    const capturedMessages: any[] = [];
    runtime.getActiveProvider = async () => ({
      type: 'openrouter',
      apiKey: 'test-only',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.6-luna',
    });
    runtime.getSettings = async () => DEFAULT_SETTINGS;
    runtime.sendMessageWithTools = (async function* (messages: any[]) {
      capturedMessages.push(...messages);
      expect(stored.actions?.[0].status).toBe('failed');
      yield { delta: 'I could not verify the form change.', finishReason: 'stop' };
    }) as any;
    const controller = createChatController(
      page(async () => ({ success: false, error: 'prompt editor mismatch' })),
      runtime
    );

    const result = await controller.handleResolveAction(
      'action-1',
      'apply',
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    expect(result.actionStatus).toBe('failed');
    expect(capturedMessages.at(-1)).toMatchObject({ role: 'user' });
    expect(capturedMessages.at(-1).content).toContain('TRUSTED EXTENSION ACTION RESULT');
    expect(capturedMessages.at(-1).content).toContain('prompt editor mismatch');
    expect(stored.messages.some((message) => message.internal)).toBe(true);
    expect(stored.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'I could not verify the form change.',
    });
  });

  it('feeds a failed result through the real tool loop and blocks Generate', async () => {
    const requests: LlmProxyRequest[] = [];
    scriptedContinuation('The prompt failed, so I did not offer Generate.', requests);
    const apply = vi.fn(async () => ({ success: false, error: 'prompt editor mismatch' }));
    const appendCard = vi.fn();
    const controller = createChatController(page(apply), runtime);

    await controller.handleResolveAction(
      'action-1',
      'apply',
      vi.fn(),
      vi.fn(),
      vi.fn(),
      appendCard,
      vi.fn()
    );

    expect(requests).toHaveLength(2);
    const firstBody = JSON.parse(requests[0].body as string);
    expect(firstBody.messages.filter((m: { role: string }) => m.role === 'user').at(-1).content).toContain('prompt editor mismatch');
    const secondBody = JSON.parse(requests[1].body as string);
    expect(JSON.parse(secondBody.messages.filter((m: { role: string }) => m.role === 'tool').at(-1).content)).toMatchObject({
      error: expect.stringContaining('Generate is blocked'),
      blockingActionIds: ['action-1'],
    });
    expect(stored.actions).toHaveLength(1);
    expect(stored.actions?.[0].status).toBe('failed');
    expect(appendCard).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(stored.messages.at(-1)?.content).toContain('did not offer Generate');
  });

  it('keeps successful Apply local until the user asks for a separate Generate proposal', async () => {
    const requests: LlmProxyRequest[] = [];
    scriptedContinuation('The prompt is applied. Generate still needs confirmation.', requests);
    let submitAttempts = 0;
    const apply = vi.fn(async (action) => {
      if (action.kind === 'generate') submitAttempts++;
      return { success: true, error: null };
    });
    const appendCard = vi.fn();
    const controller = createChatController(page(apply), runtime);

    await controller.handleResolveAction(
      'action-1',
      'apply',
      vi.fn(),
      vi.fn(),
      vi.fn(),
      appendCard,
      vi.fn()
    );

    expect(requests).toHaveLength(0);
    expect(stored.actions).toHaveLength(1);
    await controller.handleSendMessage('Ready to generate', [], vi.fn(), vi.fn(), vi.fn(), vi.fn(), appendCard);

    expect(stored.actions).toHaveLength(2);
    expect(stored.actions?.map((record) => [record.action.kind, record.status])).toEqual([
      ['prompt', 'applied'],
      ['generate', 'pending'],
    ]);
    expect(appendCard).toHaveBeenCalledWith(
      expect.objectContaining({ action: { kind: 'generate' }, status: 'pending' })
    );
    expect(submitAttempts).toBe(0);

    await controller.handleResolveAction(stored.actions![1].id, 'apply');
    expect(submitAttempts).toBe(1);
    expect(stored.actions?.[1].status).toBe('applied');
  });

  it('links a corrective proposal and releases the failed chain only after correction succeeds', async () => {
    const requests: LlmProxyRequest[] = [];
    scriptedToolContinuation(
      'propose_prompt',
      { positive: 'corrected rainy Berlin', steps: 8, aspectRatio: '16:9' },
      'I proposed a corrected prompt.',
      requests
    );
    let attempts = 0;
    const apply = vi.fn(async () => {
      attempts++;
      return attempts === 1
        ? { success: false, error: 'prompt mismatch' }
        : { success: true, error: null };
    });
    const controller = createChatController(page(apply), runtime);

    await controller.handleResolveAction(
      'action-1',
      'apply',
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    expect(stored.actions).toHaveLength(2);
    expect(stored.actions?.[0].supersededByActionId).toBe(stored.actions?.[1].id);
    expect(stored.actions?.[1].supersedesActionId).toBe('action-1');
    expect(generateBlockers(stored.actions!)).toHaveLength(2);

    await controller.handleResolveAction(stored.actions![1].id, 'apply');
    expect(generateBlockers(stored.actions!)).toEqual([]);
  });

  it.each([
    { success: true, error: null, status: 'applied' },
    { success: false, error: 'CivitAI did not retain the requested prompt value.', status: 'failed' },
  ])('finishes inline Apply locally when verification is $status', async ({ success, error, status }) => {
    stored.actions = [];
    stored.messages.push({
      id: 'assistant-prompt-1',
      role: 'assistant',
      content: '<prompt>rainy Berlin at night</prompt><negative>daylight</negative>',
      timestamp: 2,
    });
    textContinuation('Unexpected continuation');
    const send = vi.fn(runtime.sendMessageWithTools!);
    runtime.sendMessageWithTools = send;
    const messagesBefore = structuredClone(stored.messages);
    const apply = vi.fn(async (action) => {
      expect(stored.actions?.[0]).toMatchObject({
        action,
        status: 'applying',
        presentation: 'inline',
        sourceMessageId: 'assistant-prompt-1',
      });
      return { success, error };
    });
    const controller = createChatController(page(apply), runtime);

    const result = await controller.handleApplyAssistantMessage(
      'assistant-prompt-1',
      'replace'
    );

    expect(result).toMatchObject({ success, error, actionStatus: status });
    expect(apply).toHaveBeenCalledWith({
      kind: 'prompt',
      positive: 'rainy Berlin at night',
      negative: 'daylight',
      params: undefined,
    });
    expect(stored.actions?.[0]).toMatchObject({ status, result: { success, error }, presentation: 'inline' });
    expect(stored.messages).toEqual(messagesBefore);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'replace' as const, unknown: false },
    { mode: 'append' as const, unknown: true },
  ])('reports inline $mode failures and gates explicit retries when unknown=$unknown', async ({ mode, unknown }) => {
    stored.actions = [];
    stored.messages.push({ id: 'failed-inline', role: 'assistant', content: '<prompt>rain</prompt>', timestamp: 2 });
    const error = unknown ? 'Lost contact with the tab.' : 'Could not apply steps — control not found.';
    textContinuation('The form update could not be verified. Check the generator controls.');
    const response = runtime.sendMessageWithTools!;
    const send = vi.fn((...args: Parameters<typeof response>) => {
      expect(stored.actions![0].status).toBe(unknown ? 'unknown' : 'failed');
      return response(...args);
    });
    runtime.sendMessageWithTools = send;
    const apply = vi.fn(async () => ({ success: false, error, ...(unknown ? { unknown: true } : {}) }));
    const livePage = page(apply);
    livePage.pageContext = async () => ({ form: { availableFields: ['prompt'], prompt: 'rain' } });
    const controller = createChatController(livePage, runtime);
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()] as const;

    const result = await controller.handleApplyAssistantMessage('failed-inline', mode, ...callbacks);
    expect(result).toMatchObject({ success: false, error, actionStatus: unknown ? 'unknown' : 'failed' });
    expect(send).toHaveBeenCalledTimes(1);
    const sentMessages = send.mock.calls[0][0];
    const event = sentMessages.find((message) => String(message.content).includes('TRUSTED EXTENSION ACTION RESULT'));
    expect(event?.content).toContain(error);
    expect(event?.content).toContain('availableFields');
    expect(sentMessages[0].content).toContain('Do not claim a UI change is confirmed without evidence');
    expect(stored.messages.at(-1)?.content).toContain('could not be verified');

    await controller.handleApplyAssistantMessage('failed-inline', mode, ...callbacks);
    expect(apply).toHaveBeenCalledTimes(unknown ? 1 : 2);
    expect(send).toHaveBeenCalledTimes(unknown ? 1 : 2);
  });

  it('does not explain an inline failure in a newly selected chat', async () => {
    stored.actions = [];
    stored.messages.push({ id: 'old-inline', role: 'assistant', content: '<prompt>rain</prompt>', timestamp: 2 });
    let activeId = stored.id;
    runtime.getActiveConversationId = async () => activeId;
    textContinuation('Unexpected response');
    const send = vi.fn(runtime.sendMessageWithTools!);
    runtime.sendMessageWithTools = send;
    const controller = createChatController(page(async () => {
      activeId = 'different-chat';
      return { success: false, error: 'Control not found' };
    }), runtime);
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()] as const;
    expect(await controller.handleApplyAssistantMessage('old-inline', 'replace', ...callbacks))
      .toMatchObject({ success: false, actionStatus: 'failed' });
    expect(send).not.toHaveBeenCalled();
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled();
  });

  it('keeps successful inline Apply local even with continuation callbacks wired', async () => {
    stored.actions = [];
    stored.messages.push({ id: 'success-inline', role: 'assistant', content: '<prompt>rain</prompt>', timestamp: 2 });
    textContinuation('Unexpected response');
    const send = vi.fn(runtime.sendMessageWithTools!);
    runtime.sendMessageWithTools = send;
    const controller = createChatController(page(async () => ({ success: true, error: null })), runtime);
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()] as const;
    expect(await controller.handleApplyAssistantMessage('success-inline', 'replace', ...callbacks)).toMatchObject({ success: true });
    expect(send).not.toHaveBeenCalled();
    expect(callbacks[0]).not.toHaveBeenCalled();
    expect(stored.messages).toHaveLength(2);
  });

  it('rejects explanatory prose and lets an explicit replace retry resolve an old failed Apply', async () => {
    stored.actions = [];
    stored.messages.push({ id: 'explanation', role: 'assistant', content: 'The Apply action failed. Check the page.', timestamp: 2 });
    stored.messages.push({ id: 'payload', role: 'assistant', content: '<prompt>rain</prompt>', timestamp: 3 });
    const apply = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'Verification mismatch' })
      .mockResolvedValue({ success: true, error: null });
    const controller = createChatController(page(apply), runtime);
    expect((await controller.handleApplyAssistantMessage('explanation', 'replace')).success).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    await controller.handleApplyAssistantMessage('payload', 'replace');
    expect(generateBlockers(stored.actions!)).toHaveLength(1);
    expect((await controller.handleApplyAssistantMessage('payload', 'replace')).success).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(stored.actions![1].supersedesActionId).toBe(stored.actions![0].id);
    expect(generateBlockers(stored.actions!)).toHaveLength(0);
    await controller.handleApplyAssistantMessage('payload', 'replace');
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('verifiably appends prompt text while dropping parameters absent from the live form', async () => {
    stored.actions = [];
    stored.messages.push({
      id: 'assistant-prompt-2',
      role: 'assistant',
      content:
        '<prompt>cinematic rain</prompt><negative>blur</negative><params>steps: 10\nsampler: Euler</params>',
      timestamp: 2,
    });
    const send = vi.fn();
    runtime.sendMessageWithTools = send;
    const formState = {
      prompt: 'existing scene',
      negativePrompt: 'existing negative',
      steps: 8,
      availableFields: ['prompt', 'negativePrompt', 'steps'],
    };
    const apply = vi.fn(async () => ({ success: true, error: null }));
    const livePage = page(apply);
    livePage.formState = async () => formState;
    const controller = createChatController(livePage, runtime);

    await controller.handleApplyAssistantMessage(
      'assistant-prompt-2',
      'append'
    );

    expect(apply).toHaveBeenCalledWith({
      kind: 'prompt',
      positive: 'existing scene, cinematic rain',
      negative: 'existing negative, blur',
      params: { steps: 10 },
    });

    await controller.handleApplyAssistantMessage(
      'assistant-prompt-2',
      'append'
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('persists a lost inline Apply acknowledgement as unknown and never retries it', async () => {
    stored.actions = [];
    stored.messages.push({
      id: 'assistant-prompt-3',
      role: 'assistant',
      content: '<prompt>rain on glass</prompt>',
      timestamp: 2,
    });
    const send = vi.fn();
    runtime.sendMessageWithTools = send;
    const apply = vi.fn(async () => {
      throw new Error('tab disappeared');
    });
    const controller = createChatController(page(apply), runtime);

    expect(
      await controller.handleApplyAssistantMessage(
        'assistant-prompt-3',
        'replace'
      )
    ).toMatchObject({ success: false, unknown: true, actionStatus: 'unknown' });
    expect(stored.actions?.[0].status).toBe('unknown');

    await controller.handleApplyAssistantMessage(
      'assistant-prompt-3',
      'replace'
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
