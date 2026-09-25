/**
 * Conversation writes routed through the background service worker.
 *
 * chrome.storage has no transactions, and conversations live in one array — two tabs
 * finishing a chat around the same time would each read-modify-write the whole array
 * and the last writer would drop the other's conversation. The background applies all
 * writes through a single serial queue, so they compose instead of clobbering.
 * Reads stay direct (see lib/storage.ts) — they don't mutate.
 */
import type { Conversation } from './types';
import { saveConversationDirect, deleteConversationDirect } from './storage';

export const CONV_MSG = 'cllp:conversations';

type ConvMessage =
  | { type: typeof CONV_MSG; op: 'save'; conversation: Conversation }
  | { type: typeof CONV_MSG; op: 'delete'; id: string };

// --- background side ---

export function registerConversationHost(): void {
  let queue: Promise<unknown> = Promise.resolve();
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message as ConvMessage).type !== CONV_MSG) return;
    const msg = message as ConvMessage;
    const task =
      msg.op === 'save'
        ? () => saveConversationDirect(msg.conversation)
        : () => deleteConversationDirect(msg.id);
    const run = queue.then(task, task); // run even if a previous write failed
    queue = run;
    run.then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    );
    return true; // async response
  });
}

// --- content-script side ---

async function convRpc(msg: ConvMessage): Promise<void> {
  const response = (await browser.runtime.sendMessage(msg)) as
    | { ok: boolean; error?: string }
    | undefined;
  if (!response) throw new Error('conversation rpc: no response (background unavailable?)');
  if (!response.ok) throw new Error(`conversation rpc: ${response.error}`);
}

export function saveConversation(conversation: Conversation): Promise<void> {
  return convRpc({ type: CONV_MSG, op: 'save', conversation });
}

export function deleteConversation(id: string): Promise<void> {
  return convRpc({ type: CONV_MSG, op: 'delete', id });
}
