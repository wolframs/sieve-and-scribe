import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchFeedResources } from '@/lib/feed-resources';

afterEach(() => vi.restoreAllMocks());

describe('feed resource selection lookup', () => {
  it('does not fetch until the user supplies a meaningful query', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await searchFeedResources(' ')).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flattens selected model versions into bounded ID and label snapshots', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      items: [
        {
          name: 'Flux Detail', type: 'LORA',
          modelVersions: [{ id: 101, name: 'v2' }, { id: 100, name: 'v1' }],
        },
        {
          name: 'Dream Checkpoint', type: 'Checkpoint',
          modelVersions: [{ id: 201, name: 'Final' }, { id: 101, name: 'duplicate' }],
        },
      ],
    })));

    const results = await searchFeedResources('flux', undefined, 3);
    expect(results).toEqual([
      { versionId: 101, label: 'Flux Detail — v2 (LORA)' },
      { versionId: 100, label: 'Flux Detail — v1 (LORA)' },
      { versionId: 201, label: 'Dream Checkpoint — Final (Checkpoint)' },
    ]);
    const url = new URL((globalThis.fetch as any).mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/models');
    expect(url.searchParams.get('query')).toBe('flux');
  });
});
