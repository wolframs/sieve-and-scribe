// Type definitions for Sieve & Scribe
import type { AssistantActionRecord } from './action-state';

export type ProviderType = 'xai' | 'openrouter' | 'custom';

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseURL: string;
  defaultModel: string;
}

/** A text segment of a multimodal message. */
export interface TextPart {
  type: 'text';
  text: string;
}

/** An image segment (OpenAI-compatible). `url` may be a remote URL or a data: URL. */
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
  /** Stable, conversation-local identity shown as "Image N" in the chat UI and to the LLM. */
  imageId?: number;
  /** Original filename/short source label, kept for the user's attachment UI. */
  imageName?: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolActivity {
  id: string;
  name: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  error?: string;
}

export interface ChatMessage {
  /** Stable identity used by persisted interactions such as inline Apply/Append. */
  id?: string;
  role: 'system' | 'user' | 'assistant';
  /** Plain text (the common case) or multimodal parts (text + images). */
  content: string | ContentPart[];
  timestamp: number;
  /** Trusted extension event included in model context but hidden from the transcript. */
  internal?: boolean;
  /** Visible tool execution history; excluded from model message text. */
  toolActivity?: ToolActivity[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  /** The one-time "rolling window starts soon" notice has been shown. */
  rollNoticeShown?: boolean;
  /** Persisted user-confirmed page actions and their verified/unknown outcomes. */
  actions?: AssistantActionRecord[];
}

export interface GenerationPrompt {
  positivePrompt: string;
  negativePrompt?: string;
  params?: GenerationParams;
}

export interface GenerationParams {
  cfgScale?: number;
  steps?: number;
  sampler?: string;
  seed?: number;
  clipSkip?: number;
  aspectRatio?: string;
  /** Video clip length in seconds. Available values/range depend on the model. */
  duration?: number;
  /** Video output resolution when the active model exposes it, e.g. "720p". */
  resolution?: string;
  /** Whether the active video model should generate audio with the clip. */
  generateAudio?: boolean;
}

export type VideoWorkflow = 'textToVideo' | 'imageToVideo' | 'referenceToVideo';
export type GeneratorImageSlot = 'source' | 'firstFrame' | 'lastFrame' | 'reference';

export interface GeneratorImage {
  slot: GeneratorImageSlot;
  url: string;
  width?: number;
  height?: number;
}

export interface ExtensionSettings {
  providers: Record<string, ProviderConfig>;
  activeProviderId: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  /** Civitai API token (optional) — unlocks NSFW data + higher rate limits for live lookups. */
  civitaiApiToken: string;
  /** CivitAI tools: off, annotated reads, or all server tools with confirmation for writes. */
  civitaiMcpMode: 'off' | 'read' | 'full';
  /** Pre-1.0.47 migration input. */
  civitaiToolsEnabled?: boolean;
  /** Rolling context: send only the system prompt + the last `contextTurns` turns. */
  rollingContext?: boolean;
  /** How many user turns stay in the model's view when rollingContext is on. */
  contextTurns?: number;
  /** Opt-in local trace of chat/tools and form verification; excludes prompt bodies. */
  debugMode?: boolean;
}

export interface StreamChunk {
  delta: string;
  finishReason: string | null;
  /**
   * Transient status describing live tool activity (e.g. a Civitai lookup).
   * When set, `delta` is empty and the text is for ephemeral display only —
   * it must NOT be appended to the saved assistant message.
   * Null clears the activity indicator after a batch of tools finishes.
   */
  toolStatus?: string | null;
  toolActivity?: ToolActivity;
  /** Persistent user-visible notice when the per-reply tool budget is exhausted. */
  toolRoundLimit?: number;
}

export interface FormState {
  prompt: string;
  negativePrompt: string;
  model?: string;
  /** IDs from the generator's model link; the label alone is not an exact base-model ID. */
  modelId?: number;
  modelVersionId?: number;
  cfgScale?: number;
  steps?: number;
  sampler?: string;
  seed?: number;
  clipSkip?: number;
  aspectRatio?: string;
  /** Ratios the active model actually exposes, e.g. ['2:3','1:1','3:2']. */
  availableAspectRatios?: string[];
  /** Video only: the clip lengths in seconds the form offers, e.g. [5, 10]. */
  duration?: number;
  availableDurations?: number[];
  /** Video only: output resolution selected/offered by the active model. */
  resolution?: string;
  availableResolutions?: string[];
  /** Video only: whether the active model is configured to generate audio. */
  generateAudio?: boolean;
  /** Active video workflow inferred from CivitAI's workflow heading. */
  videoWorkflow?: VideoWorkflow;
  /** Images already uploaded into the active generator, in visible slot order. */
  generatorImages?: GeneratorImage[];
  /** Source-image slots exposed by the active workflow/model, including empty slots. */
  availableGeneratorImageSlots?: GeneratorImageSlot[];
  /**
   * Numeric limits exposed by CivitAI's live controls. Video ecosystems use very
   * different CFG/duration ranges, so the model must not rely on a global default.
   */
  parameterRanges?: Partial<
    Record<
      'cfgScale' | 'steps' | 'clipSkip' | 'duration',
      { min: number; max: number; step?: number }
    >
  >;
  /**
   * Which controls the form actually renders for the loaded model. Distilled models hide
   * CFG/sampler/clip-skip, some hide the negative prompt entirely — without this the model
   * proposes fields that silently vanish on Apply.
   */
  availableFields?: string[];
}
