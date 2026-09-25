import type { GenerationPrompt, FormState } from '@/lib/types';
import { PROMPT_TEMPLATE_TAGS } from '@/lib/constants';

/** Only explicit prompt payloads may be applied; explanatory prose is never a prompt. */
export function hasPromptPayload(content: string): boolean {
  return Boolean(extractTag(content, 'prompt')?.trim());
}

/**
 * Parse an assistant message to extract structured prompt data.
 * Looks for XML-tagged sections: <prompt>, <negative>, <params>.
 * Falls back to treating the entire response as the positive prompt.
 */
export function parseAssistantMessage(content: string): GenerationPrompt {
  const result: GenerationPrompt = {
    positivePrompt: '',
  };

  // Extract positive prompt
  const promptMatch = extractTag(content, 'prompt');
  if (promptMatch) {
    result.positivePrompt = promptMatch.trim();
  }

  // Extract negative prompt
  const negativeMatch = extractTag(content, 'negative');
  if (negativeMatch) {
    result.negativePrompt = negativeMatch.trim();
  }

  // Extract params
  const paramsMatch = extractTag(content, 'params');
  if (paramsMatch) {
    result.params = parseParams(paramsMatch);
  }

  // Fallback: if no XML tags found, treat entire response as positive prompt
  if (!result.positivePrompt && !result.negativePrompt) {
    result.positivePrompt = content.trim();
  }

  return result;
}

/**
 * Extract content between XML-style tags.
 */
function extractTag(content: string, tagName: string): string | null {
  const tag = PROMPT_TEMPLATE_TAGS[tagName as keyof typeof PROMPT_TEMPLATE_TAGS];
  if (!tag) return null;

  const regex = new RegExp(
    escapeRegex(tag.open) + '([\\s\\S]*?)' + escapeRegex(tag.close),
    'i'
  );
  const match = content.match(regex);
  if (match) return match[1].trim();

  // Recovery for a max_tokens-truncated reply: the model opened the tag and the
  // stream ended before it could close it. Without this, nothing matches, the
  // no-tags fallback fires, and Apply writes the literal "<prompt>…" into the
  // form. Stop at the next template tag so a truncated section can't swallow a
  // following one.
  const openIdx = content.toLowerCase().indexOf(tag.open.toLowerCase());
  if (openIdx === -1) return null;
  const rest = content.slice(openIdx + tag.open.length);
  const nextTag = rest.search(/<\/?(?:prompt|negative|params)>/i);
  const body = (nextTag === -1 ? rest : rest.slice(0, nextTag)).trim();
  return body || null;
}

/**
 * Parse the <params> section into a key-value object.
 */
function parseParams(content: string): GenerationPrompt['params'] {
  const params: NonNullable<GenerationPrompt['params']> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const value = trimmed.slice(colonIndex + 1).trim();

    switch (key) {
      case 'cfgscale':
      case 'cfg_scale':
      case 'cfg': {
        const num = parseFloat(value);
        if (!isNaN(num)) params.cfgScale = num;
        break;
      }
      case 'steps': {
        const num = parseInt(value);
        if (!isNaN(num)) params.steps = num;
        break;
      }
      case 'sampler':
        params.sampler = value;
        break;
      case 'duration':
      case 'seconds': {
        // "5", "5s", "5 seconds" all mean the same clip length.
        const num = parseFloat(value);
        if (!isNaN(num)) params.duration = num;
        break;
      }
      case 'resolution':
        params.resolution = value;
        break;
      case 'generateaudio':
      case 'generate_audio':
      case 'audio': {
        if (/^(?:true|yes|on|1)$/i.test(value)) params.generateAudio = true;
        if (/^(?:false|no|off|0)$/i.test(value)) params.generateAudio = false;
        break;
      }
      case 'seed': {
        const num = parseInt(value);
        if (!isNaN(num)) params.seed = num;
        break;
      }
      case 'clipskip':
      case 'clip_skip': {
        const num = parseInt(value);
        if (!isNaN(num)) params.clipSkip = num;
        break;
      }
      case 'aspectratio':
      case 'aspect_ratio':
        params.aspectRatio = value;
        break;
    }
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Format the current form state as context for the LLM.
 */
export function formatPromptForLLM(state: FormState): string {
  const parts: string[] = [];

  if (state.prompt) {
    parts.push(`Current positive prompt: ${state.prompt}`);
  }
  if (state.negativePrompt) {
    parts.push(`Current negative prompt: ${state.negativePrompt}`);
  }
  if (state.model) {
    parts.push(`Current model: ${state.model}`);
  }
  if (state.cfgScale !== undefined) {
    parts.push(`Current CFG Scale: ${state.cfgScale}`);
  }
  if (state.steps !== undefined) {
    parts.push(`Current Steps: ${state.steps}`);
  }
  if (state.sampler) {
    parts.push(`Current Sampler: ${state.sampler}`);
  }
  if (state.seed !== undefined) {
    parts.push(`Current Seed: ${state.seed}`);
  }
  if (state.aspectRatio) {
    parts.push(`Current Aspect Ratio: ${state.aspectRatio}`);
  }
  // The active model decides which ratios the form offers (an SDXL checkpoint typically
  // exposes only 2:3 / 1:1 / 3:2). Without this the model recommends plausible-but-absent
  // ratios like 3:4, which silently snap to the nearest available one on Apply.
  if (state.availableAspectRatios?.length) {
    parts.push(
      `Aspect ratios this model offers — choose EXACTLY one of these, never any other: ${state.availableAspectRatios.join(', ')}`
    );
  }
  if (state.availableDurations?.length) {
    parts.push(
      `Clip durations this video model offers (seconds) — pick one of these: ${state.availableDurations.join(', ')}` +
        (state.duration !== undefined ? ` (currently ${state.duration}s)` : '')
    );
  } else if (state.duration !== undefined) {
    parts.push(`Current Duration: ${state.duration}s`);
  }
  if (state.availableResolutions?.length) {
    parts.push(
      `Video resolutions this model offers — choose EXACTLY one of these: ${state.availableResolutions.join(', ')}` +
        (state.resolution ? ` (currently ${state.resolution})` : '')
    );
  } else if (state.resolution) {
    parts.push(`Current Resolution: ${state.resolution}`);
  }
  if (state.generateAudio !== undefined) {
    parts.push(`Generate Audio: ${state.generateAudio ? 'enabled' : 'disabled'}`);
  }
  if (state.videoWorkflow) {
    const label = {
      textToVideo: 'Text to Video',
      imageToVideo: 'Image to Video',
      referenceToVideo: 'Reference to Video',
    }[state.videoWorkflow];
    parts.push(`Current Video Workflow: ${label}`);
  }
  if (state.availableGeneratorImageSlots?.length) {
    if (state.availableGeneratorImageSlots.includes('reference')) {
      parts.push(
        `Generator reference images already loaded: ${state.generatorImages?.length ?? 0}. ` +
          'Call view_generator_images to inspect them.'
      );
    } else {
      const slotStatus = state.availableGeneratorImageSlots.map((slot) => {
        const filled = state.generatorImages?.some((image) => image.slot === slot);
        return `${slot}=${filled ? 'filled' : 'empty'}`;
      });
      parts.push(
        `Generator image slots: ${slotStatus.join(', ')}. ` +
          'Call view_generator_images before reasoning about any filled slot.'
      );
    }
  }
  if (state.parameterRanges && Object.keys(state.parameterRanges).length) {
    const ranges = Object.entries(state.parameterRanges).map(([field, range]) => {
      const step = range?.step !== undefined ? `, step ${range.step}` : '';
      return `${field} ${range?.min}–${range?.max}${step}`;
    });
    parts.push(
      `Numeric control limits for this exact model — stay inside them: ${ranges.join('; ')}`
    );
  }
  // Same reasoning as the ratios: the form is model-dependent, and anything proposed for a
  // control this model doesn't render is silently dropped when the user hits Apply.
  if (state.availableFields?.length) {
    parts.push(
      `Controls you can read and set for this model: ${state.availableFields.join(', ')}. ` +
        'Do not put any other field in <params> or propose_prompt — it would be silently ' +
        "dropped on Apply (e.g. no 'negativePrompt' here means this model takes no negative " +
        "prompt at all; 'loraResources' means LoRAs attach via propose_resource, never via " +
        '<lora:> text). The form may still show controls this list omits (quantity, ' +
        "ControlNets, output format) — recommend those in prose and tell the user to set " +
        'them by hand.'
    );
  }
  if (state.clipSkip !== undefined) {
    parts.push(`Current Clip Skip: ${state.clipSkip}`);
  }

  return parts.join('\n');
}

/**
 * Build the complete system prompt with dynamic form context.
 */
export function buildSystemPrompt(
  userSystemPrompt: string,
  formState?: FormState
): string {
  let prompt = userSystemPrompt + '\n\n' + [
    'Tool failure reporting: When a tool or confirmed action reports an error, explain what operation failed and the observed error in plain language.',
    'Distinguish evidence from possible causes: missing controls can mean a closed or still-loading generator, model-specific controls, or a changed CivitAI UI that the extension no longer recognizes.',
    'Do not claim a UI change is confirmed without evidence.',
    'Use available page/form observations to narrow the cause and suggest a concrete next step; never invent a successful result.',
    'For session-sensitive or mature-content catalog lookups, prefer the built-in search_civitai_loras, get_civitai_model, and mine_civitai_prompts tools: they run through the active CivitAI tab on its own host. Site MCP is a separate service with token-based access, not the tab login session. Use the returned source and searchAttempts to describe the actual search scope. Do not blame a token, content filter, or generation-support filter merely because a search was empty; only name a confirmed cause when the tool reports it.',
    'A failed or unknown action may have partially applied: inspect state before proposing a retry, require fresh confirmation for mutations, and never automatically retry generation.',
    'For on-site LoRAs, prefer search_civitai_loras with checkpointVersionId from the current form. It resolves the exact base model and selects generation-supported versions. A model label or CFG/steps range alone does not prove the checkpoint variant. If no version ID is available, use model metadata or get_civitai_base_models instead of guessing a base-model spelling. Reuse confirmed metadata; do not repeatedly check the same base or identical search. If a bounded search returns no compatible results, explain that scope and offer a concrete alternative rather than searching indefinitely.',
  ].join(' ');

  if (formState) {
    if (formState.modelId) prompt += `\nCurrent checkpoint model ID: ${formState.modelId}`;
    if (formState.modelVersionId) prompt += `\nCurrent checkpoint version ID (use as checkpointVersionId for LoRA search): ${formState.modelVersionId}`;
    const formContext = formatPromptForLLM(formState);
    if (formContext) {
      prompt += `\n\n---\nCurrent CivitAI Form State:\n${formContext}\n---`;
    }
  }

  return prompt;
}

/**
 * Escape a string for use in a RegExp.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
