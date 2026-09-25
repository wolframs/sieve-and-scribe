/**
 * Settings migrations, run once at background startup.
 *
 * The whole ExtensionSettings object is persisted, so an install that ever
 * saved settings keeps the systemPrompt it was saved with — updates to
 * DEFAULT_SYSTEM_PROMPT would never reach it. We fix that by hashing: if the
 * stored prompt is byte-identical to a RETIRED default (i.e. the user never
 * customized it), swap in the current default. Customized prompts never match
 * a retired hash and are left untouched.
 *
 * When changing any part of DEFAULT_SYSTEM_PROMPT: compute the OLD prompt's
 * promptHash() and append it here BEFORE shipping the change.
 */
import { settingsStorage } from './storage';
import { DEFAULT_SYSTEM_PROMPT } from './sdxl-knowledge';

/** djb2, base-36. Stable across JS engines; collisions irrelevant at this scale. */
export function promptHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Hashes of every DEFAULT_SYSTEM_PROMPT ever shipped (oldest first). */
const RETIRED_DEFAULT_PROMPT_HASHES = [
  '1ddvkad', // pre-knowledge-layer generic prompt (v1.0.0)
  '17udrbi', // sdxl-prompt-craft consolidation
  '6p107', // + live LoRA lookup guidance
  '390se4', // + agentic page tools / capability-aware prompt
  'm1tg6j', // SDXL-only knowledge, ratio-format output contract (v1.0.14)
  '13w1p92', // July-2026 multi-family knowledge, pre content-policy grant (v1.0.15)
  '1h2cjlg', // content-policy grant, pre Apply-button delivery rules (v1.0.22)
  '5zizri', // one-line live-lookup hint, pre expanded lookup workflow (v1.0.29)
  '82tooj', // taught <lora:> syntax, which CivitAI's generator does not read (v1.0.32)
  '1mlx8b0', // pre video duration param / normalized-CFG guidance (v1.0.34)
  '160pxog', // fixed-shape video guidance, pre graph-driven video controls (v1.0.37)
  'xt1osg', // graph-driven controls, pre numbered chat images / img2vid tooling (v1.0.38)
  'brfe24', // adult-content grant with illustrative categories (through v1.0.82)
];

export async function migrateSettings(): Promise<void> {
  try {
    const settings = await settingsStorage.getValue();
    let migrated = settings;
    if (!settings.civitaiMcpMode) {
      migrated = {
        ...migrated,
        civitaiMcpMode: settings.civitaiToolsEnabled === false ? 'off' : 'read',
      };
      delete migrated.civitaiToolsEnabled;
    }
    if (
      migrated.systemPrompt !== DEFAULT_SYSTEM_PROMPT &&
      RETIRED_DEFAULT_PROMPT_HASHES.includes(promptHash(migrated.systemPrompt))
    ) {
      migrated = { ...migrated, systemPrompt: DEFAULT_SYSTEM_PROMPT };
      console.log('[cllp] migrated stored system prompt to the current default');
    }
    if (migrated !== settings) await settingsStorage.setValue(migrated);
  } catch (err) {
    console.warn('[cllp] settings migration failed', err);
  }
}
