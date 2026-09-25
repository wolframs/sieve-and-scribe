/** Background-owned RPC for the fixed CivitAI Site MCP endpoint. */
import {
  callSiteMcpTool,
  discoverSiteMcpTools,
  type CivitaiMcpMode,
  type SiteMcpTool,
} from './civitai-mcp';

export const CIVITAI_MCP_MSG = 'cllp:civitai-mcp';

type McpMessage =
  | { type: typeof CIVITAI_MCP_MSG; op: 'discover'; requestId: string; mode: CivitaiMcpMode; token?: string }
  | { type: typeof CIVITAI_MCP_MSG; op: 'call'; requestId: string; name: string; args: string; token?: string }
  | { type: typeof CIVITAI_MCP_MSG; op: 'cancel'; requestId: string };

type McpResponse = { ok: true; result: unknown } | { ok: false; error: string; aborted?: boolean };

export function registerCivitaiMcpHost(): void {
  const inflight = new Map<string, AbortController>();
  const cached = new Map<string, { expiresAt: number; tools: SiteMcpTool[] }>();

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message as McpMessage).type !== CIVITAI_MCP_MSG) return;
    const msg = message as McpMessage;
    if (msg.op === 'cancel') {
      inflight.get(msg.requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    inflight.set(msg.requestId, controller);
    const cacheKey = msg.op === 'discover' ? `${msg.mode}:${Boolean(msg.token)}` : '';
    const entry = cached.get(cacheKey);
    const task = msg.op === 'discover'
      ? (entry && entry.expiresAt > Date.now()
          ? Promise.resolve(entry.tools)
          : discoverSiteMcpTools(msg.mode, { signal: controller.signal, token: msg.token }).then((tools) => {
              cached.set(cacheKey, { expiresAt: Date.now() + 60 * 60_000, tools });
              return tools;
            }))
      : callSiteMcpTool(msg.name, msg.args, { signal: controller.signal, token: msg.token });
    task.then(
      (result) => sendResponse({ ok: true, result } satisfies McpResponse),
      (error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        aborted: error instanceof Error && error.name === 'AbortError',
      } satisfies McpResponse)
    ).finally(() => inflight.delete(msg.requestId));
    return true;
  });
}

async function mcpRpc<T>(
  op: 'discover' | 'call',
  payload: { mode?: CivitaiMcpMode; name?: string; args?: string; token?: string },
  signal?: AbortSignal
): Promise<T> {
  const requestId = crypto.randomUUID();
  if (signal?.aborted) {
    const error = new Error('CivitAI Site MCP request was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    void browser.runtime.sendMessage({ type: CIVITAI_MCP_MSG, op: 'cancel', requestId }).catch(() => {});
    const error = new Error('CivitAI Site MCP request was aborted.');
    error.name = 'AbortError';
    rejectAbort?.(error);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const message: McpMessage = op === 'discover'
      ? { type: CIVITAI_MCP_MSG, op, requestId, mode: payload.mode!, token: payload.token }
      : { type: CIVITAI_MCP_MSG, op, requestId, name: payload.name!, args: payload.args ?? '{}', token: payload.token };
    const request = browser.runtime.sendMessage(message) as Promise<McpResponse | undefined>;
    const response = await (signal ? Promise.race([request, aborted]) : request);
    if (!response) throw new Error('CivitAI Site MCP background host is unavailable.');
    if (!response.ok) {
      const error = new Error(response.error);
      if (response.aborted) error.name = 'AbortError';
      throw error;
    }
    return response.result as T;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function getSiteMcpTools(
  mode: CivitaiMcpMode,
  token?: string,
  signal?: AbortSignal
): Promise<SiteMcpTool[]> {
  return mcpRpc('discover', { mode, token }, signal);
}

export async function executeSiteMcpTool(
  name: string,
  args: string,
  token?: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    return await mcpRpc('call', { name, args, token }, signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'CivitAI Site MCP request failed.',
      source: 'CivitAI Site MCP',
    });
  }
}
