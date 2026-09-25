import { describe, expect, it } from 'vitest';
import {
  feedFacetCount,
  feedFacetSummary,
  matchesFeedFacets,
  normalizeFeedFacetFilter,
  parseFeedFacetsFromSearch,
  sameFeedFacets,
  writeFeedFacetsToUrl,
} from '@/lib/feed-facets';
import { buildHrefWithTagFilter, parseTagBundlesFromSearch } from '@/lib/civitai-feed-tags';

describe('feed facets', () => {
  it('normalizes, writes, and parses a stable explicit URL representation', () => {
    const facets = normalizeFeedFacetFilter({
      creatorsInclude: [' @Alice ', 'alice', 'BOB'],
      creatorsExclude: ['Spammer'],
      orientations: ['portrait', 'square', 'portrait', 'wide' as any],
      primaryModel: { versionId: 501, label: 'Flux Checkpoint v1' },
      resourcesInclude: [
        { versionId: 601, label: 'Rain LoRA — v2' },
        { versionId: 601, label: 'duplicate' },
      ],
      resourcesExclude: [{ versionId: 701, label: 'Bad Hands' }],
      minReactions: 100.8,
      minViews: 0,
      hasMeta: true,
      onSite: false,
    });
    const url = writeFeedFacetsToUrl(new URL('https://civitai.com/images?period=Week'), facets);

    expect(url.searchParams.getAll('ffcreator')).toEqual(['alice', 'bob']);
    expect(parseFeedFacetsFromSearch(url.search)).toEqual(facets);
    expect(facets).toEqual({
      creatorsInclude: ['alice', 'bob'],
      creatorsExclude: ['spammer'],
      orientations: ['portrait', 'square'],
      primaryModel: { versionId: 501, label: 'Flux Checkpoint v1' },
      resourcesInclude: [{ versionId: 601, label: 'Rain LoRA — v2' }],
      resourcesExclude: [{ versionId: 701, label: 'Bad Hands' }],
      minReactions: 100,
      hasMeta: true,
    });
  });

  it('matches creators, orientation, totals, and provenance from current feed items', () => {
    const item = {
      user: { username: 'Alice' },
      width: 832,
      height: 1216,
      hasMeta: true,
      onSite: true,
      modelVersionId: 501,
      modelVersionIds: [501, 601],
      stats: {
        likeCountAllTime: 80,
        heartCountAllTime: 30,
        laughCountAllTime: 4,
        cryCountAllTime: 1,
        dislikeCountAllTime: 0,
        viewCountAllTime: 2000,
        commentCountAllTime: 12,
        collectedCountAllTime: 20,
      },
    };
    const facets = {
      creatorsInclude: ['alice'],
      creatorsExclude: [],
      orientations: ['portrait' as const],
      minReactions: 100,
      minViews: 1500,
      minComments: 10,
      minCollections: 15,
      hasMeta: true,
      onSite: true,
      primaryModel: { versionId: 501, label: 'Flux Checkpoint' },
      resourcesInclude: [{ versionId: 601, label: 'Rain LoRA' }],
      resourcesExclude: [{ versionId: 701, label: 'Bad Hands' }],
    };

    expect(matchesFeedFacets(item, facets)).toBe(true);
    expect(matchesFeedFacets(item, { ...facets, creatorsExclude: ['alice'] })).toBe(false);
    expect(matchesFeedFacets(item, { ...facets, orientations: ['landscape'] })).toBe(false);
    expect(matchesFeedFacets(item, { ...facets, minReactions: 116 })).toBe(false);
    expect(matchesFeedFacets(item, { ...facets, primaryModel: { versionId: 999, label: 'Other' } })).toBe(false);
    expect(matchesFeedFacets(item, { ...facets, resourcesInclude: [{ versionId: 999, label: 'Missing' }] })).toBe(false);
    expect(matchesFeedFacets(item, { ...facets, resourcesExclude: [{ versionId: 601, label: 'Rain LoRA' }] })).toBe(false);
    expect(matchesFeedFacets({ ...item, stats: {} }, { minViews: 1 })).toBe(false);
  });

  it('round-trips resource label snapshots alongside version IDs', () => {
    const source = {
      primaryModel: { versionId: 501, label: 'Dream Model — v3' },
      resourcesInclude: [{ versionId: 601, label: 'Rain Style — v2' }],
      resourcesExclude: [{ versionId: 701, label: 'Artifact Helper — old' }],
    };
    const url = writeFeedFacetsToUrl(new URL('https://civitai.com/images'), source);
    expect(url.searchParams.get('ffprimarymodel')).toContain('501|Dream Model');
    expect(parseFeedFacetsFromSearch(url.search)).toMatchObject(source);
  });

  it('summarizes and compares normalized state', () => {
    const facets = {
      creatorsInclude: ['alice', 'bob'],
      orientations: ['portrait' as const],
      minReactions: 100,
      hasMeta: true,
    };
    expect(feedFacetCount(facets)).toBe(5);
    expect(feedFacetSummary(facets)).toBe('Portrait · ≥100 reactions · 2 creators · Has generation data');
    expect(sameFeedFacets(facets, { ...facets, creatorsInclude: ['alice', 'bob', 'alice'] })).toBe(true);
  });

  it('composes facets with tag groups while preserving ordinary feed parameters', () => {
    const href = buildHrefWithTagFilter(
      'https://civitai.com/images?period=Week&ffcreator=stale',
      [[10, 11], [12]],
      [13],
      'all',
      { orientations: ['landscape'], minViews: 500 },
      [{ seedId: 10, tagIds: [10, 11, 999] }]
    );
    const url = new URL(href);
    expect(url.searchParams.getAll('tags')).toEqual(['10', '11', '12']);
    expect(url.searchParams.getAll('taggroups')).toEqual(['10,11', '12']);
    expect(url.searchParams.get('tagmode')).toBe('all');
    expect(url.searchParams.get('tagneg')).toBe('13');
    expect(url.searchParams.get('tagbundles')).toBe('10:10,11');
    expect(parseTagBundlesFromSearch(url.search)).toEqual([
      { seedId: 10, tagIds: [10, 11] },
    ]);
    expect(url.searchParams.get('period')).toBe('Week');
    expect(url.searchParams.getAll('ffcreator')).toEqual([]);
    expect(parseFeedFacetsFromSearch(url.search)).toMatchObject({
      orientations: ['landscape'],
      minViews: 500,
    });
  });
});
