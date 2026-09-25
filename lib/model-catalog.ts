/**
 * Live model catalogs for OpenRouter and xAI, so the picker isn't stuck on a
 * hardcoded 2025 roster. Both providers publish model lists with modality info:
 *   - OpenRouter: GET {base}/models (public) — architecture.input_modalities,
 *     created, supported_parameters
 *   - xAI: GET {base}/language-models (authed) — input_modalities, aliases
 * Lists are filtered to image-INPUT models (the chat attaches page images) and
 * cached in extension storage with a TTL; a failed refresh keeps the stale list
 * (a stale catalog beats an empty picker). Fetches go through the background
 * LLM proxy so CORS never enters the picture.
 */
import { llmFetchText } from './llm-proxy';
import { settingsStorage } from './storage';
import { PROVIDER_DEFAULTS } from './constants';

export interface CatalogModel {
  id: string;
  vendor: string;
  /** Unix seconds — release recency, used for "latest per vendor" curation. */
  created: number;
  /** Whether the model accepts tool definitions (the chat always sends tools). */
  supportsTools: boolean;
}

interface CatalogEntry {
  ts: number;
  models: CatalogModel[];
}

export const modelCatalogStorage = storage.defineItem<Record<string, CatalogEntry>>(
  'local:cllpModelCatalog',
  { fallback: {} }
);

/** Favorite model ids, keyed by provider id. */
export const favoriteModelsStorage = storage.defineItem<Record<string, string[]>>(
  'local:cllpFavoriteModels',
  { fallback: {} }
);

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export function providerHasCatalog(providerId: string): boolean {
  return providerId === 'openrouter' || providerId === 'xai';
}

async function fetchOpenRouterModels(baseURL: string): Promise<CatalogModel[]> {
  const { ok, status, bodyText } = await llmFetchText({ url: `${baseURL}/models`, method: 'GET' });
  if (!ok) throw new Error(`OpenRouter model list: HTTP ${status}`);
  const data = JSON.parse(bodyText) as { data?: unknown[] };
  const out: CatalogModel[] = [];
  for (const raw of data.data ?? []) {
    const m = raw as {
      id?: string;
      created?: number;
      architecture?: { input_modalities?: string[]; output_modalities?: string[] };
      supported_parameters?: string[];
    };
    const inputs = m.architecture?.input_modalities ?? [];
    const outputs = m.architecture?.output_modalities ?? [];
    if (!inputs.includes('image') || !outputs.includes('text')) continue;
    const id = String(m.id ?? '');
    // Skip vendor-less entries and OpenRouter's own router pseudo-models (auto, free).
    if (!id.includes('/') || id.startsWith('openrouter/')) continue;
    out.push({
      id,
      vendor: id.split('/')[0],
      created: Number(m.created) || 0,
      supportsTools: (m.supported_parameters ?? []).includes('tools'),
    });
  }
  return out;
}

async function fetchXaiModels(baseURL: string, apiKey: string): Promise<CatalogModel[]> {
  if (!apiKey) throw new Error('xAI model list needs an API key');
  const { ok, status, bodyText } = await llmFetchText({
    url: `${baseURL}/language-models`,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!ok) throw new Error(`xAI model list: HTTP ${status}`);
  const data = JSON.parse(bodyText) as { models?: unknown[] };
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const raw of data.models ?? []) {
    const m = raw as { id?: string; created?: number; input_modalities?: string[]; aliases?: string[] };
    if (!(m.input_modalities ?? []).includes('image')) continue;
    // Prefer the shortest stable alias ("grok-4.20") over the dated internal id
    // ("grok-4.20-0309-reasoning"); skip the moving "-latest" aliases.
    const names = [m.id, ...(m.aliases ?? [])].filter(
      (n): n is string => typeof n === 'string' && !!n && !n.endsWith('-latest')
    );
    if (!names.length) continue;
    const id = names.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    if (seen.has(id)) continue;
    seen.add(id);
    // The endpoint doesn't report tool support; all current grok chat models have it.
    out.push({ id, vendor: 'xai', created: Number(m.created) || 0, supportsTools: true });
  }
  return out;
}

/**
 * Refresh the cached catalog for a provider if it's stale (or `force`).
 * Returns true when the cache changed. Never throws: on failure the stale
 * cache (or the static default list) stays in effect.
 */
export async function refreshModelCatalog(providerId: string, force = false): Promise<boolean> {
  if (!providerHasCatalog(providerId)) return false;
  const all = await modelCatalogStorage.getValue();
  const entry = all[providerId];
  if (!force && entry && Date.now() - entry.ts < CATALOG_TTL_MS) return false;
  const settings = await settingsStorage.getValue();
  const provider = settings.providers[providerId];
  const baseURL = provider?.baseURL || PROVIDER_DEFAULTS[providerId]?.baseURL || '';
  try {
    const models =
      providerId === 'openrouter'
        ? await fetchOpenRouterModels(baseURL)
        : await fetchXaiModels(baseURL, provider?.apiKey ?? '');
    // An empty list means the API answered but our filter/shape no longer matches
    // (schema drift) — keep whatever we had rather than blanking the picker.
    if (!models.length) return false;
    await modelCatalogStorage.setValue({ ...all, [providerId]: { ts: Date.now(), models } });
    return true;
  } catch (err) {
    console.debug('[cllp] model catalog refresh failed:', err);
    return false;
  }
}

/**
 * The curated picker list. Everything is already image-input-filtered; on top:
 *   - OpenRouter: tool-capable only (the chat always sends tools), max 3 models
 *     per vendor (newest first), vendor blocks ordered by their newest release.
 *   - xAI: the full (small) roster, newest first.
 */
export function curatedModels(providerId: string, models: CatalogModel[]): CatalogModel[] {
  const sorted = [...models].sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  if (providerId !== 'openrouter') return sorted;
  const perVendor = new Map<string, CatalogModel[]>();
  for (const m of sorted) {
    if (!m.supportsTools) continue;
    const list = perVendor.get(m.vendor) ?? [];
    if (list.length < 3) {
      list.push(m);
      perVendor.set(m.vendor, list);
    }
  }
  return [...perVendor.values()]
    .sort((a, b) => b[0].created - a[0].created)
    .flatMap((list) => list);
}

/** Toggle a model in the active provider's favorites. */
export async function toggleFavoriteModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  const settings = await settingsStorage.getValue();
  const providerId = settings.activeProviderId;
  const all = await favoriteModelsStorage.getValue();
  const favs = all[providerId] ?? [];
  const next = favs.includes(trimmed) ? favs.filter((f) => f !== trimmed) : [...favs, trimmed];
  await favoriteModelsStorage.setValue({ ...all, [providerId]: next });
}
