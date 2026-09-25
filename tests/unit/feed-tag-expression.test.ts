import { describe, expect, it } from 'vitest';
import { formatFeedTagExpression, parseFeedTagExpression } from '@/lib/feed-tag-expression';

describe('feed tag expressions', () => {
  it('round-trips names, groups, mode, punctuation, and exclusions', () => {
    const value = {
      groups: [[{ id: 1, name: 'clothing' }, { id: 2, name: 'lingerie,' }], [{ id: 3, name: 'nun' }]],
      negatives: [{ id: 4, name: 'watermark "text"' }],
      mode: 'all' as const,
    };
    const formatted = formatFeedTagExpression(value);
    expect(formatted).toBe(
      '("clothing" [#1] OR "lingerie," [#2]) AND ("nun" [#3]) AND NOT ("watermark \\"text\\"" [#4])'
    );
    expect(parseFeedTagExpression(formatted)).toEqual(value);
  });

  it('accepts readable bare names and OR group matching', () => {
    expect(parseFeedTagExpression('(clothing #1 OR clothes #2) OR (nun #3)')).toEqual({
      groups: [[{ id: 1, name: 'clothing' }, { id: 2, name: 'clothes' }], [{ id: 3, name: 'nun' }]],
      negatives: [],
      mode: 'any',
    });
  });

  it('rejects mixed group connectors and malformed IDs', () => {
    expect(() => parseFeedTagExpression('(a #1) AND (b #2) OR (c #3)')).toThrow('one connector');
    expect(() => parseFeedTagExpression('(a)')).toThrow('[#id]');
  });
});
