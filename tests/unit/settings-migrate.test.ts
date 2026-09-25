// Seed test proving the harness (fake-browser storage + lib imports) works.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { promptHash, migrateSettings } from '@/lib/settings-migrate';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/sdxl-knowledge';
import { settingsStorage } from '@/lib/storage';
import { DEFAULT_SETTINGS } from '@/lib/constants';

describe('promptHash', () => {
  it('is stable for known retired prompts', () => {
    // djb2 base-36 must never change: the retired-hash migration depends on it.
    expect(promptHash('')).toBe('45h');
    expect(promptHash('hello')).toBe('4bj995');
  });

  it('the CURRENT default prompt must not hash to a retired value', () => {
    // If this fails, someone changed DEFAULT_SYSTEM_PROMPT back to a retired
    // version — the migration would then ping-pong stored prompts.
    expect(promptHash(DEFAULT_SYSTEM_PROMPT)).not.toBe('13w1p92');
  });
});

describe('migrateSettings', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('leaves a customized prompt untouched', async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, systemPrompt: 'my own prompt' });
    await migrateSettings();
    expect((await settingsStorage.getValue()).systemPrompt).toBe('my own prompt');
  });

  it('is a no-op when the stored prompt is already current', async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    await migrateSettings();
    expect((await settingsStorage.getValue()).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('migrates the old live-tools toggle to the equivalent MCP mode', async () => {
    const legacy = { ...DEFAULT_SETTINGS, civitaiMcpMode: undefined, civitaiToolsEnabled: false };
    await settingsStorage.setValue(legacy as any);
    await migrateSettings();
    const migrated = await settingsStorage.getValue();
    expect(migrated.civitaiMcpMode).toBe('off');
    expect(migrated.civitaiToolsEnabled).toBeUndefined();
  });
});
