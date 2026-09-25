import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { PAGE_BRIDGE_MSG, registerPageBridge, activeCivitaiTab, pageRequest, type PageBridgeHandlers } from '@/lib/page-bridge';

/** Register the bridge and capture the raw onMessage listener it installs. */
function setup(handlers: PageBridgeHandlers) {
  const addListenerSpy = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  registerPageBridge(handlers);
  const listener = addListenerSpy.mock.calls[0][0] as (
    msg: any,
    sender: any,
    sendResponse: (resp: unknown) => void
  ) => unknown;
  return listener;
}

function makeHandlers(): PageBridgeHandlers {
  return {
    route: vi.fn(),
    formState: vi.fn(),
    applyAction: vi.fn(),
    pageContext: vi.fn(),
    pageImages: vi.fn(),
    generatorImages: vi.fn(),
    openImageUrl: vi.fn(),
    catalogTool: vi.fn(),
  };
}

describe('registerPageBridge', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  afterEach(() => {
    // vi.spyOn on an already-spied method reuses the same spy (and its call
    // history) instead of rewrapping the original, so each test must restore
    // before the next one spies on browser.runtime.onMessage.addListener again.
    vi.restoreAllMocks();
  });

  it('dispatches simple ops to their handlers and resolves {ok:true,result} via sendResponse', async () => {
    const handlers = makeHandlers();
    (handlers.route as any).mockReturnValue({ url: 'https://civitai.com/x', path: '/x', onGeneratePage: false });
    (handlers.formState as any).mockReturnValue({ some: 'state' });
    (handlers.applyAction as any).mockResolvedValue({ success: true, error: null });
    (handlers.pageContext as any).mockResolvedValue({ ctx: 1 });
    (handlers.generatorImages as any).mockReturnValue([{ slot: 'source', url: 'https://x/img.jpg' }]);
    (handlers.openImageUrl as any).mockReturnValue(null);
    const listener = setup(handlers);

    const cases: Array<[string, Record<string, unknown> | undefined, unknown]> = [
      ['route', undefined, { url: 'https://civitai.com/x', path: '/x', onGeneratePage: false }],
      ['formState', undefined, { some: 'state' }],
      ['applyAction', { action: { kind: 'noop' } }, { success: true, error: null }],
      ['pageContext', undefined, { ctx: 1 }],
      ['generatorImages', undefined, [{ slot: 'source', url: 'https://x/img.jpg' }]],
      ['openImageUrl', undefined, null],
    ];

    for (const [op, args, expected] of cases) {
      const sendResponse = vi.fn();
      const ret = listener({ type: PAGE_BRIDGE_MSG, op, ...args }, {}, sendResponse);
      expect(ret).toBe(true);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, result: expected }));
    }

    expect(handlers.applyAction).toHaveBeenCalledWith({ kind: 'noop' });
  });

  it('pageImages defaults limit to 4 when the given limit is not a number', async () => {
    const handlers = makeHandlers();
    (handlers.pageImages as any).mockReturnValue(['a', 'b']);
    const listener = setup(handlers);
    const sendResponse = vi.fn();

    listener({ type: PAGE_BRIDGE_MSG, op: 'pageImages', limit: 'not-a-number' }, {}, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(handlers.pageImages).toHaveBeenCalledWith(4);
  });

  it('pageImages forwards a valid numeric limit', async () => {
    const handlers = makeHandlers();
    (handlers.pageImages as any).mockReturnValue(['a']);
    const listener = setup(handlers);
    const sendResponse = vi.fn();

    listener({ type: PAGE_BRIDGE_MSG, op: 'pageImages', limit: 2 }, {}, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(handlers.pageImages).toHaveBeenCalledWith(2);
  });

  it('maps a thrown handler error to {ok:false,error}', async () => {
    const handlers = makeHandlers();
    (handlers.route as any).mockImplementation(() => {
      throw new Error('route boom');
    });
    const listener = setup(handlers);
    const sendResponse = vi.fn();

    listener({ type: PAGE_BRIDGE_MSG, op: 'route' }, {}, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'route boom' }));
  });

  it('runs catalog lookups in the page handler and preserves their structured result', async () => {
    const handlers = makeHandlers();
    const result = JSON.stringify({ count: 0, source: { origin: 'https://civitai.red' } });
    vi.mocked(handlers.catalogTool).mockResolvedValue(result);
    const listener = setup(handlers);
    const respond = vi.fn();
    listener({ type: PAGE_BRIDGE_MSG, op: 'catalogTool', name: 'search_civitai_loras', args: '{"nsfw":true}', token: 'test-only' }, {}, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true, result }));
    expect(handlers.catalogTool).toHaveBeenCalledWith('search_civitai_loras', '{"nsfw":true}', 'test-only');
  });

  it('cancels waiting for a read-only catalog request without waiting for the tab reply', async () => {
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = pageRequest(1, 'catalogTool', { name: 'get_civitai_base_models', args: '{}' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('yields {ok:false,error} for an unknown op', async () => {
    const handlers = makeHandlers();
    const listener = setup(handlers);
    const sendResponse = vi.fn();

    const ret = listener({ type: PAGE_BRIDGE_MSG, op: 'notARealOp' }, {}, sendResponse);
    expect(ret).toBe(true);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'unknown page op: notARealOp' })
    );
  });

  it('ignores non-bridge messages and messages with a non-string op', () => {
    const handlers = makeHandlers();
    const listener = setup(handlers);

    const sendResponse1 = vi.fn();
    expect(listener({ type: 'some:other:message', op: 'route' }, {}, sendResponse1)).toBeUndefined();
    expect(sendResponse1).not.toHaveBeenCalled();

    const sendResponse2 = vi.fn();
    expect(listener({ type: PAGE_BRIDGE_MSG, op: 42 }, {}, sendResponse2)).toBeUndefined();
    expect(sendResponse2).not.toHaveBeenCalled();

    expect(handlers.route).not.toHaveBeenCalled();
  });
});

describe('activeCivitaiTab', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the active tab for civitai.com and civitai.red hosts', async () => {
    const querySpy = vi.spyOn(fakeBrowser.tabs, 'query');

    querySpy.mockResolvedValueOnce([{ id: 1, url: 'https://civitai.com/models/1' } as any]);
    expect(await activeCivitaiTab()).toEqual({ id: 1, url: 'https://civitai.com/models/1' });

    querySpy.mockResolvedValueOnce([{ id: 2, url: 'https://www.civitai.red/models/2' } as any]);
    expect(await activeCivitaiTab()).toEqual({ id: 2, url: 'https://www.civitai.red/models/2' });
  });

  it('rejects non-https and non-civitai hosts, returning null', async () => {
    const querySpy = vi.spyOn(fakeBrowser.tabs, 'query');

    querySpy.mockResolvedValueOnce([{ id: 1, url: 'http://civitai.com/models/1' } as any]);
    expect(await activeCivitaiTab()).toBeNull();

    querySpy.mockResolvedValueOnce([{ id: 2, url: 'https://example.com/' } as any]);
    expect(await activeCivitaiTab()).toBeNull();
  });

  it('returns null when no active tab matches the query', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValueOnce([]);
    expect(await activeCivitaiTab()).toBeNull();
  });

  it('queries with the given windowId when provided, otherwise falls back to lastFocusedWindow', async () => {
    const querySpy = vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([]);

    await activeCivitaiTab(7);
    expect(querySpy).toHaveBeenCalledWith({ active: true, windowId: 7 });

    await activeCivitaiTab();
    expect(querySpy).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
  });
});
