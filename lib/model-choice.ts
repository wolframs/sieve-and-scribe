/**
 * Model choice helpers for the chat header's model picker. Choices come in
 * groups: the user's favorites first, then the live curated catalog (see
 * model-catalog.ts) — falling back to the static PROVIDER_DEFAULTS roster when
 * no catalog has been fetched yet (custom provider, no key, offline).
 * Writes go to the active provider's defaultModel.
 */
import { settingsStorage } from './storage';
import { PROVIDER_DEFAULTS } from './constants';
import {
  modelCatalogStorage,
  favoriteModelsStorage,
  curatedModels,
  refreshModelCatalog,
  providerHasCatalog,
} from './model-catalog';

export interface ModelGroup {
  label: string;
  models: string[];
}

export interface ModelChoices {
  provider: string;
  current: string;
  groups: ModelGroup[];
  favorites: string[];
  /** Whether this provider serves a live catalog (enables All-models search + refresh). */
  hasCatalog: boolean;
}

/** Grouped choices for the ACTIVE provider (chat header picker). */
export async function getModelChoices(): Promise<ModelChoices> {
  const settings = await settingsStorage.getValue();
  return getModelChoicesFor(settings.activeProviderId);
}

/** Grouped choices for a specific provider (options page shows both providers at once). */
export async function getModelChoicesFor(providerId: string): Promise<ModelChoices> {
  const settings = await settingsStorage.getValue();
  const current = settings.providers[providerId]?.defaultModel ?? '';
  const favorites = (await favoriteModelsStorage.getValue())[providerId] ?? [];
  const catalog = (await modelCatalogStorage.getValue())[providerId];

  const groups: ModelGroup[] = [];
  const favSet = new Set(favorites);
  if (favorites.length) groups.push({ label: '★ Favorites', models: favorites });

  const curated = catalog?.models.length
    ? curatedModels(providerId, catalog.models).map((m) => m.id)
    : [...(PROVIDER_DEFAULTS[providerId]?.models ?? [])];
  const rest = curated.filter((id) => !favSet.has(id));
  if (rest.length) {
    groups.push({ label: catalog?.models.length ? 'Latest (image-capable)' : 'Models', models: rest });
  }
  // The configured model must always be pickable, even when it's in neither list
  // (custom entry, or a model that dropped out of the catalog).
  if (current && !favSet.has(current) && !rest.includes(current)) {
    groups.unshift({ label: 'Current', models: [current] });
  }
  return { provider: providerId, current, groups, favorites, hasCatalog: providerHasCatalog(providerId) };
}

/**
 * The full image-input model list for search, fetching the catalog first if
 * none is cached. Alphabetical; falls back to the static roster.
 */
export async function getFullModelList(): Promise<string[]> {
  const settings = await settingsStorage.getValue();
  return getFullModelListFor(settings.activeProviderId);
}

export async function getFullModelListFor(providerId: string): Promise<string[]> {
  await refreshModelCatalog(providerId);
  const catalog = (await modelCatalogStorage.getValue())[providerId];
  const ids = catalog?.models.map((m) => m.id) ?? [];
  return ids.length ? ids.sort((a, b) => a.localeCompare(b)) : [...(PROVIDER_DEFAULTS[providerId]?.models ?? [])];
}

export async function setActiveModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  const settings = await settingsStorage.getValue();
  const provider = settings.providers[settings.activeProviderId];
  if (!provider) return;
  provider.defaultModel = trimmed;
  await settingsStorage.setValue(settings);
}
