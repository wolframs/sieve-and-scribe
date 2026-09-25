import type { ProposedAction } from './page-tools';
import type { FormState, GenerationParams } from './types';
import type { PageActionResult } from './action-state';
import { recordDebugEvent } from './diagnostic-log';

/** ProseMirror may collapse line breaks/spaces while retaining the same prompt text. */
export function normalizePromptText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

type PromptAction = Extract<ProposedAction, { kind: 'prompt' }>;

export interface PromptActionDeps {
  isGeneratorAvailable(): boolean;
  setPrompt(field: 'prompt' | 'negativePrompt', value: string): boolean;
  setParameter(field: string, value: string | number | boolean): boolean;
  readFormState(): FormState | null;
  highlightField(field: string): void;
}

const PARAM_FIELDS: Array<keyof GenerationParams> = [
  'cfgScale',
  'steps',
  'sampler',
  'seed',
  'clipSkip',
  'aspectRatio',
  'duration',
  'resolution',
  'generateAudio',
];

/**
 * Apply a confirmed prompt proposal and verify the effective form state before reporting
 * success. A setter returning false is a failed mutation, not a harmless best effort: the
 * proposal schema was already tailored to controls exposed by the live form.
 */
export function applyPromptAction(
  action: PromptAction,
  deps: PromptActionDeps
): PageActionResult {
  if (!deps.isGeneratorAvailable()) {
    return {
      success: false,
      error: "Open CivitAI's generator first — the /generate page or the Create drawer.",
    };
  }

  const failedFields: string[] = [];
  const writePrompt = (field: 'prompt' | 'negativePrompt', value: string) => {
    if (deps.setPrompt(field, value)) deps.highlightField(field);
    else failedFields.push(field);
  };
  const writeParameter = (field: keyof GenerationParams, value: string | number | boolean) => {
    if (deps.setParameter(field, value)) deps.highlightField(field);
    else failedFields.push(field);
  };

  writePrompt('prompt', action.positive);
  if (action.negative !== undefined) writePrompt('negativePrompt', action.negative);
  for (const field of PARAM_FIELDS) {
    const value = action.params?.[field];
    if (value !== undefined) writeParameter(field, value);
  }

  if (failedFields.length) {
    return {
      success: false,
      error: `Could not apply ${failedFields.join(', ')} — the form changed or no longer exposes those controls.`,
    };
  }

  const observed = deps.readFormState();
  const verification = verifyPromptAction(action, observed);
  const textCheck = (expected: string, actual: string) => ({
    expectedLength: expected.length,
    observedLength: actual.length,
    expectedLineBreaks: (expected.match(/\n/g) ?? []).length,
    observedLineBreaks: (actual.match(/\n/g) ?? []).length,
    exactMatch: expected === actual,
    whitespaceEquivalent: normalizePromptText(expected) === normalizePromptText(actual),
  });
  void recordDebugEvent('content', 'form.verification', {
    success: verification.success, error: verification.error,
    textChecks: observed ? {
      positive: textCheck(action.positive, observed.prompt),
      ...(action.negative !== undefined ? { negative: textCheck(action.negative, observed.negativePrompt) } : {}),
    } : null,
    expectedParameters: action.params,
    observedParameters: observed ? Object.fromEntries(PARAM_FIELDS.map((key) => [key, observed[key]])) : null,
  });
  return verification.success
    ? { success: true, error: null }
    : verification;
}

/** Pure postcondition check used by the controller/state-machine tests in the next slice. */
export function verifyPromptAction(
  action: PromptAction,
  observed: FormState | null
): PageActionResult {
  if (!observed) {
    return { success: false, error: 'Could not verify the form after applying the prompt.' };
  }

  const mismatches: string[] = [];
  if (normalizePromptText(observed.prompt) !== normalizePromptText(action.positive)) mismatches.push('prompt');
  if (action.negative !== undefined && normalizePromptText(observed.negativePrompt) !== normalizePromptText(action.negative)) {
    mismatches.push('negativePrompt');
  }
  for (const field of PARAM_FIELDS) {
    const expected = action.params?.[field];
    if (expected !== undefined && observed[field] !== expected) mismatches.push(field);
  }

  return mismatches.length
    ? {
        success: false,
        error: `CivitAI did not retain the requested ${mismatches.join(', ')} value${
          mismatches.length === 1 ? '' : 's'
        }.`,
      }
    : { success: true, error: null };
}
