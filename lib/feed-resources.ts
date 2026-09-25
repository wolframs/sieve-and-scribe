import type { FeedResourceRef } from './feed-facets';

const CIVITAI_MODELS_PATH = '/api/v1/models';

/**
 * Resolve user-entered model/resource text to concrete CivitAI model-version IDs.
 * This runs only while the resource picker is in use; feed cards are never enriched or looked up.
 */
export async function searchFeedResources(
  query: string,
  signal?: AbortSignal,
  limit = 16
): Promise<FeedResourceRef[]> {
  const normalized = query.trim();
  if (normalized.length < 2) return [];
  const pageOrigin = typeof location !== 'undefined' && /^https:\/\/(?:www\.)?civitai\.(?:com|red)$/.test(location.origin)
    ? location.origin
    : 'https://civitai.com';
  const url = new URL(CIVITAI_MODELS_PATH, pageOrigin);
  url.searchParams.set('query', normalized);
  url.searchParams.set('sort', 'Most Downloaded');
  url.searchParams.set('limit', '8');
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
    signal,
  });
  if (!response.ok) throw new Error(`CivitAI model search failed (${response.status})`);
  const data = await response.json();
  const out: FeedResourceRef[] = [];
  const seen = new Set<number>();
  for (const model of Array.isArray(data?.items) ? data.items : []) {
    const modelName = cleanLabel(model?.name, 'Untitled model');
    const type = cleanLabel(model?.type, 'Resource');
    for (const version of Array.isArray(model?.modelVersions) ? model.modelVersions : []) {
      const versionId = Number(version?.id);
      if (!Number.isInteger(versionId) || versionId <= 0 || seen.has(versionId)) continue;
      seen.add(versionId);
      const versionName = cleanLabel(version?.name, `Version ${versionId}`);
      out.push({ versionId, label: `${modelName} — ${versionName} (${type})`.slice(0, 120) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function cleanLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim()
    : fallback;
}
