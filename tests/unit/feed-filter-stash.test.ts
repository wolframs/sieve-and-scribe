import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  FEED_FILTER_STASH_KEY,
  buildHrefWithTagFilter,
  readFeedFilterStash,
  restoreStrippedFeedFilterHref,
  restoreStrippedFeedFilterInPlace,
  writeFeedFilterStash,
} from '@/lib/feed-filter-url';
import { FEED_FACET_PARAMS } from '@/lib/feed-facets';
import { TagFilterWidget } from '@/entrypoints/civitai.content/feed-tag-filter';

const stash = {
  groups: [[1, 2], [3]],
  negatives: [9],
  mode: 'all' as const,
  bundles: [],
  facets: { minReactions: 10 },
};

beforeEach(() => {
  fakeBrowser.reset();
  localStorage.clear();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});
afterEach(() => vi.restoreAllMocks());

describe('stripped feed-filter restoration', () => {
  it('round-trips the stash through localStorage', () => {
    writeFeedFilterStash(localStorage, stash);
    expect(readFeedFilterStash(localStorage)).toEqual({ v: 1, ...stash });
    localStorage.setItem(FEED_FILTER_STASH_KEY, '{not json');
    expect(readFeedFilterStash(localStorage)).toBeNull();
  });

  it('restores every marker when only the same tags survived a site navigation', () => {
    const restored = restoreStrippedFeedFilterHref(
      'https://civitai.com/videos?tags=3&tags=1&tags=2&period=Month',
      { v: 1, ...stash },
      FEED_FACET_PARAMS
    );
    const sp = new URLSearchParams(new URL(restored!).search);
    expect(sp.get('period')).toBe('Month');
    expect(sp.get('tagmode')).toBe('all');
    expect(sp.getAll('taggroups')).toEqual(['1,2', '3']);
    expect(sp.getAll('tagneg')).toEqual(['9']);
    expect(sp.get('ffminreactions')).toBe('10');
  });

  it('leaves URLs alone when the tag set changed or markers exist, and upgrades legacy Any links', () => {
    const s = { v: 1 as const, ...stash };
    expect(restoreStrippedFeedFilterHref('https://civitai.com/images?tags=1&tags=2', s, FEED_FACET_PARAMS)).toBeNull();
    expect(restoreStrippedFeedFilterHref('https://civitai.com/images?tags=1&tags=2&tags=3&tags=4', s, FEED_FACET_PARAMS)).toBeNull();
    expect(restoreStrippedFeedFilterHref('https://civitai.com/images?tags=1&tags=2&tags=3&tagmode=all', s, FEED_FACET_PARAMS)).toBeNull();
    expect(restoreStrippedFeedFilterHref('https://civitai.com/images/123?tags=1&tags=2&tags=3', s, FEED_FACET_PARAMS)).toBeNull();
    expect(restoreStrippedFeedFilterHref('https://civitai.com/images', s, FEED_FACET_PARAMS)).toBeNull();
    // Old Any links had no marker; restore one so they retain union semantics.
    const plain = { v: 1 as const, groups: [[1], [2], [3]], negatives: [], mode: 'any' as const, bundles: [], facets: null };
    expect(new URL(restoreStrippedFeedFilterHref('https://civitai.com/images?tags=1&tags=2&tags=3', plain, FEED_FACET_PARAMS)!).searchParams.get('tagmode')).toBe('any');
  });

  it('replaces history in place and refreshes Next.js-style state URLs', () => {
    writeFeedFilterStash(localStorage, stash);
    window.history.replaceState({ as: '/videos?tags=1&tags=2&tags=3', url: '/videos?tags=1&tags=2&tags=3', __N: true }, '', '/videos?tags=1&tags=2&tags=3');
    const restored = restoreStrippedFeedFilterInPlace(window, FEED_FACET_PARAMS);
    expect(restored).toBe(buildHrefWithTagFilter('http://localhost:3000/videos?tags=1&tags=2&tags=3', stash.groups, stash.negatives, 'all', stash.facets, []));
    expect(location.search).toContain('tagmode=all');
    expect(window.history.state.as).toBe(`${location.pathname}${location.search}`);
    expect(window.history.state.__N).toBe(true);
    expect(restoreStrippedFeedFilterInPlace(window, FEED_FACET_PARAMS)).toBeNull();
  });

  it('the widget restores a stripped feed URL instead of warning about it', async () => {
    writeFeedFilterStash(localStorage, stash);
    window.history.replaceState({}, '', '/videos?tags=1&tags=2&tags=3&period=Week');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline')); // no live name lookups
    const widget = new TagFilterWidget({
      setTimeout: () => 1, setInterval: () => 1, signal: new AbortController().signal, onInvalidated: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    widget.refreshFromUrl();

    expect(new URLSearchParams(location.search).get('tagmode')).toBe('all');
    expect((widget as any).positiveGroups.map((g: { id: number }[]) => g.map((t) => t.id))).toEqual([[1, 2], [3]]);
    expect((widget as any).excluded.map((t: { id: number }) => t.id)).toEqual([9]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('dropped the tag-filter markers'))).toBe(false);
    widget.destroy();
  });
});

describe('stripped-marker warning scope', () => {
  const makeWidget = () => new TagFilterWidget({
    setTimeout: () => 1, setInterval: () => 1, signal: new AbortController().signal, onInvalidated: () => {},
  });
  const stripped = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.some((call) => String(call[0]).includes('dropped the tag-filter markers'));

  it('warns only when the same tags lose their markers without a matching stash', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.history.replaceState({}, '', '/images?tags=1&tags=2&tagneg=9&tagmode=all');
    const widget = makeWidget();
    await new Promise((resolve) => setTimeout(resolve, 0));
    widget.refreshFromUrl();

    // Site chip replaced the tag set: a new filter, no warning.
    window.history.replaceState({}, '', '/images?tags=5');
    widget.refreshFromUrl();
    expect(stripped(warn)).toBe(false);

    // Same tags, markers gone, nothing to restore from: warn.
    window.history.replaceState({}, '', '/images?tags=1&tags=2&tagneg=9&tagmode=all');
    widget.refreshFromUrl();
    localStorage.clear(); // the stash would otherwise repair it silently (covered above)
    window.history.replaceState({}, '', '/images?tags=1&tags=2');
    widget.refreshFromUrl();
    expect(stripped(warn)).toBe(true);
    widget.destroy();
  });

  it('does not accept a stripped Any filter as the new applied state', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.history.replaceState({}, '', '/images?tags=1&tags=2&tagmode=any');
    const widget = makeWidget();
    await new Promise((resolve) => setTimeout(resolve, 0));
    widget.refreshFromUrl();

    localStorage.clear();
    window.history.replaceState({}, '', '/images?tags=1&tags=2');
    widget.refreshFromUrl();

    // Site-health reports only once per page, so check that the degraded URL did not
    // replace the saved applied filter rather than relying on another console warning.
    expect(readFeedFilterStash(localStorage)).toBeNull();
    widget.destroy();
  });
});
