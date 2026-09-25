/** CustomEvent bridge between the isolated content script and CivitAI's page world. */
export const GENERATOR_PROMPT_SET_EVENT = 'cllp:generator-prompt-set';
export const GENERATOR_PROMPT_RESULT_EVENT = 'cllp:generator-prompt-result';
export const GENERATOR_PROMPT_TARGET_ATTR = 'data-cllp-prompt-target';
export const GENERATOR_RESOURCE_SET_EVENT = 'cllp:generator-resource-set';
export const GENERATOR_RESOURCE_RESULT_EVENT = 'cllp:generator-resource-result';
export const GENERATOR_RESOURCE_TARGET_ATTR = 'data-cllp-resource-target';

export interface GeneratorResourceRequest {
  id: string;
  versionId: number;
  weight?: number;
}

export interface GeneratorResourceResult {
  id: string;
  ok: boolean;
  error?: string;
  unknown?: boolean;
}

export interface GeneratorPromptSetRequest {
  id: string;
  value: string;
}

export interface GeneratorPromptSetResult {
  id: string;
  ok: boolean;
}
