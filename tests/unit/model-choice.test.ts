// Covers lib/model-choice.ts (and the storage items it reads via lib/model-catalog.ts):
// group ordering/dedup for the chat header's model picker, active-provider delegation,
// writing the active model, and toggling per-provider favorites.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getModelChoices, getModelChoicesFor, setActiveModel } from '@/lib/model-choice';
import {
  toggleFavoriteModel,
  modelCatalogStorage,
  favoriteModelsStorage,
  type CatalogModel,
} from '@/lib/model-catalog';
import { settingsStorage } from '@/lib/storage';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '@/lib/constants';

function catalogModel(id: string, created: number): CatalogModel {
  return { id, vendor: 'xai', created, supportsTools: true };
}

describe('getModelChoicesFor', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('with no cached catalog, falls back to the static PROVIDER_DEFAULTS roster labeled "Models"', async () => {
    const choices = await getModelChoicesFor('xai');
    expect(choices.groups).toEqual([{ label: 'Models', models: PROVIDER_DEFAULTS.xai.models }]);
    expect(choices.current).toBe(PROVIDER_DEFAULTS.xai.defaultModel);
  });

  it('with a cached catalog, labels the curated group "Latest (image-capable)"', async () => {
    // Include the settings default model (grok-4.3) so no extra "Current" group appears.
    await modelCatalogStorage.setValue({
      xai: { ts: Date.now(), models: [catalogModel('grok-4.3', 300), catalogModel('grok-8', 200), catalogModel('grok-7', 100)] },
    });
    const choices = await getModelChoicesFor('xai');
    expect(choices.groups).toEqual([
      { label: 'Latest (image-capable)', models: ['grok-4.3', 'grok-8', 'grok-7'] },
    ]);
  });

  it('puts favorites first and dedupes them out of the curated group', async () => {
    await modelCatalogStorage.setValue({
      xai: { ts: Date.now(), models: [catalogModel('grok-4.3', 300), catalogModel('grok-8', 200), catalogModel('grok-7', 100)] },
    });
    await favoriteModelsStorage.setValue({ xai: ['grok-8'] });
    const choices = await getModelChoicesFor('xai');
    expect(choices.groups).toEqual([
      { label: '★ Favorites', models: ['grok-8'] },
      { label: 'Latest (image-capable)', models: ['grok-4.3', 'grok-7'] },
    ]);
    expect(choices.favorites).toEqual(['grok-8']);
  });

  it('gives a configured model absent from every list its own leading "Current" group', async () => {
    await settingsStorage.setValue({
      ...DEFAULT_SETTINGS,
      providers: {
        ...DEFAULT_SETTINGS.providers,
        xai: { ...DEFAULT_SETTINGS.providers.xai, defaultModel: 'grok-custom-unlisted' },
      },
    });
    const choices = await getModelChoicesFor('xai');
    expect(choices.current).toBe('grok-custom-unlisted');
    expect(choices.groups[0]).toEqual({ label: 'Current', models: ['grok-custom-unlisted'] });
  });

  it('reports hasCatalog true only for xai/openrouter', async () => {
    expect((await getModelChoicesFor('xai')).hasCatalog).toBe(true);
    expect((await getModelChoicesFor('openrouter')).hasCatalog).toBe(true);
    expect((await getModelChoicesFor('custom')).hasCatalog).toBe(false);
  });
});

describe('getModelChoices', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('delegates to the active provider from settings', async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, activeProviderId: 'openrouter' });
    const choices = await getModelChoices();
    expect(choices.provider).toBe('openrouter');
    expect(choices.current).toBe(PROVIDER_DEFAULTS.openrouter.defaultModel);
  });
});

describe('setActiveModel', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("writes the active provider's defaultModel, leaving other providers untouched", async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, activeProviderId: 'xai' });
    await setActiveModel('grok-new');
    const settings = await settingsStorage.getValue();
    expect(settings.providers.xai.defaultModel).toBe('grok-new');
    expect(settings.providers.openrouter.defaultModel).toBe(PROVIDER_DEFAULTS.openrouter.defaultModel);
  });

  it('trims surrounding whitespace', async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, activeProviderId: 'xai' });
    await setActiveModel('  grok-trimmed  ');
    expect((await settingsStorage.getValue()).providers.xai.defaultModel).toBe('grok-trimmed');
  });

  it('ignores empty (or whitespace-only) input', async () => {
    await settingsStorage.setValue({
      ...DEFAULT_SETTINGS,
      activeProviderId: 'xai',
      providers: {
        ...DEFAULT_SETTINGS.providers,
        xai: { ...DEFAULT_SETTINGS.providers.xai, defaultModel: 'keep-me' },
      },
    });
    await setActiveModel('   ');
    expect((await settingsStorage.getValue()).providers.xai.defaultModel).toBe('keep-me');
  });
});

describe('toggleFavoriteModel', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('adds a model on first toggle, removes it on second, for the active provider', async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, activeProviderId: 'xai' });
    await toggleFavoriteModel('grok-fav');
    expect((await favoriteModelsStorage.getValue()).xai).toEqual(['grok-fav']);
    await toggleFavoriteModel('grok-fav');
    expect((await favoriteModelsStorage.getValue()).xai).toEqual([]);
  });

  it('scopes favorites per provider', async () => {
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, activeProviderId: 'xai' });
    await toggleFavoriteModel('grok-a');
    await settingsStorage.setValue({ ...DEFAULT_SETTINGS, activeProviderId: 'openrouter' });
    await toggleFavoriteModel('or-a');
    const favs = await favoriteModelsStorage.getValue();
    expect(favs.xai).toEqual(['grok-a']);
    expect(favs.openrouter).toEqual(['or-a']);
  });
});
