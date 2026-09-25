import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCivitaiTool } from '@/lib/civitai-tools';

afterEach(() => vi.unstubAllGlobals());

function api(...responses: unknown[]) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(new URL(url));
    if (!responses.length) throw new Error('Unexpected extra lookup');
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }));
  return requests;
}

async function search(args: Record<string, unknown>) {
  return JSON.parse(await executeCivitaiTool('search_civitai_loras', JSON.stringify(args)));
}

const compatible = { id: 12, name: 'Dev style', baseModel: 'Flux.2 D', supportsGeneration: true,
  trainedWords: ['glass, dream'], images: [{ url: 'https://example.com/compatible.png' }] };

describe('compatible CivitAI catalog searches', () => {
  it('uses the active red origin and session for every request, including a bounded fallback', async () => {
    vi.stubGlobal('location', { origin: 'https://civitai.red' });
    const requests = api({ baseModel: 'Flux.2 D' }, { items: [] }, { items: [{ id: 1, modelVersions: [compatible] }] });
    const result = await search({ checkpointVersionId: 900, query: 'glass' });
    expect(requests).toHaveLength(3);
    expect(requests.every((url) => url.origin === 'https://civitai.red')).toBe(true);
    for (const url of requests.slice(1)) expect(url.searchParams.get('nsfw')).toBe('true');
    for (const [, init] of vi.mocked(fetch).mock.calls) expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
    expect(result.source).toMatchObject({ origin: 'https://civitai.red', nsfwRequested: true, tokenConfigured: false, browserSession: 'sent if present' });
    expect(result.results[0].url).toBe('https://civitai.red/models/1');
    expect(result.searchAttempts).toEqual([
      { keywordApplied: true, apiModelCount: 0, compatibleModelCount: 0 },
      { keywordApplied: false, apiModelCount: 1, compatibleModelCount: 1 },
    ]);
  });

  it.each([
    ['https://civitai.red', false, 'false'],
    ['https://civitai.com', undefined, 'false'],
    ['https://civitai.com', true, 'true'],
  ])('respects explicit content filters and never switches host (%s, %s)', async (origin, nsfw, expected) => {
    const requests = api({ items: [] });
    await executeCivitaiTool('search_civitai_loras', JSON.stringify({ nsfw }), undefined, undefined, origin);
    expect(requests[0].origin).toBe(origin);
    expect(requests[0].searchParams.get('nsfw')).toBe(expected);
  });

  it.each(['http://civitai.red', 'https://civitai.red.evil.example', 'https://civitai.red@evil.example', 'https://civitai.red:8443'])('rejects an untrusted origin before sending credentials (%s)', async (origin) => {
    const requests = api();
    const result = JSON.parse(await executeCivitaiTool('get_civitai_base_models', '{}', 'test-only-token', undefined, origin));
    expect(result.error).toContain('Unsupported');
    expect(requests).toHaveLength(0);
  });

  it('requests image metadata and does not diagnose missing credentials from missing metadata', async () => {
    const requests = api({ items: [{ url: 'https://image.civitai.com/example.png' }] });
    const result = JSON.parse(await executeCivitaiTool('mine_civitai_prompts', '{"modelVersionId":12}', 'test-only-token', undefined, 'https://civitai.red'));
    expect(requests[0].searchParams.get('withMeta')).toBe('true');
    expect(requests[0].searchParams.get('nsfw')).toBe('true');
    expect(result.source.tokenConfigured).toBe(true);
    expect(result.hint).toContain('does not establish a missing API token');
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer test-only-token' });
  });

  it('reports access errors with their source instead of falling back to another host', async () => {
    const fetchMock = vi.fn(async () => new Response('Access denied', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = JSON.parse(await executeCivitaiTool('search_civitai_loras', '{}', undefined, undefined, 'https://civitai.red'));
    expect(result).toMatchObject({ error: 'Civitai API 403: Access denied', source: { origin: 'https://civitai.red' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('resolves the checkpoint and selects an older compatible supported version with its own triggers', async () => {
    const requests = api({ baseModel: 'Flux.2 D' }, { items: [{ id: 1, name: 'Glass', modelVersions: [
      { id: 14, baseModel: 'Flux.2 Klein 9B', supportsGeneration: true, trainedWords: ['wrong'] },
      { id: 13, baseModel: 'Flux.2 D', supportsGeneration: false }, compatible,
    ] }] });
    const result = await search({ checkpointVersionId: 900, query: 'glass' });
    expect(requests[0].pathname).toBe('/api/v1/model-versions/900');
    expect(requests[1].searchParams.get('baseModels')).toBe('Flux.2 D');
    expect(requests[1].searchParams.get('supportsGeneration')).toBe('true');
    expect(result).toMatchObject({ baseModel: 'Flux.2 D', count: 1, keywordFallback: false });
    expect(result.results[0]).toMatchObject({ versionId: 12, latestVersionId: 14,
      supportsGeneration: true, triggerWords: ['glass', 'dream'],
      sampleImageUrls: ['https://example.com/compatible.png'] });
  });

  it('broadens keywords once while retaining exact compatibility and generation filters', async () => {
    const requests = api({ items: [] }, { items: [{ id: 1, modelVersions: [compatible] }] });
    const result = await search({ baseModel: 'Flux.2 D', query: 'surreal dream' });
    expect(requests).toHaveLength(2);
    expect(requests[0].searchParams.get('query')).toBe('surreal dream');
    expect(requests[1].searchParams.has('query')).toBe(false);
    for (const request of requests) {
      expect(request.searchParams.get('baseModels')).toBe('Flux.2 D');
      expect(request.searchParams.get('supportsGeneration')).toBe('true');
    }
    expect(result).toMatchObject({ count: 1, keywordFallback: true });
    expect(result.hint).toContain('do not claim they match');
  });

  it('does not treat parent support or a different base as a usable version', async () => {
    const requests = api({ items: [
      { id: 1, supportsGeneration: true, modelVersions: [{ id: 2, baseModel: 'Flux.2 D' }] },
      { id: 3, modelVersions: [{ ...compatible, baseModel: 'Flux.1 D' }] },
    ] });
    const result = await search({ baseModel: 'Flux.2 D' });
    expect(requests).toHaveLength(1);
    expect(result.count).toBe(0);
    expect(result.hint).toContain('not proof none exist');
  });

  it('stops after an empty fallback without claiming catalog-wide absence', async () => {
    const requests = api({ items: [] }, { items: [] });
    const result = await search({ baseModel: 'Flux.2 D', query: 'glass' });
    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ count: 0, keywordFallback: true });
    expect(result.hint).toContain('bounded search');
  });

  it('rejects conflicting checkpoint metadata before searching', async () => {
    const requests = api({ baseModel: 'Flux.2 Klein 4B' });
    const result = await search({ checkpointVersionId: 900, baseModel: 'Flux.2 D' });
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ error: expect.stringContaining('differs'), checkpointBaseModel: 'Flux.2 Klein 4B' });
  });

  it('permits unsupported versions only for explicit download research', async () => {
    const requests = api({ items: [{ id: 1, modelVersions: [{ ...compatible, supportsGeneration: false }] }] });
    const result = await search({ baseModel: 'Flux.2 D', supportsGeneration: false });
    expect(requests[0].searchParams.has('supportsGeneration')).toBe(false);
    expect(result.results[0].supportsGeneration).toBe(false);
  });

  it('loads current base identifiers rather than maintaining a static family list', async () => {
    api({ BaseModel: ['Flux.2 D', 'Flux.2 Future Variant', 'SD 1.5', null] });
    const result = JSON.parse(await executeCivitaiTool('get_civitai_base_models', '{"query":"flux.2"}'));
    expect(result.baseModels).toEqual(['Flux.2 D', 'Flux.2 Future Variant']);
  });

  it('reports API failures without treating them as empty search results', async () => {
    const fetchMock = vi.fn(async () => new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await search({ baseModel: 'Flux.2 D', query: 'glass' })).toMatchObject({ error: 'Civitai API 503: Unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
