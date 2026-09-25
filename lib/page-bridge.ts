/**
 * Page bridge: lets extension pages (the side panel) drive the CivitAI tab's DOM.
 *
 * The chat UI historically lived inside the content script and called dom-bridge
 * directly. Hosted in Chrome's side panel it has no DOM access, so every page
 * operation goes through this request/response protocol over tabs.sendMessage:
 * the content script registers handlers (registerPageBridge), the side panel
 * calls them per-tab (pageRequest / PageBridgeClient).
 */
import type { FormState, GeneratorImage } from './types';
import type { ProposedAction } from './page-tools';

export const PAGE_BRIDGE_MSG = 'cllp:page';

export interface PageBridgeHandlers {
  route(): { url: string; path: string; onGeneratePage: boolean };
  formState(): FormState | null;
  applyAction(action: ProposedAction): Promise<{ success: boolean; error: string | null }>;
  pageContext(): Promise<Record<string, unknown>>;
  pageImages(limit: number): string[];
  generatorImages(): GeneratorImage[];
  openImageUrl(): string | null;
  catalogTool(name: string, args: string, token?: string): Promise<string>;
}

type Op = keyof PageBridgeHandlers;

/** Content-script side: answer page-bridge requests with real DOM work. */
export function registerPageBridge(handlers: PageBridgeHandlers): void {
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== PAGE_BRIDGE_MSG || typeof msg.op !== 'string') return;
    const op = msg.op as Op;
    Promise.resolve()
      .then((): unknown => {
        switch (op) {
          case 'route':
            return handlers.route();
          case 'formState':
            return handlers.formState();
          case 'applyAction':
            return handlers.applyAction(msg.action as ProposedAction);
          case 'pageContext':
            return handlers.pageContext();
          case 'pageImages':
            return handlers.pageImages(Number(msg.limit) || 4);
          case 'generatorImages':
            return handlers.generatorImages();
          case 'openImageUrl':
            return handlers.openImageUrl();
          case 'catalogTool':
            return handlers.catalogTool(msg.name, msg.args, msg.token);
          default:
            throw new Error(`unknown page op: ${op}`);
        }
      })
      .then(
        (result) => sendResponse({ ok: true, result }),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
    return true; // async sendResponse
  });
}

const CIVITAI_TAB_URL = /^https:\/\/(www\.)?civitai\.(com|red)\//;

/**
 * The active CivitAI tab, else null. Pass the calling panel's own windowId — querying
 * lastFocusedWindow instead would make every panel follow the globally-focused window,
 * so a panel in window B could silently act on window A's tab.
 */
export async function activeCivitaiTab(windowId?: number): Promise<{ id: number; url: string } | null> {
  const [tab] = await browser.tabs.query(
    windowId !== undefined ? { active: true, windowId } : { active: true, lastFocusedWindow: true }
  );
  if (tab?.id != null && CIVITAI_TAB_URL.test(tab.url ?? '')) return { id: tab.id, url: tab.url! };
  return null;
}

/** Extension-page side: run one op against a tab's content script. Throws on failure. */
export async function pageRequest<T>(tabId: number, op: Op, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let abort: (() => void) | undefined;
  let resp: any;
  try {
    const request = browser.tabs.sendMessage(tabId, { type: PAGE_BRIDGE_MSG, op, ...args });
    resp = await (signal ? Promise.race([request, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]) : request);
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
  if (!resp?.ok) throw new Error(resp?.error ?? 'page request failed');
  return resp.result as T;
}
