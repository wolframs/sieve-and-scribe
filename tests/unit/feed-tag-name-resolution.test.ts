import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

vi.mock('@/lib/feed-tag-rpc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/feed-tag-rpc')>('@/lib/feed-tag-rpc');
  return {
    ...actual,
    rpcGetFeedTagsByIds: vi.fn(),
    rpcUpsertFeedTags: vi.fn(),
  };
});

import { rememberTagNames, resolveTagNames } from '@/lib/civitai-feed-tags';
import { TagFilterWidget } from '@/entrypoints/civitai.content/feed-tag-filter';
import { rpcGetFeedTagsByIds, rpcUpsertFeedTags } from '@/lib/feed-tag-rpc';
import { feedTagNamesStorage } from '@/lib/storage';
import {
  clearFeedTags,
  getFeedTagsByIds,
  pruneFeedTagsUpdatedBefore,
  upsertFeedTags,
} from '@/lib/feed-tag-db';

const getByIds = vi.mocked(rpcGetFeedTagsByIds);
const upsert = vi.mocked(rpcUpsertFeedTags);

beforeEach(async () => {
  fakeBrowser.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  getByIds.mockReset();
  upsert.mockReset();
  upsert.mockResolvedValue(undefined);
  await feedTagNamesStorage.setValue({ v: 1, ts: 0, map: {}, order: [] });
});

describe('tag-name restoration', () => {
  it('resolves cache misses through CivitAI tag.getById and remembers the names', async () => {
    const ids = [377809, 317545, 420179, 417766, 470895, 521440];
    getByIds.mockResolvedValue([]);
    const names = new Map([
      [377809, 'variant,'],
      [317545, 'variant.'],
      [420179, "variant'"],
      [417766, 'variant_'],
      [470895, 'variant-'],
      [521440, 'variant;'],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (request: string) => {
      const input = new URL(request, 'https://civitai.com').searchParams.get('input')!;
      const id = JSON.parse(input).json.id as number;
      return new Response(JSON.stringify({ result: { data: { json: { id, name: names.get(id) } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    expect(await resolveTagNames(ids)).toEqual(names);
    expect(upsert).toHaveBeenCalledWith(expect.arrayContaining(
      ids.map((id) => ({ id, name: names.get(id)! }))
    ));
    expect((await feedTagNamesStorage.getValue()).map).toMatchObject(Object.fromEntries(names));
  });

  it('uses the recent-name cache even when the background worker is unavailable', async () => {
    getByIds.mockRejectedValue(new Error('background asleep'));
    await feedTagNamesStorage.setValue({
      v: 1,
      ts: 1,
      map: { 10: 'cached name' },
      order: [10],
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    expect(await resolveTagNames([10])).toEqual(new Map([[10, 'cached name']]));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not mistake a persisted numeric fallback for a resolved name', async () => {
    getByIds.mockResolvedValue([[10, '#10']]);
    await feedTagNamesStorage.setValue({ v: 1, ts: 1, map: { 10: '#10' }, order: [10] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: { data: { json: { id: 10, name: 'repaired name' } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    expect(await resolveTagNames([10])).toEqual(new Map([[10, 'repaired name']]));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retains newly seen names in fallback storage when IndexedDB RPC fails', async () => {
    upsert.mockRejectedValue(new Error('background asleep'));
    await expect(rememberTagNames([{ id: 99, name: 'long-tail tag' }])).resolves.toBeUndefined();
    expect((await feedTagNamesStorage.getValue()).map[99]).toBe('long-tail tag');
  });

  it('keeps rank-less long-tail names when a completed resync prunes stale rows', async () => {
    await clearFeedTags();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await upsertFeedTags([{ id: 1, name: 'ranked-stale' }], 0);
    await upsertFeedTags([{ id: 99, name: 'long-tail tag' }]); // live lookup, no sync rank
    clock.mockReturnValue(2_000_000);
    await upsertFeedTags([{ id: 2, name: 'ranked-fresh' }], 0);

    expect(await pruneFeedTagsUpdatedBefore(2_000_000)).toBe(1);
    expect(await getFeedTagsByIds([1, 2, 99])).toEqual(
      new Map([[2, 'ranked-fresh'], [99, 'long-tail tag']])
    );
    clock.mockRestore();
  });

  it('replaces numeric fallback chips in the mounted widget', async () => {
    getByIds.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn(async (request: string) => {
      const input = new URL(request, 'https://civitai.com').searchParams.get('input')!;
      const id = JSON.parse(input).json.id as number;
      return new Response(JSON.stringify({
        result: { data: { json: { id, name: `resolved-${id}` } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const widget = new TagFilterWidget({
      setTimeout: () => 1,
      setInterval: () => 1,
      signal: new AbortController().signal,
      onInvalidated: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ids = [377809, 317545, 420179, 417766, 470895, 521440];
    (widget as any).positiveGroups = [ids.map((id) => ({ id, name: `#${id}` }))];
    (widget as any).renderChips();
    (widget as any).resolveSelectedNames(ids);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const text = document.getElementById('cllp-tagfilter-host')!.shadowRoot!.querySelector('.chips')!.textContent!;
    ids.forEach((id) => expect(text).toContain(`resolved-${id}`));
    expect(text).not.toContain('#377809');
    widget.destroy();
  });
});
