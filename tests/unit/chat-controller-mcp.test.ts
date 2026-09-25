import { describe, expect, it, vi } from 'vitest';
import { createChatController, type ChatControllerRuntime, type PageAccess } from '@/lib/chat-controller';
import type { Conversation } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/constants';

function harness(mode: 'read' | 'full', executeMcp = vi.fn(async () => JSON.stringify({
  source: 'CivitAI Site MCP', content: 'ok',
}))) {
  let stored: Conversation | null = null;
  let activeId: string | null = null;
  const runtime: Partial<ChatControllerRuntime> = {
    getActiveConversationId: async () => activeId,
    setActiveConversationId: async (id) => { activeId = id; },
    getConversation: async (id) => stored?.id === id ? structuredClone(stored) : null,
    saveConversation: async (conversation) => { stored = structuredClone(conversation); },
    deleteConversation: async () => {},
    getActiveProvider: async () => ({
      type: 'openrouter', apiKey: 'test-only', baseURL: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-5.6-luna',
    }),
    getSettings: async () => ({ ...DEFAULT_SETTINGS, civitaiMcpMode: mode, civitaiApiToken: 'token' }),
    getSiteMcpTools: async () => [
      {
        definition: { type: 'function', function: {
          name: 'search_images', description: 'Search images',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        } },
        readOnly: true, destructive: false,
      },
      ...(mode === 'full' ? [{
        definition: { type: 'function' as const, function: {
          name: 'delete_post', description: 'Delete a post',
          parameters: { type: 'object', properties: { id: { type: 'integer' } } },
        } },
        readOnly: false, destructive: true,
      }] : []),
    ],
    executeSiteMcpTool: executeMcp,
  };
  const page: PageAccess = {
    onGeneratePage: async () => false,
    formState: async () => null,
    pageContext: async () => ({ route: '/images' }),
    pageImages: async () => [], generatorImages: async () => [],
    applyAction: async () => ({ success: true, error: null }),
  };
  return { runtime, page, executeMcp, getStored: () => stored };
}

describe('chat controller Site MCP integration', () => {
  it('routes built-in catalog tools through the page session while keeping Site MCP separate', async () => {
    const h = harness('read');
    h.page.catalogTool = vi.fn(async () => JSON.stringify({ count: 0, source: { origin: 'https://civitai.red' } }));
    h.runtime.sendMessageWithTools = (async function* (_messages: any[], _provider: any, options: any) {
      await options.executeTool('search_civitai_loras', '{"nsfw":true}', new AbortController().signal);
      yield { delta: 'No results in this search.', finishReason: 'stop' };
    }) as any;
    const controller = createChatController(h.page, h.runtime);
    await controller.handleSendMessage('Search the catalog', [], vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    expect(h.page.catalogTool).toHaveBeenCalledWith('search_civitai_loras', '{"nsfw":true}', 'token', expect.any(AbortSignal));
    expect(h.executeMcp).not.toHaveBeenCalled();
  });
  it('executes annotated reads immediately in the model tool loop', async () => {
    const h = harness('read');
    h.runtime.sendMessageWithTools = (async function* (_messages: any[], _provider: any, options: any) {
      expect(options.tools.map((tool: any) => tool.function.name)).toContain('search_images');
      await options.executeTool('search_images', '{"query":"rain"}', new AbortController().signal);
      yield { delta: 'Grounded result.', finishReason: 'stop' };
    }) as any;
    const controller = createChatController(h.page, h.runtime);
    await controller.handleSendMessage('Find rain', [], vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());

    expect(h.executeMcp).toHaveBeenCalledWith('search_images', '{"query":"rain"}', 'token', expect.any(AbortSignal));
  });

  it('persists a generic confirmation card and executes a write only after Apply', async () => {
    const h = harness('full');
    const appendCard = vi.fn();
    h.runtime.sendMessageWithTools = (async function* (_messages: any[], _provider: any, options: any) {
      const proposed = JSON.parse(await options.executeTool(
        'delete_post', '{"id":42}', new AbortController().signal
      ));
      expect(proposed.status).toBe('proposed');
      yield { delta: 'Please confirm.', finishReason: 'stop' };
    }) as any;
    const controller = createChatController(h.page, h.runtime);
    await controller.handleSendMessage('Delete it', [], vi.fn(), vi.fn(), vi.fn(), vi.fn(), appendCard);

    expect(h.executeMcp).not.toHaveBeenCalled();
    const action = h.getStored()!.actions![0];
    expect(action.action).toEqual({
      kind: 'mcpTool', toolName: 'delete_post', args: { id: 42 },
      title: undefined, destructive: true,
    });
    const result = await controller.handleResolveAction(action.id, 'apply');
    expect(result).toMatchObject({ success: true, actionStatus: 'applied' });
    expect(h.executeMcp).toHaveBeenCalledWith('delete_post', '{"id":42}', 'token');
  });
});
