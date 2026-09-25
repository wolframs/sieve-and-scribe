// Regression coverage for lib/model-catalog.ts: the OpenRouter/xAI live-catalog
// parsers, the curated-picker-list rules, and refreshModelCatalog's cache
// safety net. Fetches go through lib/llm-proxy's llmFetchText, which is
// mocked here so no network call ever happens.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { llmFetchText } from '@/lib/llm-proxy';
import {
  refreshModelCatalog,
  curatedModels,
  modelCatalogStorage,
  type CatalogModel,
} from '@/lib/model-catalog';
import { settingsStorage } from '@/lib/storage';
import { DEFAULT_SETTINGS } from '@/lib/constants';

vi.mock('@/lib/llm-proxy');

const fetchMock = vi.mocked(llmFetchText);

function okResponse(body: unknown) {
  return { ok: true, status: 200, bodyText: JSON.stringify(body) };
}

function catalogModel(
  id: string,
  vendor: string,
  created: number,
  supportsTools = true
): CatalogModel {
  return { id, vendor, created, supportsTools };
}

async function withXaiApiKey() {
  await settingsStorage.setValue({
    ...DEFAULT_SETTINGS,
    providers: {
      ...DEFAULT_SETTINGS.providers,
      xai: { ...DEFAULT_SETTINGS.providers.xai, apiKey: 'fake-xai-key' },
    },
  });
}

beforeEach(() => {
  fakeBrowser.reset();
  fetchMock.mockReset();
});

describe('refreshModelCatalog: OpenRouter parsing', () => {
  it('filters to image-input + text-output models, dropping text-only and image-output-only entries', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        data: [
          {
            id: 'openai/gpt-5-vision',
            created: 300,
            architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] },
            supported_parameters: ['tools'],
          },
          {
            id: 'openai/gpt-5-text-only',
            created: 250,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['tools'],
          },
          {
            id: 'anthropic/image-in-image-out',
            created: 200,
            architecture: { input_modalities: ['image', 'text'], output_modalities: ['image'] },
            supported_parameters: ['tools'],
          },
        ],
      })
    );
    const changed = await refreshModelCatalog('openrouter', true);
    expect(changed).toBe(true);
    const all = await modelCatalogStorage.getValue();
    expect(all.openrouter.models.map((m) => m.id)).toEqual(['openai/gpt-5-vision']);
  });

  it("drops vendor-less ids and openrouter's own pseudo-ids (the 'openrouter/auto-beta' leak)", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        data: [
          {
            id: 'openai/gpt-5-vision',
            created: 300,
            architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] },
            supported_parameters: ['tools'],
          },
          {
            id: 'openrouter/auto-beta',
            created: 400,
            architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] },
            supported_parameters: ['tools'],
          },
          {
            id: 'no-vendor-id',
            created: 400,
            architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] },
            supported_parameters: ['tools'],
          },
        ],
      })
    );
    const changed = await refreshModelCatalog('openrouter', true);
    expect(changed).toBe(true);
    const all = await modelCatalogStorage.getValue();
    expect(all.openrouter.models.map((m) => m.id)).toEqual(['openai/gpt-5-vision']);
  });
});

describe('refreshModelCatalog: xAI parsing', () => {
  it('filters to image-input models only', async () => {
    await withXaiApiKey();
    fetchMock.mockResolvedValue(
      okResponse({
        models: [
          { id: 'grok-4-1212', created: 100, input_modalities: ['image', 'text'], aliases: ['grok-4'] },
          { id: 'grok-3-text-only', created: 90, input_modalities: ['text'], aliases: [] },
        ],
      })
    );
    const changed = await refreshModelCatalog('xai', true);
    expect(changed).toBe(true);
    const all = await modelCatalogStorage.getValue();
    expect(all.xai.models.map((m) => m.id)).toEqual(['grok-4']);
  });

  it("picks the shortest non-'-latest' alias as the friendly id", async () => {
    await withXaiApiKey();
    fetchMock.mockResolvedValue(
      okResponse({
        models: [
          {
            id: 'grok-4-1212-reasoning',
            created: 100,
            input_modalities: ['image'],
            aliases: ['grok-4-latest', 'grok-4'],
          },
        ],
      })
    );
    const changed = await refreshModelCatalog('xai', true);
    expect(changed).toBe(true);
    const all = await modelCatalogStorage.getValue();
    // Neither the dated internal id nor the moving "-latest" alias should win.
    expect(all.xai.models.map((m) => m.id)).toEqual(['grok-4']);
  });

  it('dedupes entries that resolve to the same friendly id', async () => {
    await withXaiApiKey();
    fetchMock.mockResolvedValue(
      okResponse({
        models: [
          { id: 'grok-4-1212', created: 100, input_modalities: ['image'], aliases: ['grok-4'] },
          { id: 'grok-4-0620', created: 90, input_modalities: ['image'], aliases: ['grok-4'] },
        ],
      })
    );
    const changed = await refreshModelCatalog('xai', true);
    expect(changed).toBe(true);
    const all = await modelCatalogStorage.getValue();
    expect(all.xai.models).toHaveLength(1);
    expect(all.xai.models[0].id).toBe('grok-4');
  });
});

describe('curatedModels', () => {
  it('caps OpenRouter at 3 models per vendor, newest first', () => {
    const models = [500, 400, 300, 200, 100].map((created, i) =>
      catalogModel(`openai/model-${i}`, 'openai', created)
    );
    const curated = curatedModels('openrouter', models);
    expect(curated.map((m) => m.created)).toEqual([500, 400, 300]);
  });

  it('orders vendor blocks by each vendor block newest release, newest vendor first', () => {
    const models = [
      catalogModel('openai/old-1', 'openai', 1000),
      catalogModel('openai/old-2', 'openai', 900),
      catalogModel('anthropic/new-1', 'anthropic', 2000),
      catalogModel('anthropic/new-2', 'anthropic', 1900),
    ];
    const curated = curatedModels('openrouter', models);
    // anthropic's newest release (2000) beats openai's newest (1000), so its
    // whole block sorts first even though openai has an older-but-present model.
    expect(curated.map((m) => m.id)).toEqual([
      'anthropic/new-1',
      'anthropic/new-2',
      'openai/old-1',
      'openai/old-2',
    ]);
  });

  it('drops non-tool-capable models for openrouter, but leaves xai models untouched', () => {
    const models = [
      catalogModel('openai/no-tools', 'openai', 100, false),
      catalogModel('openai/has-tools', 'openai', 200, true),
    ];
    expect(curatedModels('openrouter', models).map((m) => m.id)).toEqual(['openai/has-tools']);

    const xaiModels = [catalogModel('grok-no-tools', 'xai', 100, false)];
    // xai's branch never applies the supportsTools filter (it returns the sorted list as-is).
    expect(curatedModels('xai', xaiModels).map((m) => m.id)).toEqual(['grok-no-tools']);
  });
});

describe('refreshModelCatalog: cache safety', () => {
  it('keeps the stale cache when the fetch throws', async () => {
    const staleEntry = { ts: Date.now() - 1000, models: [catalogModel('openai/old', 'openai', 1)] };
    await modelCatalogStorage.setValue({ openrouter: staleEntry });
    fetchMock.mockRejectedValue(new Error('network down'));

    const changed = await refreshModelCatalog('openrouter', true);

    expect(changed).toBe(false);
    const all = await modelCatalogStorage.getValue();
    expect(all.openrouter).toEqual(staleEntry);
  });

  it('returns false and keeps the prior cache on an empty parse (schema drift)', async () => {
    const staleEntry = { ts: Date.now() - 1000, models: [catalogModel('openai/old', 'openai', 1)] };
    await modelCatalogStorage.setValue({ openrouter: staleEntry });
    // Well-formed response, but nothing survives the image+text filter.
    fetchMock.mockResolvedValue(
      okResponse({
        data: [
          {
            id: 'openai/text-only',
            created: 999,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['tools'],
          },
        ],
      })
    );

    const changed = await refreshModelCatalog('openrouter', true);

    expect(changed).toBe(false);
    const all = await modelCatalogStorage.getValue();
    expect(all.openrouter).toEqual(staleEntry);
  });

  it('skips the fetch when the cache is within the TTL and force is not set', async () => {
    await withXaiApiKey();
    await modelCatalogStorage.setValue({
      xai: { ts: Date.now(), models: [catalogModel('grok-cached', 'xai', 1)] },
    });

    const changed = await refreshModelCatalog('xai');

    expect(changed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches within the TTL when force is true', async () => {
    await withXaiApiKey();
    await modelCatalogStorage.setValue({
      xai: { ts: Date.now(), models: [catalogModel('grok-cached', 'xai', 1)] },
    });
    fetchMock.mockResolvedValue(
      okResponse({
        models: [{ id: 'grok-fresh', created: 2, input_modalities: ['image'], aliases: [] }],
      })
    );

    const changed = await refreshModelCatalog('xai', true);

    expect(changed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const all = await modelCatalogStorage.getValue();
    expect(all.xai.models.map((m) => m.id)).toEqual(['grok-fresh']);
  });
});
