/**
 * Background-routed LLM fetches.
 *
 * MV3 content scripts inherit the PAGE's CORS policy — `host_permissions` do not exempt
 * them — so LLM calls made from the chat panel only worked because x.ai/OpenRouter happen
 * to serve permissive CORS headers. The background service worker IS exempt for origins
 * listed in `host_permissions`, so all provider traffic is routed through it: a Port-based
 * streaming proxy for SSE responses plus a plain request/response RPC for non-streaming
 * calls. A custom provider on another origin works when its server sends permissive CORS
 * or its origin is added to `host_permissions`.
 *
 * The proxy is transport-only: it never reads settings or logs headers/bodies (they carry
 * API keys and chat content).
 */

export const LLM_STREAM_PORT = 'cllp:llmstream';
export const LLM_FETCH_MSG = 'cllp:llmfetch';

export interface LlmProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface LlmStreamHead {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  /** Error body text — present when !ok (the stream ends right after the head). */
  bodyText?: string;
}

type StreamMsg =
  | { kind: 'head'; head: LlmStreamHead }
  | { kind: 'chunk'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

// --- background side ---

export function registerLlmProxyHost(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== LLM_STREAM_PORT) return;
    const abort = new AbortController();
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
      abort.abort();
    });
    const post = (msg: StreamMsg) => {
      if (disconnected) return;
      try {
        port.postMessage(msg);
      } catch {
        disconnected = true;
      }
    };
    port.onMessage.addListener((req: LlmProxyRequest | { kind: 'ping' }) => {
      // Keepalive heartbeats: port TRAFFIC resets the service worker's idle timer (an idle
      // open port does not), so the client pings while waiting on a slow model. Must not
      // start another fetch.
      if ('kind' in req && req.kind === 'ping') return;
      const request = req as LlmProxyRequest;
      void (async () => {
        try {
          const r = await fetch(request.url, {
            method: request.method ?? 'POST',
            headers: request.headers,
            body: request.body,
            signal: abort.signal,
          });
          if (!r.ok) {
            const bodyText = await r.text().catch(() => 'Unknown error');
            post({
              kind: 'head',
              head: { ok: false, status: r.status, retryAfter: r.headers.get('retry-after'), bodyText },
            });
            post({ kind: 'done' });
            return;
          }
          post({ kind: 'head', head: { ok: true, status: r.status, retryAfter: null } });
          const reader = r.body?.getReader();
          if (!reader) {
            post({ kind: 'error', message: 'No response body received.' });
            return;
          }
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            const text = decoder.decode(value ?? new Uint8Array(), { stream: !done });
            if (text) post({ kind: 'chunk', text });
            if (done) break;
          }
          post({ kind: 'done' });
        } catch (err) {
          post({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
        }
      })();
    });
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== LLM_FETCH_MSG) return;
    const req = message.request as LlmProxyRequest;
    void (async () => {
      try {
        const r = await fetch(req.url, {
          method: req.method ?? 'POST',
          headers: req.headers,
          body: req.body,
        });
        const bodyText = await r.text().catch(() => '');
        sendResponse({ ok: r.ok, status: r.status, bodyText });
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : 'Network error' });
      }
    })();
    return true;
  });
}

// --- content-script side ---

export interface LlmStream {
  head: LlmStreamHead;
  /** SSE text chunks. Ends on stream completion; throws on transport error or abort. */
  chunks: AsyncGenerator<string, void, void>;
}

/**
 * Open a streaming LLM request through the background proxy. Resolves once response
 * headers are in (so callers can map HTTP errors before consuming the body).
 */
export async function llmStreamFetch(req: LlmProxyRequest, signal?: AbortSignal): Promise<LlmStream> {
  const port = browser.runtime.connect({ name: LLM_STREAM_PORT });
  const queue: StreamMsg[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  const wake = () => {
    notify?.();
    notify = null;
  };
  port.onMessage.addListener((msg: StreamMsg) => {
    queue.push(msg);
    wake();
  });
  // Heartbeat: only port TRAFFIC resets the MV3 service worker's idle timer, so a model
  // that thinks silently for 30s+ before the first token could get the worker (and our
  // in-flight fetch) killed. Ping well under the timeout while the stream is open.
  const heartbeat = setInterval(() => {
    try {
      port.postMessage({ kind: 'ping' });
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);
  port.onDisconnect.addListener(() => {
    closed = true;
    clearInterval(heartbeat);
    wake();
  });
  const onAbort = () => {
    closed = true;
    clearInterval(heartbeat);
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    wake();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  port.postMessage(req);

  const next = async (): Promise<StreamMsg | null> => {
    while (true) {
      const msg = queue.shift();
      if (msg) return msg;
      if (closed || signal?.aborted) return null;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  };

  const first = await next();
  if (!first) throw abortOrError(signal, 'LLM request failed (background unavailable?).');
  if (first.kind === 'error') throw new Error(first.message);
  if (first.kind !== 'head') throw new Error('LLM proxy protocol error.');

  async function* chunks(): AsyncGenerator<string, void, void> {
    try {
      while (true) {
        const msg = await next();
        if (!msg) throw abortOrError(signal, 'LLM stream disconnected.');
        if (msg.kind === 'chunk') yield msg.text;
        else if (msg.kind === 'done') return;
        else if (msg.kind === 'error') throw new Error(msg.message);
      }
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    }
  }
  return { head: first.head, chunks: chunks() };
}

/** Non-streaming request through the background proxy (e.g. the connection test). */
export async function llmFetchText(
  req: LlmProxyRequest
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const response = (await browser.runtime.sendMessage({ type: LLM_FETCH_MSG, request: req })) as
    | { ok: boolean; status: number; bodyText: string }
    | { error: string }
    | undefined;
  if (!response) throw new Error('LLM request failed (background unavailable?).');
  if ('error' in response) throw new Error(response.error);
  return response;
}

function abortOrError(signal: AbortSignal | undefined, message: string): Error {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError'; // callers filter aborts by name, matching fetch() semantics
    return err;
  }
  return new Error(message);
}
