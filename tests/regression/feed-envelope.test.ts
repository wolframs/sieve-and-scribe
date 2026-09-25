import { parse as parseDevalue, stringify as stringifyDevalue } from 'devalue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeBody,
  decodeFeedEnvelope,
  encodeFeedEnvelope,
  installAndInterceptor,
} from '@/entrypoints/civitai-and.content';

afterEach(() => {
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('CivitAI feed response envelopes', () => {
  it('decodes, mutates, and re-encodes the current devalue string transport', () => {
    const sharedUser = { id: 7, username: 'shared-author' };
    const node = {
      nextCursor: '100|1784960782287',
      items: [
        {
          id: 101,
          tagIds: [10, 20],
          publishedAt: new Date('2026-07-28T12:00:00.000Z'),
          user: sharedUser,
        },
        { id: 102, tagIds: [10], publishedAt: null, user: sharedUser },
      ],
      source: 9073,
    };
    const body = { result: { data: stringifyDevalue(node) } };

    const envelope = decodeFeedEnvelope(body, false);
    expect(envelope?.transport).toBe('devalue');
    expect(envelope?.node.items).toHaveLength(2);
    expect(envelope?.node.items[0].publishedAt).toBeInstanceOf(Date);
    expect(envelope?.node.items[0].user).toBe(envelope?.node.items[1].user);

    // Model the interceptor replacing/reordering items after its cursor walk.
    envelope!.node.items = [envelope!.node.items[1], envelope!.node.items[0]];
    envelope!.node.nextCursor = null;
    const encoded = encodeFeedEnvelope(body, envelope!);
    const outer = JSON.parse(encoded);

    expect(typeof outer.result.data).toBe('string');
    const revived = parseDevalue(outer.result.data);
    expect(revived.items.map((item: any) => item.id)).toEqual([102, 101]);
    expect(revived.nextCursor).toBeNull();
    expect(revived.items[1].publishedAt).toEqual(new Date('2026-07-28T12:00:00.000Z'));
    expect(revived.items[0].user).toBe(revived.items[1].user);
  });

  it('keeps supporting the older batched SuperJSON-shaped transport', () => {
    const body = [
      {
        result: {
          data: {
            json: { nextCursor: 'old-cursor', items: [{ id: 201, tagIds: [30] }] },
            meta: { values: { nextCursor: ['undefined'] } },
          },
        },
      },
    ];

    const envelope = decodeFeedEnvelope(body, true);
    expect(envelope?.transport).toBe('superjson');
    expect(envelope?.node.items[0].id).toBe(201);

    envelope!.node.items = [];
    envelope!.node.nextCursor = null;
    const encoded = JSON.parse(encodeFeedEnvelope(body, envelope!));

    expect(encoded[0].result.data.json).toEqual({ nextCursor: null, items: [] });
    expect(encoded[0].result.data.meta).toEqual({
      values: { nextCursor: ['undefined'] },
    });
  });

  it('rejects an unrecognized serialized payload instead of fabricating a feed page', () => {
    const body = { result: { data: '{"not":"devalue-flattened"}' } };
    expect(decodeFeedEnvelope(body, false)).toBeNull();
  });

  it('walks native cursors to top up a facet-only feed and returns only matches', async () => {
    window.history.replaceState({}, '', '/images?fforientation=portrait&ffminreactions=10');
    const page = (items: any[], nextCursor: string | null) => ({
      result: { data: stringifyDevalue({ items, nextCursor }) },
    });
    const originalFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page([
        { id: 1, width: 1200, height: 800, reactionCount: 50 },
        { id: 2, width: 800, height: 1200, reactionCount: 12 },
      ], 'next'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(page([
        { id: 3, width: 700, height: 1100, reactionCount: 20 },
        { id: 4, width: 700, height: 1100, reactionCount: 2 },
      ], null))));
    const input = encodeURIComponent(JSON.stringify({ json: { limit: 100 } }));
    const body = await computeBody(
      originalFetch as unknown as typeof fetch,
      new URL(`https://civitai.com/api/trpc/image.getInfinite?input=${input}`)
    );

    expect(originalFetch).toHaveBeenCalledTimes(2);
    const decoded = parseDevalue(JSON.parse(body!).result.data);
    expect(decoded.items.map((item: any) => item.id)).toEqual([2, 3]);
    expect(decoded.nextCursor).toBeNull();
    const secondUrl = new URL(originalFetch.mock.calls[1][0]);
    const secondInput = JSON.parse(secondUrl.searchParams.get('input')!);
    expect(secondInput.json.cursor).toBe('next');
  });

  it('treats an empty driver page as an empty AND result, not as a fallback', async () => {
    // Rare tag pairs on /videos routinely return zero items for the first probe page; that
    // used to be misreported as "feed items carry no tagIds" and dropped to native OR.
    window.history.replaceState({}, '', '/videos?tags=1&tags=2&tagmode=all');
    const health = vi.fn();
    window.addEventListener('cllp:sitehealth', health);
    const originalFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { data: stringifyDevalue({ items: [], nextCursor: null }) },
    })));
    const input = encodeURIComponent(JSON.stringify({ json: { limit: 100, tags: [1, 2] } }));

    const body = await computeBody(
      originalFetch as unknown as typeof fetch,
      new URL(`https://civitai.com/api/trpc/image.getInfinite?input=${input}`)
    );

    expect(body).not.toBeNull();
    expect(parseDevalue(JSON.parse(body!).result.data).items).toEqual([]);
    expect(health).not.toHaveBeenCalled();
    window.removeEventListener('cllp:sitehealth', health);
  });

  it('unions one-tag feeds across pages without repeating shared images', async () => {
    window.history.replaceState({}, '', '/images?tags=1&tags=2&tagmode=any&tagneg=9');
    const page = (items: any[], nextCursor: string | null) => ({
      result: { data: stringifyDevalue({ items, nextCursor }) },
    });
    const requested: Array<{ tags: number[]; cursor?: string }> = [];
    const originalFetch = vi.fn(async (href: string) => {
      const input = JSON.parse(new URL(href).searchParams.get('input')!);
      const { tags, cursor } = input.json;
      requested.push({ tags, cursor });
      const tag = tags[0];
      const result = tag === 1
        ? cursor
          ? page([{ id: 13, tagIds: [1] }], null)
          : page([{ id: 11, tagIds: [1, 2] }, { id: 12, tagIds: [1] }], 'one-more')
        : cursor
          ? page([{ id: 12, tagIds: [1, 2] }, { id: 22, tagIds: [2] }], null)
          : page([{ id: 11, tagIds: [1, 2] }, { id: 21, tagIds: [2, 9] }], 'two-more');
      return new Response(JSON.stringify(result));
    });
    const requestUrl = (cursor?: string) => new URL(
      `https://civitai.com/api/trpc/image.getInfinite?input=${encodeURIComponent(JSON.stringify({
        json: { tags: [1, 2], period: 'Week', sort: 'Most Reactions', ...(cursor ? { cursor } : {}) },
      }))}`
    );

    const first = parseDevalue(JSON.parse((await computeBody(originalFetch as typeof fetch, requestUrl()))!).result.data);
    const second = parseDevalue(JSON.parse((await computeBody(originalFetch as typeof fetch, requestUrl(first.nextCursor)))!).result.data);

    expect(first.items.map((item: any) => item.id)).toEqual([11, 12]);
    expect(first.nextCursor).toMatch(/^cllp-union-v1:/);
    expect(second.items.map((item: any) => item.id)).toEqual([13, 22]);
    expect(second.nextCursor).toBeNull();
    expect(requested).toEqual([
      { tags: [1], cursor: undefined }, { tags: [2], cursor: undefined },
      { tags: [1], cursor: 'one-more' }, { tags: [2], cursor: 'two-more' },
    ]);
  });

  it('unions tags within one group even when the mode is all', async () => {
    window.history.replaceState({}, '', '/images?tags=1&tags=2&taggroups=1,2&tagmode=all');
    const originalFetch = vi.fn(async (href: string) => {
      const tags = JSON.parse(new URL(href).searchParams.get('input')!).json.tags;
      return new Response(JSON.stringify({ result: { data: stringifyDevalue({
        items: tags[0] === 1 ? [{ id: 1, tagIds: [1] }] : [{ id: 2, tagIds: [2] }],
        nextCursor: null,
      }) } }));
    });
    const input = encodeURIComponent(JSON.stringify({ json: { tags: [1, 2] } }));
    const body = await computeBody(originalFetch as typeof fetch,
      new URL(`https://civitai.com/api/trpc/image.getInfinite?input=${input}`));

    expect(parseDevalue(JSON.parse(body!).result.data).items.map((item: any) => item.id)).toEqual([1, 2]);
    expect(originalFetch).toHaveBeenCalledTimes(2);
  });

  it('restores stripped markers before the first feed request on a cold load', async () => {
    localStorage.setItem('cllp:feed-filter-stash', JSON.stringify({
      v: 1, groups: [[1], [2]], negatives: [], mode: 'all', bundles: [], facets: null,
    }));
    window.history.replaceState({}, '', '/images?tags=1&tags=2');
    const originalFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { data: stringifyDevalue({ items: [{ id: 1, tagIds: [1, 2] }, { id: 2, tagIds: [1] }], nextCursor: null }) },
    })));
    window.fetch = originalFetch as unknown as typeof fetch;
    installAndInterceptor();
    const input = encodeURIComponent(JSON.stringify({ json: { limit: 100, tags: [1, 2] } }));

    const response = await window.fetch(`https://civitai.com/api/trpc/image.getInfinite?input=${input}`);

    expect(new URLSearchParams(location.search).get('tagmode')).toBe('all');
    const decoded = parseDevalue(JSON.parse(await response.text()).result.data);
    expect(decoded.items.map((item: any) => item.id)).toEqual([1]);
    localStorage.clear();
  });

  it('passes through instead of silently ignoring negatives when items carry no tagIds', async () => {
    window.history.replaceState({}, '', '/images?tagneg=5');
    const health = vi.fn();
    window.addEventListener('cllp:sitehealth', health);
    const originalFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { data: stringifyDevalue({ items: [{ id: 1 }, { id: 2 }], nextCursor: 'next' }) },
    })));
    const input = encodeURIComponent(JSON.stringify({ json: { limit: 100 } }));

    const body = await computeBody(
      originalFetch as unknown as typeof fetch,
      new URL(`https://civitai.com/api/trpc/image.getInfinite?input=${input}`)
    );

    expect(body).toBeNull();
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((health.mock.calls[0][0] as CustomEvent).detail).key)
      .toBe('and-or-fallback:feed items carry no tagIds');
    window.removeEventListener('cllp:sitehealth', health);
  });
});
