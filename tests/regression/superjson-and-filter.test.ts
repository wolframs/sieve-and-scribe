// Regression coverage for entrypoints/civitai-and.content.ts's superjson meta-rebuild path.
//
// The bug this guards: CivitAI's image.getInfinite envelopes carry per-item TYPED superjson
// markers in meta.values (e.g. 'items.3.user.deletedAt' -> [['Date']]) whenever an item's
// author account was deleted — routine on Year/AllTime feeds. Filtering the items array for
// AND-matching without also re-deriving these markers at the new indices produced a payload
// the client's superjson deserializer couldn't parse, which forced a silent fallback to
// native OR for the whole page. inlineRefs/harvestItemMeta/rebuildItemMeta (and the
// itemMarkers WeakMap that ties a marker to its item object, not its position) are the fix;
// these tests build realistic envelopes and verify the rebuilt meta after a filter+reindex.
import { describe, it, expect } from 'vitest';
import {
  inlineRefs,
  getByPath,
  setByPath,
  harvestItemMeta,
  rebuildItemMeta,
} from '@/entrypoints/civitai-and.content';

/** A minimal but shape-accurate `result.data.{json,meta}` superjson envelope root. */
function makeRoot(
  items: any[],
  meta: { values?: Record<string, unknown>; referentialEqualities?: Record<string, string | string[]> } = {},
  nextCursor: unknown = null
) {
  return { result: { data: { json: { items, nextCursor }, meta } } };
}

function item(id: number, tagIds: number[], extra: Record<string, unknown> = {}) {
  return { id, tagIds, ...extra };
}

describe('rebuildItemMeta / harvestItemMeta: marker-free page (Month-style)', () => {
  it('drops a filtered-out item silently and leaves unrelated meta.values untouched', () => {
    const items = [item(1, [10]), item(2, [20]), item(3, [30])];
    // A plausible non-item meta entry (superjson marking json.nextCursor as `undefined`).
    const root = makeRoot(items, { values: { nextCursor: ['undefined'] } });

    harvestItemMeta(root, root.result.data.json);
    const kept = [items[0], items[2]]; // AND filter drops item 2
    rebuildItemMeta(root, kept);

    // No item ever had a marker, so no items.* keys should be fabricated.
    expect(root.result.data.meta.values).toEqual({ nextCursor: ['undefined'] });
  });
});

describe('rebuildItemMeta: Year-style page with per-item Date markers', () => {
  it('re-emits typed markers at the NEW index for kept items and drops them for filtered-out items', () => {
    const items = [0, 1, 2, 3, 4, 5].map((i) => item(i, [10]));
    const root = makeRoot(items, {
      values: {
        'items.1.user.deletedAt': [['Date']],
        'items.3.user.deletedAt': [['Date']],
        'items.4.user.deletedAt': [['Date']],
        nextCursor: ['undefined'],
      },
    });

    harvestItemMeta(root, root.result.data.json);
    // AND filter keeps original indices 1, 4, 5 (drops 0, 2, 3) -> new indices 0, 1, 2.
    const kept = [items[1], items[4], items[5]];
    rebuildItemMeta(root, kept);

    expect(root.result.data.meta.values).toEqual({
      'items.0.user.deletedAt': [['Date']], // was item 1
      'items.1.user.deletedAt': [['Date']], // was item 4
      // item 5 (new index 2) never had a marker -> no items.2.* key.
      // item 3's marker was dropped along with the item, not reindexed onto anything.
      nextCursor: ['undefined'],
    });
  });
});

describe('inlineRefs: referentialEqualities pointing at item paths', () => {
  it('inlines an independent clone of the referenced value and mirrors its typed marker to the dupe path', () => {
    const items = [
      item(0, [10], { user: { username: 'ghost', deletedAt: '2024-01-01T00:00:00.000Z' } }),
      item(1, [10]),
      item(2, [10]),
      item(3, [10]),
    ];
    const root = makeRoot(items, {
      values: { 'items.0.user.deletedAt': [['Date']] },
      referentialEqualities: { 'items.0.user': ['items.2.user'] },
    });

    inlineRefs(root);

    // The dupe now carries its own (deep-equal) copy of the canonical value.
    expect(items[2].user).toEqual(items[0].user);
    // ...and it really is a clone, not a shared reference: mutating one must not affect the other.
    (items[2].user as any).username = 'mutated';
    expect(items[0].user.username).toBe('ghost');
    // The typed marker under the canonical path is mirrored to the dupe path.
    expect(root.result.data.meta.values['items.2.user.deletedAt']).toEqual([['Date']]);
    // referentialEqualities is consumed — its stale absolute indices must not survive filtering.
    expect(root.result.data.meta.referentialEqualities).toBeUndefined();

    // The mirrored marker travels through the normal harvest/filter/rebuild pipeline too:
    // keep only the dupe (item 2) and drop the original (item 0).
    harvestItemMeta(root, root.result.data.json);
    rebuildItemMeta(root, [items[2]]);
    expect(root.result.data.meta.values).toEqual({ 'items.0.user.deletedAt': [['Date']] });
  });
});

describe('rebuildItemMeta: defensive referentialEqualities cleanup', () => {
  it('strips a leftover referentialEqualities block even if inlineRefs never ran on it', () => {
    const items = [item(0, [10])];
    const root = makeRoot(items, {
      values: { foo: 'bar' },
      referentialEqualities: { 'items.0.user': ['items.1.user'] },
    });

    rebuildItemMeta(root, items);

    expect(root.result.data.meta.referentialEqualities).toBeUndefined();
    expect(root.result.data.meta.values).toEqual({ foo: 'bar' });
  });
});

describe('harvestItemMeta: key-shape strictness', () => {
  it('leaves "itemsFoo.*" lookalikes as untouched non-item meta and silently drops malformed "items.<non-digit>.*" keys', () => {
    const items = [item(0, [10])];
    const root = makeRoot(items, {
      values: {
        'items.0.tagIds': [['Set']],
        'itemsFoo.0.x': ['some-value'], // does not match /^items\./ - not an item marker
        'items.abc.x': ['stale'], // matches the "items." prefix but has no numeric index
      },
    });

    harvestItemMeta(root, root.result.data.json);
    rebuildItemMeta(root, items);

    // 'itemsFoo.0.x' was never harvested (regex requires numeric index) but also isn't
    // considered "item meta" by rebuildItemMeta's `/^items\./` prefix check, so it survives
    // as ordinary passthrough meta. 'items.abc.x' matches that same prefix check (so it's
    // excluded from the passthrough bucket) yet was never harvested onto any item either
    // (no numeric index) - it is dropped rather than corrupting either bucket.
    expect(root.result.data.meta.values).toEqual({
      'items.0.tagIds': [['Set']],
      'itemsFoo.0.x': ['some-value'],
    });
  });
});

describe('itemMarkers WeakMap: markers travel with the item object, not its original index', () => {
  it('re-indexes markers correctly when items harvested from two different source pages are merged', () => {
    // Page A (first driver page) and Page B (a top-up cursor page) each have their own
    // objects and their own "items.<i>" numbering - exactly what the driver-cursor-walk in
    // computeBody produces before matches from multiple pages are concatenated.
    const pageAItems = [item(100, [10]), item(101, [10])];
    const rootA = makeRoot(pageAItems, { values: { 'items.1.user.deletedAt': [['Date']] } });
    harvestItemMeta(rootA, rootA.result.data.json);

    const pageBItems = [item(200, [10]), item(201, [10])];
    const rootB = makeRoot(pageBItems, { values: { 'items.0.user.deletedAt': [['Date']] } });
    harvestItemMeta(rootB, rootB.result.data.json);

    // Merge order deliberately collides with the source pages' own indices: the marked item
    // from page B (its original index 0) ends up at new index 0, and the marked item from
    // page A (its original index 1) ends up at new index 2 - neither matches its origin index.
    const merged = [pageBItems[0], pageBItems[1], pageAItems[1], pageAItems[0]];
    const template = makeRoot([], {}); // the outgoing envelope is rebuilt onto the template page
    rebuildItemMeta(template, merged);

    expect(template.result.data.meta.values).toEqual({
      'items.0.user.deletedAt': [['Date']], // pageBItems[0], carried by object identity
      'items.2.user.deletedAt': [['Date']], // pageAItems[1], carried by object identity
    });
  });
});

describe('getByPath / setByPath', () => {
  it('reads and writes nested paths, and no-op safely through a missing intermediate', () => {
    const obj: any = { a: { b: { c: 1 } } };
    expect(getByPath(obj, 'a.b.c')).toBe(1);
    setByPath(obj, 'a.b.c', 2);
    expect(obj.a.b.c).toBe(2);

    // Missing intermediate: getByPath must return undefined (not throw) - inlineRefs relies
    // on this to skip a reference whose canonical path doesn't resolve.
    expect(getByPath(obj, 'a.missing.c')).toBeUndefined();
    // setByPath must likewise no-op rather than throw when an intermediate is absent.
    expect(() => setByPath(obj, 'a.missing.c', 99)).not.toThrow();
    expect(obj.a.missing).toBeUndefined();
  });
});
