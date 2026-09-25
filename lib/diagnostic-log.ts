/**
 * Small, local diagnostic journal for failures that only appear during normal browsing.
 *
 * Extension-owned warn/error calls and uncaught errors are sanitized before they leave
 * their execution context. The background serializes writes so several tabs cannot
 * clobber one another's entries in chrome.storage.local.
 */

import { settingsStorage } from './storage';
import type { Conversation } from './types';

export const DIAGNOSTIC_MSG = 'cllp:diagnostic-log';
export const DIAGNOSTIC_MAX_ENTRIES = 250;

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_DETAIL_LENGTH = 6_000;
const SECRET_FIELD =
  /authorization|api.?key|access.?token|refresh.?token|civitai.?token|secret|password|cookie|request.?body|messages|prompt|image.?data|data.?url/i;

export type DiagnosticLevel = 'debug' | 'warn' | 'error';
export type DiagnosticContext = 'background' | 'content' | 'sidepanel' | 'popup' | 'options' | 'chat';

export interface DiagnosticEntry {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  context: DiagnosticContext;
  message: string;
  detail?: unknown;
  page?: string;
  extensionVersion: string;
}

export interface DiagnosticJournal {
  v: 1;
  entries: DiagnosticEntry[];
}

export const diagnosticLogStorage = storage.defineItem<DiagnosticJournal>(
  'local:cllpDiagnosticLog',
  { fallback: { v: 1, entries: [] } }
);

export const lastDiagnosticExportStorage = storage.defineItem<number | null>(
  'local:cllpLastDiagnosticExportId',
  { fallback: null }
);

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

/** Redact common credentials, embedded image data, and URL query/hash payloads. */
export function sanitizeDiagnosticText(value: string): string {
  let clean = value
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[redacted image data]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-or-v1-[a-z0-9_-]+/gi, 'sk-or-v1-[redacted]')
    .replace(/\bxai-[a-z0-9_-]{8,}/gi, 'xai-[redacted]');

  // Query strings and fragments often contain prompts, tokens, or private identifiers.
  clean = clean.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch {
      return candidate;
    }
  });
  return clean;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') return truncate(sanitizeDiagnosticText(value), MAX_DETAIL_LENGTH);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(sanitizeDiagnosticText(value.message), MAX_MESSAGE_LENGTH),
      stack: value.stack ? truncate(sanitizeDiagnosticText(value.stack), MAX_DETAIL_LENGTH) : undefined,
    };
  }
  if (depth >= 4) return '[max depth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    result[key] = SECRET_FIELD.test(key) ? '[redacted]' : sanitizeValue(item, depth + 1, seen);
  }
  return result;
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

function diagnosticPage(): string | undefined {
  try {
    if (!globalThis.location || !/^https?:$/.test(globalThis.location.protocol)) return undefined;
    return `${globalThis.location.origin}${globalThis.location.pathname}`;
  } catch {
    return undefined;
  }
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function messageFrom(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(sanitizeDiagnosticValue(value));
  } catch {
    return String(value);
  }
}

export function createDiagnosticEntry(
  level: DiagnosticLevel,
  context: DiagnosticContext,
  args: unknown[],
  now = new Date()
): DiagnosticEntry {
  const first = args[0] ?? 'Unknown diagnostic';
  const detail = args.length > 1
    ? sanitizeDiagnosticValue(args.slice(1))
    : first instanceof Error
      ? sanitizeDiagnosticValue(first)
      : undefined;
  let extensionVersion = 'unknown';
  try {
    extensionVersion = browser.runtime.getManifest().version;
  } catch {
    /* unit tests or an invalidated extension context */
  }
  return {
    id: makeId(),
    timestamp: now.toISOString(),
    level,
    context,
    message: truncate(sanitizeDiagnosticText(messageFrom(first)), MAX_MESSAGE_LENGTH),
    ...(detail === undefined ? {} : { detail }),
    ...(diagnosticPage() ? { page: diagnosticPage() } : {}),
    extensionVersion,
  };
}

function sanitizeDiagnosticEntry(entry: DiagnosticEntry): DiagnosticEntry {
  return {
    id: truncate(sanitizeDiagnosticText(String(entry.id)), 160),
    timestamp: Number.isNaN(Date.parse(entry.timestamp)) ? new Date().toISOString() : entry.timestamp,
    level: entry.level === 'debug' ? 'debug' : entry.level === 'error' ? 'error' : 'warn',
    context: ['background', 'content', 'sidepanel', 'popup', 'options', 'chat'].includes(entry.context)
      ? entry.context
      : 'background',
    message: truncate(sanitizeDiagnosticText(String(entry.message)), MAX_MESSAGE_LENGTH),
    ...(entry.detail === undefined ? {} : { detail: sanitizeDiagnosticValue(entry.detail) }),
    ...(entry.page ? { page: truncate(sanitizeDiagnosticText(String(entry.page)), 1_000) } : {}),
    extensionVersion: truncate(sanitizeDiagnosticText(String(entry.extensionVersion)), 40),
  };
}

export async function appendDiagnosticDirect(entry: DiagnosticEntry): Promise<void> {
  if (entry.level === 'debug' && !(await settingsStorage.getValue()).debugMode) return;
  const journal = await diagnosticLogStorage.getValue();
  await diagnosticLogStorage.setValue({
    v: 1,
    // Re-sanitize at the storage boundary as defense in depth for runtime messages.
    entries: [...journal.entries, sanitizeDiagnosticEntry(entry)].slice(-DIAGNOSTIC_MAX_ENTRIES),
  });
}

type DiagnosticMessage = {
  type: typeof DIAGNOSTIC_MSG;
  entry: DiagnosticEntry;
};

/** Register once in the background service worker. */
export function registerDiagnosticLogHost(): void {
  let queue: Promise<unknown> = Promise.resolve();
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message as DiagnosticMessage).type !== DIAGNOSTIC_MSG) return;
    const task = () => appendDiagnosticDirect((message as DiagnosticMessage).entry);
    const run = queue.then(task, task);
    queue = run;
    run.then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  });
}

type DiagnosticSink = (entry: DiagnosticEntry) => void | Promise<void>;

/** Best-effort opt-in trace; payloads must be metadata, never model inputs or output. */
export async function recordDebugEvent(
  context: DiagnosticContext,
  event: string,
  detail: Record<string, unknown>,
  sink?: DiagnosticSink
): Promise<void> {
  try {
    if (!(await settingsStorage.getValue()).debugMode) return;
    await (sink ?? ((entry) => browser.runtime.sendMessage({ type: DIAGNOSTIC_MSG, entry })))(
      createDiagnosticEntry('debug', context, [event, detail])
    );
  } catch {
    // Logging must never alter action execution or chat persistence.
  }
}

function sendToBackground(entry: DiagnosticEntry): void {
  void browser.runtime.sendMessage({ type: DIAGNOSTIC_MSG, entry }).catch(() => {
    /* Invalidated/no background context: diagnostics must never break the feature. */
  });
}

/** Handled chat failures belong in diagnostics even when verbose debug tracing is off. */
export function recordChatFailure(detail: Record<string, unknown>): void {
  try {
    sendToBackground(createDiagnosticEntry('error', 'chat', ['chat.failure', detail]));
  } catch { /* Invalidated extension contexts must still display the error. */ }
}

/**
 * Capture extension-owned warnings/errors in one execution context. Repeated calls for
 * the same global are ignored, which keeps HMR/content reinjection from double logging.
 */
export function installDiagnosticCapture(context: DiagnosticContext, sink?: DiagnosticSink): void {
  const global = globalThis as typeof globalThis & { __cllpDiagnosticCaptureInstalled?: boolean };
  if (global.__cllpDiagnosticCaptureInstalled) return;
  global.__cllpDiagnosticCaptureInstalled = true;
  const emit = (level: DiagnosticLevel, args: unknown[]) => {
    try {
      void Promise.resolve((sink ?? sendToBackground)(createDiagnosticEntry(level, context, args))).catch(() => {});
    } catch {
      /* Logging is strictly best-effort. */
    }
  };

  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    emit('warn', args);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    emit('error', args);
  };

  const eventTarget = globalThis as any;
  eventTarget.addEventListener?.('error', (event: ErrorEvent) => {
    emit('error', [event.error ?? event.message ?? 'Uncaught error']);
  });
  eventTarget.addEventListener?.('unhandledrejection', (event: PromiseRejectionEvent) => {
    emit('error', [event.reason ?? 'Unhandled promise rejection']);
  });
}

export function buildDiagnosticExport(
  journal: DiagnosticJournal,
  metadata: { extensionVersion: string; userAgent: string; exportedAt?: string }
): Record<string, unknown> {
  return {
    // Envelope label only; nothing reads it back. Files exported before the rename
    // carry 'civitai-llm-prompter-diagnostics' — accept both if an importer is ever written.
    format: 'sieve-and-scribe-diagnostics',
    schemaVersion: 1,
    exportedAt: metadata.exportedAt ?? new Date().toISOString(),
    extensionVersion: metadata.extensionVersion,
    userAgent: metadata.userAgent,
    privacy:
      'Warnings and errors are sanitized before local storage. Redaction is best-effort; review this file before sharing.',
    retention: `Newest ${DIAGNOSTIC_MAX_ENTRIES} entries are kept locally. Uninstalling the extension removes them.`,
    entryCount: journal.entries.length,
    entries: journal.entries,
  };
}

/** Explicit user export: include the active transcript, never provider credentials or images. */
export function buildChatDebugExport(
  conversation: Conversation,
  journal: DiagnosticJournal,
  metadata: Parameters<typeof buildDiagnosticExport>[1]
): Record<string, unknown> {
  return {
    ...buildDiagnosticExport(journal, metadata),
    // Pre-rename files carry 'civitai-llm-prompter-chat-debug'.
    format: 'sieve-and-scribe-chat-debug',
    privacy: 'Contains the active chat text and proposed prompts. Image attachments and provider settings are omitted. Review before sharing.',
    conversation: {
      id: conversation.id,
      title: sanitizeDiagnosticText(conversation.title),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages.map((message) => ({
        id: message.id, role: message.role, timestamp: message.timestamp, internal: message.internal ?? false,
        toolActivity: sanitizeDiagnosticValue(message.toolActivity),
        content: typeof message.content === 'string'
          ? sanitizeDiagnosticText(message.content)
          : message.content.map((part) => part.type === 'text'
            ? { type: 'text', text: sanitizeDiagnosticText(part.text) }
            : { type: 'text', text: '[image attachment omitted]' }),
      })),
      actions: (conversation.actions ?? []).map((record) => ({
        ...sanitizeDiagnosticValue(record) as Record<string, unknown>,
        // Prompt bodies are intentional in this explicit transcript export.
        ...(record.action.kind === 'prompt' ? { action: {
          kind: 'prompt', positive: sanitizeDiagnosticText(record.action.positive),
          negative: record.action.negative === undefined ? undefined : sanitizeDiagnosticText(record.action.negative),
          params: record.action.params,
        } } : {}),
      })),
    },
  };
}
