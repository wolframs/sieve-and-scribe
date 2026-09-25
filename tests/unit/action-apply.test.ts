import { describe, expect, it, vi } from 'vitest';
import {
  applyPromptAction,
  verifyPromptAction,
  type PromptActionDeps,
} from '@/lib/action-apply';
import type { ProposedAction } from '@/lib/page-tools';
import type { FormState } from '@/lib/types';

const action: Extract<ProposedAction, { kind: 'prompt' }> = {
  kind: 'prompt',
  positive: 'rain-soaked Berlin portrait',
  negative: 'text, watermark',
  params: { steps: 28, cfgScale: 5.5, aspectRatio: '2:3' },
};

function state(overrides: Partial<FormState> = {}): FormState {
  return {
    prompt: action.positive,
    negativePrompt: action.negative!,
    steps: 28,
    cfgScale: 5.5,
    aspectRatio: '2:3',
    ...overrides,
  };
}

function deps(overrides: Partial<PromptActionDeps> = {}): PromptActionDeps {
  return {
    isGeneratorAvailable: vi.fn(() => true),
    setPrompt: vi.fn(() => true),
    setParameter: vi.fn(() => true),
    readFormState: vi.fn(() => state()),
    highlightField: vi.fn(),
    ...overrides,
  };
}

describe('confirmed prompt application', () => {
  it('accepts line breaks collapsed by the editor, including negative text', () => {
    const requested = { ...action, positive: 'subject: glass figure\nsetting: golden grass\nlighting: sunset', negative: 'blur,\nwatermark' };
    expect(verifyPromptAction(requested, state({
      prompt: 'subject: glass figure setting: golden grass lighting: sunset',
      negativePrompt: 'blur, watermark',
    }))).toEqual({ success: true, error: null });
  });

  it('still rejects lost words, punctuation, and changed numeric settings', () => {
    for (const prompt of ['rain-soaked portrait', 'rain soaked Berlin portrait']) {
      expect(verifyPromptAction(action, state({ prompt })).success).toBe(false);
    }
    expect(verifyPromptAction(action, state({ steps: 27 })).success).toBe(false);
  });

  it('reports success only after every requested value is observed', () => {
    const runtime = deps();

    expect(applyPromptAction(action, runtime)).toEqual({ success: true, error: null });
    expect(runtime.setPrompt).toHaveBeenCalledWith('prompt', action.positive);
    expect(runtime.setPrompt).toHaveBeenCalledWith('negativePrompt', action.negative);
    expect(runtime.setParameter).toHaveBeenCalledWith('steps', 28);
    expect(runtime.setParameter).toHaveBeenCalledWith('cfgScale', 5.5);
    expect(runtime.setParameter).toHaveBeenCalledWith('aspectRatio', '2:3');
  });

  it('fails immediately when a requested form setter is unavailable', () => {
    const runtime = deps({
      setParameter: vi.fn((field) => field !== 'steps'),
    });

    expect(applyPromptAction(action, runtime)).toEqual({
      success: false,
      error: 'Could not apply steps — the form changed or no longer exposes those controls.',
    });
    expect(runtime.readFormState).not.toHaveBeenCalled();
  });

  it('catches the old false-success shape where invocation does not change effective state', () => {
    const runtime = deps({ readFormState: vi.fn(() => state({ prompt: '' })) });

    expect(applyPromptAction(action, runtime)).toEqual({
      success: false,
      error: 'CivitAI did not retain the requested prompt value.',
    });
  });

  it('reports all mismatched postconditions for model-visible recovery', () => {
    expect(
      verifyPromptAction(action, state({ negativePrompt: '', steps: 20, aspectRatio: '1:1' }))
    ).toEqual({
      success: false,
      error: 'CivitAI did not retain the requested negativePrompt, steps, aspectRatio values.',
    });
  });

  it('does not attempt any mutation away from the generator', () => {
    const runtime = deps({ isGeneratorAvailable: vi.fn(() => false) });

    expect(applyPromptAction(action, runtime).success).toBe(false);
    expect(runtime.setPrompt).not.toHaveBeenCalled();
    expect(runtime.setParameter).not.toHaveBeenCalled();
  });
});
