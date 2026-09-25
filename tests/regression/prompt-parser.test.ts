// Covers entrypoints/civitai.content/prompt-parser.ts: the tag-extraction contract
// (<prompt>/<negative>/<params>) that feeds both the Apply-to-form path and the
// chat-panel prompt card via parseAssistantMessage, plus buildSystemPrompt which
// lib/chat-controller.ts relies on to inject live form state into the LLM system prompt.
import { describe, it, expect } from 'vitest';
import {
  parseAssistantMessage,
  hasPromptPayload,
  buildSystemPrompt,
} from '@/entrypoints/civitai.content/prompt-parser';
import type { FormState } from '@/lib/types';

describe('parseAssistantMessage', () => {
  it('only enables Apply for an explicit nonempty prompt payload', () => {
    expect(hasPromptPayload('The Apply action failed. Would you like to retry?')).toBe(false);
    expect(hasPromptPayload('<params>steps: 25</params>')).toBe(false);
    expect(hasPromptPayload('<prompt>  </prompt>')).toBe(false);
    expect(hasPromptPayload('<PROMPT>rain</PROMPT>')).toBe(true);
    expect(hasPromptPayload('<prompt>unfinished but usable')).toBe(true);
  });
  it('parses the happy path: prompt, negative, and image/video params (including a colon-valued aspectRatio)', () => {
    const result = parseAssistantMessage(
      '<prompt>a cat, masterpiece</prompt>\n' +
        '<negative>blurry, low quality</negative>\n' +
        '<params>\n' +
        'cfgScale: 7\n' +
        'steps: 28\n' +
        'sampler: Euler a\n' +
        'aspectRatio: 2:3\n' +
        'clipSkip: 2\n' +
        'seed: 12345\n' +
        'duration: 8 seconds\n' +
        'resolution: 1080p\n' +
        'generateAudio: true\n' +
        '</params>'
    );

    expect(result.positivePrompt).toBe('a cat, masterpiece');
    expect(result.negativePrompt).toBe('blurry, low quality');
    expect(result.params).toEqual({
      cfgScale: 7,
      steps: 28,
      sampler: 'Euler a',
      aspectRatio: '2:3',
      clipSkip: 2,
      seed: 12345,
      duration: 8,
      resolution: '1080p',
      generateAudio: true,
    });
  });

  it('omits negativePrompt and params when those tags are absent', () => {
    const result = parseAssistantMessage('<prompt>a lone cat</prompt>');
    expect(result.positivePrompt).toBe('a lone cat');
    expect(result.negativePrompt).toBeUndefined();
    expect(result.params).toBeUndefined();
  });

  it('falls back to treating the whole message as the positive prompt when no tags match', () => {
    const raw = 'just a plain sentence with no tags';
    const result = parseAssistantMessage(raw);
    expect(result.positivePrompt).toBe(raw);
    expect(result.negativePrompt).toBeUndefined();
    expect(result.params).toBeUndefined();
  });

  it('recovers the prompt from a max_tokens-truncated <prompt> section', () => {
    // A truncated stream opens the tag and never closes it. Without recovery the
    // no-tags fallback fires and Apply writes the literal "<prompt>…" into the form.
    const result = parseAssistantMessage('<prompt>a cat that never closes');
    expect(result.positivePrompt).toBe('a cat that never closes');
  });

  it('does not let a truncated section swallow the tag that follows it', () => {
    const result = parseAssistantMessage(
      '<prompt>a cat\n<negative>blurry</negative>'
    );
    expect(result.positivePrompt).toBe('a cat');
    expect(result.negativePrompt).toBe('blurry');
  });

  it('leaves positivePrompt empty when only <negative> is present (no fallback triggered)', () => {
    // Fallback only fires when BOTH positivePrompt and negativePrompt are empty, so a
    // negative-only message does not fall back to raw content for the positive prompt.
    const result = parseAssistantMessage('<negative>ugly, deformed</negative>');
    expect(result.positivePrompt).toBe('');
    expect(result.negativePrompt).toBe('ugly, deformed');
  });

  it('matches tags case-insensitively', () => {
    const result = parseAssistantMessage('<PROMPT>a cat</PROMPT>');
    expect(result.positivePrompt).toBe('a cat');
  });

  it('ignores blank lines and lines without a colon inside <params>', () => {
    const result = parseAssistantMessage(
      '<prompt>x</prompt><params>\nsteps: 20\n\nthis is just junk text\ncfgScale: 5\n</params>'
    );
    expect(result.params).toEqual({ steps: 20, cfgScale: 5 });
  });

  it('drops unknown param keys and yields params: undefined when nothing recognized survives', () => {
    const result = parseAssistantMessage('<prompt>x</prompt><params>quality: high\nstyle: anime</params>');
    expect(result.params).toBeUndefined();
  });

  it('drops numeric params whose value fails to parse (NaN), keeping other valid keys', () => {
    const result = parseAssistantMessage(
      '<prompt>x</prompt><params>steps: not-a-number\ncfgScale: 7</params>'
    );
    expect(result.params).toEqual({ cfgScale: 7 });
  });

  it('accepts snake_case and short-form aliases for cfg/clipSkip params', () => {
    const result = parseAssistantMessage(
      '<prompt>x</prompt><params>cfg: 4.5\nclip_skip: 1</params>'
    );
    expect(result.params).toEqual({ cfgScale: 4.5, clipSkip: 1 });
  });

  it('parses both enabled and disabled generated-audio values', () => {
    expect(
      parseAssistantMessage(
        '<prompt>x</prompt><params>generate_audio: yes</params>'
      ).params
    ).toEqual({ generateAudio: true });
    expect(
      parseAssistantMessage(
        '<prompt>x</prompt><params>audio: off</params>'
      ).params
    ).toEqual({ generateAudio: false });
  });
});

describe('buildSystemPrompt', () => {
  it('retains the base prompt and adds failure guidance without form state', () => {
    const prompt = buildSystemPrompt('You are a helpful assistant.');
    expect(prompt).toContain('You are a helpful assistant.');
    expect(prompt).toContain('Tool failure reporting:');
    expect(prompt).not.toContain('Current CivitAI Form State:');
  });

  it('appends a "Current CivitAI Form State" block reflecting only the populated fields', () => {
    const formState: FormState = {
      prompt: 'a cat',
      negativePrompt: '',
      cfgScale: 7,
      sampler: 'Euler a',
    };
    const result = buildSystemPrompt('Base prompt.', formState);

    expect(result).toContain('Base prompt.');
    expect(result).toContain('Current CivitAI Form State:');
    expect(result).toContain('Current positive prompt: a cat');
    expect(result).toContain('Current CFG Scale: 7');
    expect(result).toContain('Current Sampler: Euler a');
    // Empty negativePrompt must not produce a "Current negative prompt:" line.
    expect(result).not.toContain('Current negative prompt:');
  });

  it('tells the model which aspect ratios the form actually offers', () => {
    // Without this the model recommends plausible-but-absent ratios (a 3:4 suggestion when
    // the loaded checkpoint only exposes 2:3 / 1:1 / 3:2), which silently snap on Apply.
    const result = buildSystemPrompt('Base prompt.', {
      prompt: 'a cat',
      negativePrompt: '',
      aspectRatio: '2:3',
      availableAspectRatios: ['2:3', '1:1', '3:2'],
    });

    expect(result).toContain('Current Aspect Ratio: 2:3');
    expect(result).toMatch(/choose EXACTLY one of these[^\n]*2:3, 1:1, 3:2/);
  });

  it('omits the available-ratio line when the form exposes none', () => {
    const result = buildSystemPrompt('Base prompt.', {
      prompt: 'a cat',
      negativePrompt: '',
      availableAspectRatios: [],
    });
    expect(result).not.toContain('choose EXACTLY one');
  });

  it('reports model-specific video options and numeric ranges', () => {
    const result = buildSystemPrompt('Base prompt.', {
      prompt: '',
      negativePrompt: '',
      cfgScale: 3,
      duration: 12,
      resolution: '1080p',
      availableResolutions: ['720p', '1080p'],
      generateAudio: false,
      videoWorkflow: 'imageToVideo',
      generatorImages: [
        {
          slot: 'firstFrame',
          url: 'https://orchestration-new.civitai.com/frame.jpg',
        },
      ],
      availableGeneratorImageSlots: ['firstFrame', 'lastFrame'],
      parameterRanges: {
        cfgScale: { min: 1, max: 10, step: 0.5 },
        duration: { min: 3, max: 20 },
      },
      availableFields: ['prompt', 'cfgScale', 'duration', 'resolution', 'generateAudio'],
    });

    expect(result).toContain('currently 1080p');
    expect(result).toContain('Generate Audio: disabled');
    expect(result).toContain('Current Video Workflow: Image to Video');
    expect(result).toContain('firstFrame=filled, lastFrame=empty');
    expect(result).toContain('Call view_generator_images');
    expect(result).toContain('cfgScale 1–10, step 0.5');
    expect(result).toContain('duration 3–20');
  });

  it('omits empty form context while retaining failure guidance', () => {
    // formatPromptForLLM returns '' for an all-empty/undefined FormState, and
    // buildSystemPrompt is guarded to skip appending the block in that case.
    const formState: FormState = { prompt: '', negativePrompt: '' };
    expect(buildSystemPrompt('Base prompt.', formState)).toBe(buildSystemPrompt('Base prompt.'));
  });
});
