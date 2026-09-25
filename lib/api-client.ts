import type { ChatMessage, ContentPart, ProviderConfig, StreamChunk } from './types';
import type { ToolDefinition } from './civitai-tools';
import {
  llmFetchText,
  llmStreamFetch,
  type LlmProxyRequest,
  type LlmStream,
} from './llm-proxy';
import { toProviderContent } from './chat-images';
import { recordDebugEvent, sanitizeDiagnosticText } from './diagnostic-log';

/** Injectable streaming transport used by protocol tests and the opt-in Node evaluation rig. */
export type LlmStreamFetch = (
  request: LlmProxyRequest,
  signal?: AbortSignal
) => Promise<LlmStream>;

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** OpenRouter includes USD cost on usage chunks when available. */
  cost?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheDiscount?: number;
}

/** Internal OpenAI-shaped message, including assistant tool_calls and tool replies. */
interface ToolLoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // Multimodal user messages pass an array of parts straight through to the API.
  content: string | ContentPart[] | null;
  tool_calls?: AssembledToolCall[];
  tool_call_id?: string;
}

interface AssembledToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * A tool may return a plain string (the usual case) or, to let the model SEE images it
 * requested, an object with image URLs — these are injected as a follow-up user turn so
 * the next completion has them in view.
 */
export interface ToolImage {
  url: string;
  label?: string;
}

export type ToolResult = string | { content: string; images?: ToolImage[] };

/**
 * Prompt caching: xAI, OpenAI-style, and Gemini models cache input prefixes
 * automatically, but Anthropic (and Qwen) models routed via OpenRouter only
 * cache blocks explicitly marked with cache_control breakpoints. Mark the
 * system prompt — the largest stable prefix (~5k tokens) — as cacheable.
 * Cache reads are billed at a fraction of base input price (0.1x for Claude).
 */
function applyPromptCaching<T extends { role: string; content: unknown }>(
  messages: T[],
  provider: ProviderConfig,
  model: string
): T[] {
  if (provider.type !== 'openrouter' || !/^(anthropic|qwen)\//.test(model)) return messages;
  return messages.map((m) =>
    m.role === 'system' && typeof m.content === 'string'
      ? { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
      : m
  );
}

/**
 * Send messages to an OpenAI-compatible chat completions API with streaming.
 * Yields content deltas as they arrive.
 */
export async function* sendMessage(
  messages: ChatMessage[],
  provider: ProviderConfig,
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    signal?: AbortSignal;
  } = {}
): AsyncGenerator<StreamChunk> {
  const {
    temperature = 0.7,
    maxTokens = 2048,
    model,
    signal,
  } = options;

  const result = yield* streamCompletion(
    messages.map((m) => ({ role: m.role, content: toProviderContent(m.content) })),
    provider,
    { temperature, maxTokens, model, signal, streamFetch: llmStreamFetch }
  );
  if (result.toolCalls.length) {
    throw new Error('The provider requested tools during a text-only response.');
  }
}

/**
 * Extract the payload of an SSE `data:` line, or null for non-data lines.
 * The SSE spec allows `data:{...}` with no space — several OpenAI-compatible
 * servers emit exactly that.
 */
function ssePayload(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  return trimmed.slice(5).trimStart();
}

/**
 * Streaming chat with an OpenAI-compatible tool-calling loop.
 *
 * Yields content deltas as they arrive. When the model requests tools, it
 * yields tool activity at the start and completion of each call, runs `executeTool`, feeds the
 * results back, and continues — streaming the final answer once no more tools
 * are requested. Falls back to a plain (tool-less) request if the provider/model
 * rejects the `tools` param, so chat still works on models without tool support.
 */
export async function* sendMessageWithTools(
  messages: ChatMessage[],
  provider: ProviderConfig,
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    signal?: AbortSignal;
    tools: ToolDefinition[];
    executeTool: (name: string, args: string, signal?: AbortSignal) => Promise<ToolResult>;
    maxToolRounds?: number;
    /** Stable read-only catalog lookups may be reused within this reply. Never page mutations. */
    cacheableTools?: string[];
    /** Defaults to the extension's background-routed transport. */
    streamFetch?: LlmStreamFetch;
    /** Requests and receives per-completion usage without exposing provider credentials. */
    onUsage?: (usage: CompletionUsage) => void;
    /** Stable opaque conversation key for OpenRouter provider/cache stickiness. */
    sessionId?: string;
  }
): AsyncGenerator<StreamChunk> {
  const {
    temperature = 0.7,
    maxTokens = 2048,
    model,
    signal,
    tools,
    executeTool,
    streamFetch = llmStreamFetch,
    onUsage,
  } = options;
  const maxRounds = Number.isFinite(options.maxToolRounds)
    ? Math.max(1, Math.floor(options.maxToolRounds!)) : 4;

  const work: ToolLoopMessage[] = messages.map((m) => ({
    role: m.role,
    content: toProviderContent(m.content),
  }));
  let toolsEnabled = tools.length > 0;
  if (toolsEnabled) work.push({ role: 'system', content:
    `You have at most ${maxRounds} tool rounds for this reply. Batch independent lookups, reuse results, and leave room to propose the requested action. Finish with verified findings and limitations, not promises of another check.` });
  let toolsFailure: string | null = null;
  let rounds = 0;
  // Confirmation proposals are idempotent within one assistant turn. Some models repeat an
  // identical propose_* call after the tool says the card was shown; executing it again would
  // create duplicate cards and burn every remaining tool round.
  const successfulProposalCalls = new Set<string>();
  const lookupCache = new Map<string, Exclude<ToolResult, string>>();
  const cacheableTools = new Set(options.cacheableTools ?? []);

  while (true) {
    signal?.throwIfAborted();
    let result;
    try {
      result = yield* streamCompletion(work, provider, {
        temperature,
        maxTokens,
        model,
        signal,
        tools: toolsEnabled ? tools : undefined,
        streamFetch,
        onUsage,
        sessionId: options.sessionId,
      });
    } catch (err) {
      // The tool-less retry failed too — the original tools-attached error is the real
      // cause (e.g. an oversized image), not "tools unsupported"; surface both.
      if (toolsFailure && err instanceof Error && err.name !== 'AbortError') {
        throw new Error(`${err.message} (the request with tools attached failed first: ${toolsFailure.slice(0, 300)})`);
      }
      throw err;
    }

    // Provider/model doesn't support the tools param — retry this turn plainly.
    if (result.toolsUnsupported) {
      toolsEnabled = false;
      toolsFailure = result.errorText ?? null;
      continue;
    }

    // No tool calls → the final content has already been streamed out.
    if (result.toolCalls.length === 0) {
      return;
    }
    if (!toolsEnabled) {
      // Some providers ignore omitted tools. Enforce the limit at execution too.
      yield { delta: '\n\nThe model requested another tool call after tools were disabled; it was not run.', finishReason: 'stop' };
      return;
    }

    // Record the assistant turn that asked for tools, then run them.
    work.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

    // Tool results must stay consecutive after the assistant's tool_calls turn (OpenAI
    // contract). Buffer any image turns and append them AFTER all tool results.
    const imageTurns: ToolLoopMessage[] = [];
    for (const tc of result.toolCalls) {
      signal?.throwIfAborted();
      void recordDebugEvent('chat', 'tool.start', { conversationId: options.sessionId, callId: tc.id, tool: tc.function.name });
      const activity = { id: `${rounds}:${tc.id}`, name: tc.function.name, label: describeToolCall(tc) };
      yield { delta: '', finishReason: null, toolStatus: activity.label, toolActivity: { ...activity, status: 'running' } };
      signal?.throwIfAborted();
      const proposalSignature = tc.function.name.startsWith('propose_')
        ? stableToolCallSignature(tc.function.name, tc.function.arguments)
        : null;
      let res: Exclude<ToolResult, string>;
      const lookupSignature = cacheableTools.has(tc.function.name)
        ? stableToolCallSignature(tc.function.name, tc.function.arguments) : null;
      const cached = lookupSignature ? lookupCache.get(lookupSignature) : undefined;
      if (cached) {
        res = { ...cached, content: JSON.stringify({
          cached: true, result: cached.content,
          note: 'This identical lookup already ran during this reply. Reuse this result; choose a different query or finish instead of checking it again.',
        }) };
      } else if (proposalSignature && successfulProposalCalls.has(proposalSignature)) {
        res = {
          content: JSON.stringify({
            status: 'already_proposed',
            note: 'An identical confirmation card is already shown. Do not call this tool again; continue with a concise final response.',
          }),
        };
      } else {
        try {
          const raw = await executeTool(tc.function.name, tc.function.arguments, signal);
          signal?.throwIfAborted();
          res = typeof raw === 'string' ? { content: raw } : raw;
        } catch (error) {
          // Cancellation ends the turn. Other tool exceptions must reach the model
          // as tool results so it can explain the failure and preserve call ordering.
          if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          res = { content: JSON.stringify({
            error: error instanceof Error ? error.message.slice(0, 2000) : 'Tool execution failed.',
            tool: tc.function.name,
            unknown: true,
            note: 'Execution threw an exception. Partial effects are possible; inspect the current state before proposing a retry.',
          }) };
        }
        if (proposalSignature && !toolResultHasError(res.content)) {
          successfulProposalCalls.add(proposalSignature);
        }
        if (lookupSignature && !toolResultHasError(res.content)) lookupCache.set(lookupSignature, res);
      }
      work.push({ role: 'tool', tool_call_id: tc.id, content: res.content });
      let outcome: { error?: unknown; status?: unknown; unknown?: unknown } = {};
      try { outcome = JSON.parse(res.content) ?? {}; } catch { /* non-JSON tool output */ }
      yield { delta: '', finishReason: null, toolActivity: {
        ...activity, status: toolResultHasError(res.content) ? 'failed' : 'completed',
        ...(outcome.error ? { error: sanitizeDiagnosticText(typeof outcome.error === 'string' ? outcome.error : JSON.stringify(outcome.error)).slice(0, 1500) } : {}),
      } };
      void recordDebugEvent('chat', 'tool.result', {
        conversationId: options.sessionId, callId: tc.id, tool: tc.function.name,
        failed: toolResultHasError(res.content), unknown: outcome.unknown === true,
        status: typeof outcome.status === 'string' ? outcome.status : undefined,
        error: typeof outcome.error === 'string' ? outcome.error : undefined,
        outputLength: res.content.length,
      });
      if (res.images && res.images.length) {
        imageTurns.push({
          role: 'user',
          content: res.images.flatMap((image, index) => [
            {
              type: 'text' as const,
              text: `${image.label || `Requested image ${index + 1}`}:`,
            },
            { type: 'image_url' as const, image_url: { url: image.url } },
          ]),
        });
      }
    }
    work.push(...imageTurns);
    yield { delta: '', finishReason: null, toolStatus: null };

    rounds++;
    if (rounds >= maxRounds) {
      // Stop looping; force a textual answer from what we've gathered.
      toolsEnabled = false;
      yield { delta: '', finishReason: null, toolRoundLimit: maxRounds };
      void recordDebugEvent('chat', 'tool.limit', { conversationId: options.sessionId, rounds, limit: maxRounds });
      work.push({ role: 'system', content:
        'The tool-round limit has been reached. No more tool calls are available for this reply. Give a concise final answer now: summarize verified results, say what remains unresolved, and offer a concrete next step. Do not promise more checks or claim no compatible resources exist merely because the search was incomplete.' });
    } else {
      work.push({ role: 'system', content: `Tool rounds remaining: ${maxRounds - rounds}. Reuse the results above; avoid repeating the same lookup. Finish or propose an action as soon as you have enough evidence.` });
    }
  }
}

function stableToolCallSignature(name: string, rawArgs: string): string {
  try {
    return `${name}:${JSON.stringify(sortJson(JSON.parse(rawArgs || '{}')))}`;
  } catch {
    return `${name}:${rawArgs.trim()}`;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
}

function toolResultHasError(content: string): boolean {
  try {
    const value = JSON.parse(content);
    return Boolean(value && typeof value === 'object' && value.error);
  } catch {
    return false;
  }
}

/**
 * Run a single streaming completion. Yields content deltas; returns the
 * assembled content + any tool calls the model requested this turn.
 */
async function* streamCompletion(
  messages: ToolLoopMessage[],
  provider: ProviderConfig,
  opts: {
    temperature: number;
    maxTokens: number;
    model?: string;
    signal?: AbortSignal;
    tools?: ToolDefinition[];
    streamFetch: LlmStreamFetch;
    onUsage?: (usage: CompletionUsage) => void;
    sessionId?: string;
  }
): AsyncGenerator<
  StreamChunk,
  { content: string; toolCalls: AssembledToolCall[]; toolsUnsupported?: boolean; errorText?: string }
> {
  const url = `${provider.baseURL.replace(/\/$/, '')}/chat/completions`;
  const modelToUse = opts.model || provider.defaultModel;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  };
  if (provider.type === 'openrouter') {
    headers['HTTP-Referer'] = 'https://civitai.com';
    headers['X-OpenRouter-Title'] = 'Sieve & Scribe';
  }

  const body: Record<string, unknown> = {
    model: modelToUse,
    messages: applyPromptCaching(messages, provider, modelToUse),
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    stream: true,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  if (provider.type === 'openrouter' && opts.sessionId) body.session_id = opts.sessionId;
  if (opts.onUsage) body.stream_options = { include_usage: true };

  const stream = await opts.streamFetch(
    { url, method: 'POST', headers, body: JSON.stringify(body) },
    opts.signal
  );

  if (!stream.head.ok) {
    const errorText = stream.head.bodyText ?? 'Unknown error';
    // Retry without tools only when the provider explicitly says the tool/function
    // parameter is unsupported. A bare 400/404/422 can instead mean an oversized
    // image, invalid model, malformed message, or other error that a retry would hide.
    if (
      opts.tools &&
      opts.tools.length > 0 &&
      isUnsupportedToolsError(stream.head.status, errorText)
    ) {
      return { content: '', toolCalls: [], toolsUnsupported: true, errorText };
    }
    throw new Error(httpErrorMessage(stream.head.status, stream.head.retryAfter, errorText));
  }

  let buffer = '';
  let content = '';
  let sawDone = false;
  let terminalReason: string | null = null;
  let pendingError: Error | null = null;
  const toolCallsByIndex = new Map<number, AssembledToolCall>();

  // Parse one SSE line: accumulate tool-call deltas, flag [DONE], and return a content
  // chunk for the generator to yield (or null).
  const handleLine = (line: string): StreamChunk | null => {
    const payload = ssePayload(line);
    if (payload === null) return null;
    if (payload === '[DONE]') {
      sawDone = true;
      return null;
    }
    let json: any;
    try { json = JSON.parse(payload); } catch { return null; }
    if (!json || typeof json !== 'object') return null;
    {
      const choice = json.choices?.[0];
      const reason = choice?.finish_reason;
      if (typeof reason === 'string' && reason) terminalReason = reason;
      const error = json.error ?? choice?.error;
      if (error) {
        const message = typeof error === 'string' ? error : error.message;
        const code = typeof error.code === 'string' || typeof error.code === 'number' ? ` (${error.code})` : '';
        pendingError = new Error(sanitizeDiagnosticText(`Provider stream error${code}: ${typeof message === 'string' ? message : 'No error details supplied.'}`).slice(0, 1500));
      } else if (reason === 'content_filter') {
        pendingError = new Error('The provider stopped this response with a content-filter result (content_filter).');
      } else if (reason === 'error') {
        pendingError = new Error('The provider ended the response with an error but supplied no details.');
      } else if (reason === 'length') {
        pendingError = new Error('The response reached its output-token limit. Increase the output limit in Settings or ask to continue.');
      }
      if (pendingError || reason) void recordDebugEvent('chat', 'stream.finish', {
        conversationId: opts.sessionId, requestId: json.id, provider: json.provider,
        finishReason: reason, nativeFinishReason: choice?.native_finish_reason,
        error: pendingError?.message,
      });
      if (json.usage && opts.onUsage) {
        const promptDetails = json.usage.prompt_tokens_details ?? {};
        opts.onUsage({
          promptTokens: Number(json.usage.prompt_tokens) || 0,
          completionTokens: Number(json.usage.completion_tokens) || 0,
          totalTokens: Number(json.usage.total_tokens) || 0,
          ...(typeof json.usage.cost === 'number' ? { cost: json.usage.cost } : {}),
          ...(typeof promptDetails.cached_tokens === 'number'
            ? { cachedTokens: promptDetails.cached_tokens }
            : {}),
          ...(typeof promptDetails.cache_write_tokens === 'number'
            ? { cacheWriteTokens: promptDetails.cache_write_tokens }
            : {}),
          ...(typeof (json.cache_discount ?? json.usage.cache_discount) === 'number'
            ? { cacheDiscount: json.cache_discount ?? json.usage.cache_discount }
            : {}),
        });
      }
      const delta = choice?.delta ?? {};
      const finishReason = json.choices?.[0]?.finish_reason ?? null;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          let acc = toolCallsByIndex.get(idx);
          if (!acc) {
            acc = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
            toolCallsByIndex.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.function.name = tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
      const text = (typeof delta.content === 'string' && delta.content) || delta.refusal;
      if (typeof text === 'string' && text) {
        content += text;
        return { delta: text, finishReason };
      }
    }
    return null;
  };

  for await (const text of stream.chunks) {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const chunk = handleLine(line);
      if (chunk) yield chunk;
      if (pendingError) throw pendingError;
      if (sawDone) break;
    }
    if (sawDone) break;
  }
  if (!sawDone && buffer) {
    // Final line lacking a trailing newline.
    const chunk = handleLine(buffer);
    if (chunk) yield chunk;
    if (pendingError) throw pendingError;
  }

  if (!sawDone && !terminalReason) {
    throw new Error('The response stream ended before a completion signal. The connection may have been interrupted.');
  }
  const toolCalls = collectToolCalls(toolCallsByIndex);
  if (!content.trim() && !toolCalls.length) {
    throw new Error('The provider returned an empty response and supplied no reason.');
  }
  return { content, toolCalls };
}

function isUnsupportedToolsError(status: number, errorText: string): boolean {
  if (![400, 404, 422].includes(status)) return false;
  const text = errorText.toLowerCase();
  const namesToolFeature = /\btools?\b|\btool_choice\b|\bfunction(?: calling)?\b/.test(text);
  const rejectsFeature =
    /(?:not|isn't|is not) supported|does not support|unsupported|unknown|unrecognized|unexpected/.test(
      text
    ) ||
    /no endpoints?.{0,80}support.{0,40}\btools?\b/.test(text) ||
    /(?:invalid|extra) (?:parameter|field|input)/.test(text) ||
    /extra inputs? (?:are )?not permitted/.test(text);
  return namesToolFeature && rejectsFeature;
}

function collectToolCalls(byIndex: Map<number, AssembledToolCall>): AssembledToolCall[] {
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => tc)
    .filter((tc) => tc.function.name);
}

/** Human-readable label, retained alongside the tool's changing status. */
function describeToolCall(tc: AssembledToolCall): string {
  let arg: string | number = '';
  try {
    const a = JSON.parse(tc.function.arguments || '{}');
    arg = a.query ?? a.modelId ?? a.modelVersionId ?? '';
  } catch {
    /* arguments may still be streaming/partial */
  }
  switch (tc.function.name) {
    case 'search_civitai_loras':
      return `Search CivitAI${arg ? ` for "${arg}"` : ''}`;
    case 'get_civitai_model':
      return `Get trigger words${arg ? ` for model ${arg}` : ''}`;
    case 'mine_civitai_prompts':
      return `Find example prompts${arg ? ` (version ${arg})` : ''}`;
    case 'get_civitai_base_models':
      return 'List CivitAI base models';
    case 'propose_prompt':
      return 'Prepare prompt for approval';
    default:
      return tc.function.name.replaceAll('_', ' ');
  }
}

function httpErrorMessage(status: number, retryAfter: string | null, errorText: string): string {
  switch (status) {
    case 401:
      return 'Invalid API key. Please check your settings.';
    case 429:
      return `Rate limited. Please wait ${retryAfter ? `${retryAfter}s` : 'a moment'} and try again.`;
    case 500:
    case 502:
    case 503:
      return 'The API server is experiencing issues. Please try again later.';
    default:
      return `API error (${status}): ${errorText}`;
  }
}

/**
 * Non-streaming version for simple requests (e.g., connection test).
 */
export async function sendTestMessage(
  provider: ProviderConfig,
  model?: string,
): Promise<{ success: boolean; model: string; message: string }> {
  const url = `${provider.baseURL.replace(/\/$/, '')}/chat/completions`;
  const modelToUse = model || provider.defaultModel;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  };

  if (provider.type === 'openrouter') {
    headers['HTTP-Referer'] = 'https://civitai.com';
    headers['X-OpenRouter-Title'] = 'Sieve & Scribe';
  }

  try {
    const response = await llmFetchText({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelToUse,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        model: modelToUse,
        message: `Error ${response.status}: ${response.bodyText || 'Unknown error'}`,
      };
    }

    let json: any = null;
    try {
      json = JSON.parse(response.bodyText);
    } catch {
      /* non-JSON success body — fine for a connectivity check */
    }
    return {
      success: true,
      model: json?.model ?? modelToUse,
      message: 'Connection successful!',
    };
  } catch (err) {
    return {
      success: false,
      model: modelToUse,
      message: err instanceof Error ? err.message : 'Connection failed.',
    };
  }
}
