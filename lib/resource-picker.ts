import { parse as parseDevalue } from 'devalue';
import {
  GENERATOR_RESOURCE_TARGET_ATTR,
  type GeneratorResourceRequest,
  type GeneratorResourceResult,
} from './generator-page-bridge';

interface PickerContext {
  selectSource: 'generation';
  onSelect: (resource: Record<string, unknown>) => void;
  resources: Array<{ type: string; baseModels: string[] }>;
  excludedIds: number[];
  staged?: unknown[];
  limit?: number;
}

/** CivitAI's ResourceSelectProvider context, scoped to the open picker's search input.
 * This deliberately avoids changing HiddenPreferences/BrowsingLevel providers or API results.
 * Upstream: src/components/ImageGeneration/GenerationForm/ResourceSelectProvider.tsx.
 */
function pickerContext(target: HTMLElement): PickerContext | null {
  const key = Object.keys(target).find((key) => key.startsWith('__reactFiber$'));
  let fiber = key ? (target as any)[key] : null;
  // DOM nodes may retain the alternate fiber after a React commit.
  let root = fiber;
  while (root?.return) root = root.return;
  if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber.alternate;
  for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
    const value = fiber.memoizedProps?.value;
    if (value?.selectSource === 'generation' && typeof value.onSelect === 'function' &&
        Array.isArray(value.resources) && Array.isArray(value.excludedIds) && value.filters) return value;
  }
  return null;
}

export function decodeGenerationData(body: any): { resources: any[] } {
  const envelope = Array.isArray(body) ? body[0] : body;
  if (envelope?.error) throw new Error('CivitAI rejected the resource lookup. Check your login and resource access.');
  const encoded = envelope?.result?.data;
  const data = typeof encoded === 'string' ? parseDevalue(encoded) : encoded?.json ?? encoded;
  if (!data || !Array.isArray(data.resources)) throw new Error('CivitAI returned an unexpected resource response. Its API may have changed.');
  return data;
}

/** Read-only metadata fetch, followed by the same onSelect callback as CivitAI's own card.
 * No name search, global filter edits, alternate version substitution, or Generate call.
 */
export async function selectExactResource(request: GeneratorResourceRequest): Promise<GeneratorResourceResult> {
  const result = { id: request.id, ok: false };
  let selectionStarted = false;
  try {
    if (!Number.isSafeInteger(request.versionId) || request.versionId <= 0 ||
        (request.weight !== undefined && !Number.isFinite(request.weight))) throw new Error('Invalid resource version or weight.');
    const target = [...document.querySelectorAll<HTMLElement>(`[${GENERATOR_RESOURCE_TARGET_ATTR}]`)]
      .find((element) => element.getAttribute(GENERATOR_RESOURCE_TARGET_ATTR) === request.id);
    if (!target || !pickerContext(target)) throw new Error('Could not connect to CivitAI’s resource picker. Its UI may have changed; refresh the page and try again.');

    const url = new URL('/api/trpc/generation.getGenerationData', location.origin);
    url.searchParams.set('input', JSON.stringify({ json: { type: 'modelVersion', id: request.versionId, withPreview: true } }));
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`CivitAI resource lookup failed (HTTP ${response.status}). Check your login or try again later.`);
    const data = decodeGenerationData(await response.json());
    const resource = data.resources.find((resource) => resource?.id === request.versionId);
    if (!resource) throw new Error(`CivitAI did not return version ${request.versionId}; no other version was selected.`);
    if (resource.canGenerate !== true || resource.hasAccess !== true) throw new Error('This exact resource version is unavailable for generation or your account does not have access.');
    // Re-read after the network wait: checkpoint/options or the dialog may have changed.
    const picker = target.isConnected && target.getAttribute(GENERATOR_RESOURCE_TARGET_ATTR) === request.id ? pickerContext(target) : null;
    if (!picker) throw new Error('The resource picker closed or changed before selection.');
    if (picker.excludedIds.includes(request.versionId)) throw new Error('This resource is already selected or excluded by the generator.');
    if (picker.staged?.length) throw new Error('The picker has a staged selection. Finish or clear it before applying this suggestion.');
    if (picker.limit !== undefined && picker.limit <= 0) throw new Error('The generator’s resource limit has been reached.');
    if (!picker.resources.some((rule) => rule.type === resource.model?.type &&
        Array.isArray(rule.baseModels) && rule.baseModels.includes(resource.baseModel))) {
      throw new Error('This resource is not compatible with the generator’s current resource types and base model.');
    }
    if (request.weight !== undefined && (
      !Number.isFinite(resource.minStrength) || !Number.isFinite(resource.maxStrength) ||
      request.weight < resource.minStrength || request.weight > resource.maxStrength
    )) throw new Error(`Requested weight is outside this resource’s supported range (${resource.minStrength}–${resource.maxStrength}).`);
    selectionStarted = true;
    picker.onSelect({ ...resource, ...(request.weight !== undefined ? { strength: request.weight } : {}) });
    return { id: request.id, ok: true };
  } catch (error) {
    return { ...result, error: error instanceof Error ? error.message : 'Resource selection failed.', ...(selectionStarted ? { unknown: true } : {}) };
  }
}
