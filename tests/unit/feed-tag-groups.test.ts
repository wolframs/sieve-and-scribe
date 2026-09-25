import { describe, expect, it } from 'vitest';
import {
  buildHrefWithTagFilter,
  findFeedTagHealthIssues,
  mergeFeedTagGroups,
  moveFeedTagBetweenGroups,
  parseTagGroupsFromSearch,
  type FeedTag,
} from '@/lib/civitai-feed-tags';

const tag = (id: number): FeedTag => ({ id, name: `tag-${id}` });

describe('findFeedTagHealthIssues', () => {
  it('reports unresolved IDs, duplicate names, and punctuation noise', () => {
    expect(findFeedTagHealthIssues([
      { id: 1, name: '#1' },
      { id: 2, name: 'clothing' },
      { id: 3, name: 'Clothing' },
      { id: 4, name: 'lingerie,' },
      { id: 5, name: 'yu-gi-oh!' },
    ])).toEqual([
      { id: 1, kind: 'unresolved', label: 'Name unresolved' },
      { id: 4, kind: 'name-noise', label: 'Suspicious punctuation' },
      { id: 2, kind: 'duplicate-name', label: 'Duplicate visible name' },
      { id: 3, kind: 'duplicate-name', label: 'Duplicate visible name' },
    ]);
  });
});

describe('moveFeedTagBetweenGroups', () => {
  it('moves a standalone tag into an existing OR group', () => {
    const groups = [[tag(1), tag(2)], [tag(3)], [tag(4)]];

    expect(moveFeedTagBetweenGroups(groups, 4, 0)).toEqual([
      [tag(1), tag(2), tag(4)],
      [tag(3)],
    ]);
    expect(groups).toEqual([[tag(1), tag(2)], [tag(3)], [tag(4)]]);
  });

  it('splits a grouped tag into its own standalone AND group', () => {
    expect(moveFeedTagBetweenGroups([[tag(1), tag(2), tag(3)], [tag(4)]], 2, null)).toEqual([
      [tag(1), tag(3)],
      [tag(4)],
      [tag(2)],
    ]);
  });

  it('moves between groups even when removing the source shifts the target index', () => {
    expect(moveFeedTagBetweenGroups([[tag(1)], [tag(2), tag(3)], [tag(4)]], 1, 2)).toEqual([
      [tag(2), tag(3)],
      [tag(4), tag(1)],
    ]);
  });

  it('leaves same-group, already-standalone, and unknown-tag moves unchanged', () => {
    const groups = [[tag(1), tag(2)], [tag(3)]];

    expect(moveFeedTagBetweenGroups(groups, 1, 0)).toEqual(groups);
    expect(moveFeedTagBetweenGroups(groups, 3, null)).toEqual(groups);
    expect(moveFeedTagBetweenGroups(groups, 99, 0)).toEqual(groups);
  });
});

describe('tag-group URL round-trip', () => {
  const roundTrip = (groups: number[][]) =>
    parseTagGroupsFromSearch(new URL(
      buildHrefWithTagFilter('https://civitai.com/images', groups, [], 'all')
    ).search);

  it('preserves group order across Apply, singletons included', () => {
    const href = buildHrefWithTagFilter('https://civitai.com/images', [[1], [2, 3]], [], 'all');
    const url = new URL(href);

    expect(url.searchParams.getAll('taggroups')).toEqual(['1', '2,3']);
    expect(url.searchParams.getAll('tags')).toEqual(['1', '2', '3']);
    expect(roundTrip([[1], [2, 3]])).toEqual([[1], [2, 3]]);
    expect(roundTrip([[2, 3], [1]])).toEqual([[2, 3], [1]]);
    expect(roundTrip([[1], [2, 3], [4]])).toEqual([[1], [2, 3], [4]]);
  });

  it('leaves plain single-tag filters on bare tags= params', () => {
    const url = new URL(buildHrefWithTagFilter('https://civitai.com/images', [[1], [2]], [], 'all'));

    expect(url.searchParams.getAll('taggroups')).toEqual([]);
    expect(url.searchParams.getAll('tags')).toEqual(['1', '2']);
    expect(parseTagGroupsFromSearch(url.search)).toEqual([[1], [2]]);
  });

  it('marks both multi-tag modes explicitly, including one OR group', () => {
    const any = new URL(buildHrefWithTagFilter('https://civitai.com/images', [[1], [2]], [], 'any'));
    const oneGroup = new URL(buildHrefWithTagFilter('https://civitai.com/images', [[1, 2]], [], 'all'));

    expect(any.searchParams.get('tagmode')).toBe('any');
    expect(oneGroup.searchParams.get('tagmode')).toBe('all');
    expect(oneGroup.searchParams.getAll('taggroups')).toEqual(['1,2']);
  });

  it('still appends tags= ids that no explicit group covers', () => {
    expect(parseTagGroupsFromSearch('?taggroups=2,3&tags=2&tags=3&tags=9')).toEqual([[2, 3], [9]]);
  });
});

describe('mergeFeedTagGroups', () => {
  it('moves the complete source group into the target group', () => {
    expect(
      mergeFeedTagGroups(
        [[tag(1), tag(2)], [tag(3)], [tag(4), tag(5)]],
        0,
        2
      )
    ).toEqual([[tag(3)], [tag(4), tag(5), tag(1), tag(2)]]);
  });

  it('returns copied groups for invalid and same-group targets', () => {
    const groups = [[tag(1), tag(2)], [tag(3), tag(4)]];
    const same = mergeFeedTagGroups(groups, 0, 0);
    const invalid = mergeFeedTagGroups(groups, 0, 9);

    expect(same).toEqual(groups);
    expect(invalid).toEqual(groups);
    expect(same).not.toBe(groups);
    expect(same[0]).not.toBe(groups[0]);
  });
});
