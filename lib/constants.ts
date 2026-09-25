import { type ProviderConfig, type ExtensionSettings } from './types';
import { DEFAULT_SYSTEM_PROMPT } from './sdxl-knowledge';

// Re-exported so existing `import { DEFAULT_SYSTEM_PROMPT } from './constants'`
// call sites keep working; the prompt itself now lives in the knowledge layer.
export { DEFAULT_SYSTEM_PROMPT };

// Provider default configurations
export const PROVIDER_DEFAULTS: Record<string, {
  baseURL: string;
  defaultModel: string;
  models: string[];
}> = {
  xai: {
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.3',
    models: ['grok-4.3', 'grok-3', 'grok-3-mini'],
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-2.5-pro-preview',
    models: [
      'google/gemini-2.5-pro-preview',
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'meta-llama/llama-4-maverick',
      'deepseek/deepseek-r1',
    ],
  },
  custom: {
    baseURL: '',
    defaultModel: '',
    models: [],
  },
};

// CivitAI DOM selectors. The 2026 generator redesign removed all stable ids —
// fields are found structurally in dom-bridge.ts; only the tour-tagged submit
// button still has a usable selector (with a text-based fallback).
export const SELECTORS = {
  submitButton: '[data-tour="gen:submit"]',
} as const;

// XML tags for structured output parsing
export const PROMPT_TEMPLATE_TAGS = {
  prompt: { open: '<prompt>', close: '</prompt>' },
  negative: { open: '<negative>', close: '</negative>' },
  params: { open: '<params>', close: '</params>' },
} as const;

// CSS class prefix for all extension styles
export const EXTENSION_PREFIX = 'cllp';

// Default extension settings
export const DEFAULT_SETTINGS: ExtensionSettings = {
  providers: {
    xai: {
      type: 'xai',
      apiKey: '',
      baseURL: PROVIDER_DEFAULTS.xai.baseURL,
      defaultModel: PROVIDER_DEFAULTS.xai.defaultModel,
    },
    openrouter: {
      type: 'openrouter',
      apiKey: '',
      baseURL: PROVIDER_DEFAULTS.openrouter.baseURL,
      defaultModel: PROVIDER_DEFAULTS.openrouter.defaultModel,
    },
  },
  activeProviderId: 'xai',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.7,
  maxTokens: 2048,
  civitaiApiToken: '',
  civitaiMcpMode: 'read',
  rollingContext: true,
  contextTurns: 20,
  debugMode: false,
};

// CivitAI domains
export const CIVITAI_DOMAINS = ['civitai.com', 'civitai.red'] as const;

// Generate page path
export const GENERATE_PATH = '/generate';
