import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsStorage } from '@/lib/storage';
import { DEFAULT_SETTINGS } from '@/lib/constants';
import { fakeBrowser } from 'wxt/testing';
import {
  appendDiagnosticDirect,
  buildDiagnosticExport,
  buildChatDebugExport,
  recordDebugEvent,
  recordChatFailure,
  createDiagnosticEntry,
  diagnosticLogStorage,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
  type DiagnosticEntry,
} from '@/lib/diagnostic-log';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('diagnostic log privacy', () => {
  it('records sanitized handled chat failures even with debug tracing disabled', async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, debugMode: false });
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    try {
      recordChatFailure({ conversationId: 'test-chat', error: 'Provider error Bearer test-secret' });
      expect(send).toHaveBeenCalledOnce();
      const message = send.mock.calls[0][0] as any;
      expect(message.entry).toMatchObject({ level: 'error', context: 'chat', message: 'chat.failure',
        detail: [{ conversationId: 'test-chat', error: 'Provider error Bearer [redacted]' }] });
      await appendDiagnosticDirect(message.entry);
      expect((await diagnosticLogStorage.getValue()).entries).toHaveLength(1);
    } finally { send.mockRestore(); }
  });
  it('requires debug mode, preserves comparison evidence, and isolates logging failures', async () => {
    const sink = vi.fn();
    await recordDebugEvent('content', 'form.verification', { exactMatch: false }, sink);
    expect(sink).not.toHaveBeenCalled();
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, debugMode: true });
    await recordDebugEvent('content', 'form.verification', {
      textChecks: { positive: { exactMatch: false, whitespaceEquivalent: true, expectedLength: 847 } },
      prompt: 'private prompt', apiKey: 'private key',
    }, sink);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0][0]).toMatchObject({ level: 'debug', detail: [{
      textChecks: { positive: { exactMatch: false, whitespaceEquivalent: true, expectedLength: 847 } },
      prompt: '[redacted]', apiKey: '[redacted]',
    }] });
    await expect(recordDebugEvent('chat', 'test', {}, async () => { throw new Error('offline'); })).resolves.toBeUndefined();
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, debugMode: false });
    await appendDiagnosticDirect(sink.mock.calls[0][0]);
    expect((await diagnosticLogStorage.getValue()).entries).toEqual([]);
  });

  it('exports the active transcript and failed actions without image bytes or provider settings', () => {
    const payload = buildChatDebugExport({
      id: 'conversation', title: 'Test', createdAt: 1, updatedAt: 2,
      messages: [
        { role: 'user', timestamp: 1, content: [{ type: 'text', text: 'A glass figure' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRETIMAGE' } }] },
        { role: 'user', timestamp: 2, internal: true, content: 'Trusted result: whitespace mismatch' },
      ],
      actions: [{ id: 'action', originTurnId: 'turn', createdAt: 1, updatedAt: 2, status: 'failed',
        action: { kind: 'prompt', positive: 'subject: glass\nsetting: grass' },
        result: { success: false, error: 'Verification mismatch' } }],
    }, { v: 1, entries: [] }, { extensionVersion: '1.0.75', userAgent: 'test' });
    // The envelope label is the product's own name; pin it so a rename cannot drift
    // silently past anyone who sorts kept exports by `format`.
    expect(payload).toMatchObject({ format: 'sieve-and-scribe-chat-debug' });
    const json = JSON.stringify(payload);
    expect(json).toContain('A glass figure');
    expect(json).toContain('whitespace mismatch');
    expect(json).toContain('subject: glass');
    expect(json).toContain('failed');
    expect(json).not.toContain('SECRETIMAGE');
    expect(payload).not.toHaveProperty('providers');
  });

  it('redacts credentials, image payloads, sensitive fields, and URL queries', () => {
    expect(
      sanitizeDiagnosticText(
        'Bearer abc.def sk-or-v1-secretvalue xai-secretvalue https://civitai.com/images/42?token=oops#private data:image/png;base64,AAAA=='
      )
    ).toBe(
      'Bearer [redacted] sk-or-v1-[redacted] xai-[redacted] https://civitai.com/images/42 [redacted image data]'
    );

    expect(
      sanitizeDiagnosticValue({
        apiKey: 'secret',
        nested: { prompt: 'private words', status: 500 },
        error: 'request failed',
      })
    ).toEqual({
      apiKey: '[redacted]',
      nested: { prompt: '[redacted]', status: 500 },
      error: 'request failed',
    });
  });

  it('sanitizes before constructing a persisted entry', () => {
    const entry = createDiagnosticEntry(
      'error',
      'content',
      ['Request failed for https://civitai.com/api/item?token=private', { authorization: 'Bearer secret', status: 503 }],
      new Date('2026-08-15T12:00:00.000Z')
    );
    expect(entry).toMatchObject({
      timestamp: '2026-08-15T12:00:00.000Z',
      level: 'error',
      context: 'content',
      message: 'Request failed for https://civitai.com/api/item',
      detail: [{ authorization: '[redacted]', status: 503 }],
    });
  });
});

describe('diagnostic journal retention and export', () => {
  it('keeps only the newest 250 entries', async () => {
    const entry = (index: number): DiagnosticEntry => ({
      id: String(index),
      timestamp: new Date(index).toISOString(),
      level: 'warn',
      context: 'background',
      message: `entry ${index}`,
      extensionVersion: '1.0.51',
    });
    await diagnosticLogStorage.setValue({
      v: 1,
      entries: Array.from({ length: 250 }, (_, index) => entry(index)),
    });
    await appendDiagnosticDirect(entry(250));

    const stored = await diagnosticLogStorage.getValue();
    expect(stored.entries).toHaveLength(250);
    expect(stored.entries[0].id).toBe('1');
    expect(stored.entries.at(-1)?.id).toBe('250');
  });

  it('sanitizes again at the persistence boundary', async () => {
    await appendDiagnosticDirect({
      id: 'unsafe',
      timestamp: '2026-08-15T12:00:00.000Z',
      level: 'error',
      context: 'content',
      message: 'Bearer should-not-survive',
      detail: { apiKey: 'also-secret' },
      page: 'https://civitai.com/images/1?private=yes',
      extensionVersion: '1.0.51',
    });
    expect((await diagnosticLogStorage.getValue()).entries[0]).toMatchObject({
      message: 'Bearer [redacted]',
      detail: { apiKey: '[redacted]' },
      page: 'https://civitai.com/images/1',
    });
  });

  it('creates a reviewable export envelope without changing entries', () => {
    const entries = [createDiagnosticEntry('warn', 'options', ['site contract changed'])];
    const exported = buildDiagnosticExport(
      { v: 1, entries },
      {
        extensionVersion: '1.0.51',
        userAgent: 'Test Browser',
        exportedAt: '2026-08-15T13:00:00.000Z',
      }
    );
    expect(exported).toMatchObject({
      format: 'sieve-and-scribe-diagnostics',
      schemaVersion: 1,
      exportedAt: '2026-08-15T13:00:00.000Z',
      extensionVersion: '1.0.51',
      entryCount: 1,
      entries,
    });
  });
});
