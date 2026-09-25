/**
 * Feed tag-filter URL contract — pure helpers with no extension/storage imports, so they
 * are safe to bundle into the MAIN-world interceptor as well as the content script.
 *
 * CivitAI understands `?tags=`; everything else here is extension-only and ignored by the
 * site: `tagmode`, `tagneg`, `taggroups`, `tagbundles` and the `ff*` facet params.
 */
import { writeFeedFacetsToUrl, type FeedFacetFilter } from './feed-facets';

export interface FeedTag {
  id: number;
  name: string;
}

export interface FeedTagBundle {
  seedId: number;
  tagIds: number[];
}

export type FeedKind = 'images' | 'videos';
export type TagMode = 'all' | 'any';

/** Our own URL marker for group semantics. CivitAI ignores it. */
export const TAG_MODE_PARAM = 'tagmode';
/** Repeated extension-only negative tag ids. CivitAI ignores it; our interceptor filters it. */
export const NEGATIVE_TAG_PARAM = 'tagneg';
/** Repeated extension-only OR groups, encoded as comma-separated tag ids. */
export const TAG_GROUPS_PARAM = 'taggroups';
/** Repeated extension-only similarity bundles, encoded as seed:member,member. */
export const TAG_BUNDLES_PARAM = 'tagbundles';

/**
 * Which feed (if any) the given pathname is. Covers the global feeds and user-profile
 * media tabs — verified live: profile feeds pass URL `?tags=` straight into
 * image.getInfinite alongside `username`, so the whole filter stack works there too.
 */
export function getFeedKind(pathname: string): FeedKind | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/images' || /^\/user\/[^/]+\/images$/.test(p)) return 'images';
  if (p === '/videos' || /^\/user\/[^/]+\/videos$/.test(p)) return 'videos';
  return null;
}


/** Read the currently-applied tag IDs from a feed URL's query string. */
export function parseTagsFromSearch(search: string): number[] {
  const sp = new URLSearchParams(search);
  return sp
    .getAll('tags')
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Read extension-side negative tag IDs from a feed URL. */
export function parseNegativeTagsFromSearch(search: string): number[] {
  return parsePositiveInts(new URLSearchParams(search).getAll(NEGATIVE_TAG_PARAM));
}

/**
 * Read positive OR groups from a feed URL. If no explicit groups are present,
 * repeated `tags=` params become ordinary one-tag groups. If explicit groups
 * are present, any ungrouped `tags=` values are appended as one-tag groups.
 */
export function parseTagGroupsFromSearch(search: string): number[][] {
  const sp = new URLSearchParams(search);
  const flat = parseTagsFromSearch(search);
  const groups = sp
    .getAll(TAG_GROUPS_PARAM)
    .map((raw) => parsePositiveInts(raw.split(',')))
    .filter((group) => group.length > 0);
  if (!groups.length) return flat.map((id) => [id]);

  const grouped = new Set(groups.flat());
  for (const id of flat) {
    if (!grouped.has(id)) groups.push([id]);
  }
  return groups;
}

/** Read similarity-bundle provenance without affecting feed matching semantics. */
export function parseTagBundlesFromSearch(search: string): FeedTagBundle[] {
  return new URLSearchParams(search)
    .getAll(TAG_BUNDLES_PARAM)
    .map((raw) => {
      const separator = raw.indexOf(':');
      if (separator === -1) return undefined;
      const seedId = Number(raw.slice(0, separator));
      const tagIds = uniquePositiveInts([
        seedId,
        ...raw.slice(separator + 1).split(',').map(Number),
      ]);
      if (!Number.isInteger(seedId) || seedId <= 0 || tagIds.length < 2) return undefined;
      return { seedId, tagIds };
    })
    .filter((bundle): bundle is FeedTagBundle => bundle !== undefined);
}

/** Read the multi-tag mode from a feed URL (legacy URLs without a marker mean 'any'). */
export function parseModeFromSearch(search: string): TagMode {
  return new URLSearchParams(search).get(TAG_MODE_PARAM) === 'all' ? 'all' : 'any';
}

/**
 * Rebuild an href with the given tag IDs as repeated `tags=` params, preserving
 * everything else. Multi-tag filters carry an explicit mode so the interceptor and shared
 * URLs retain the same group semantics across CivitAI navigations.
 */
export function buildHrefWithTags(currentHref: string, ids: number[], mode: TagMode = 'any'): string {
  return buildHrefWithTagFilter(currentHref, ids.map((id) => [id]), [], mode);
}

export function buildHrefWithTagFilter(
  currentHref: string,
  groups: number[][],
  excludedIds: number[] = [],
  mode: TagMode = 'any',
  facets?: Partial<FeedFacetFilter> | null,
  bundles: FeedTagBundle[] = []
): string {
  const url = new URL(currentHref);
  const cleanGroups = groups
    .map((group) => uniquePositiveInts(group))
    .filter((group) => group.length > 0);
  const positiveIds = uniquePositiveInts(cleanGroups.flat());
  const negatives = uniquePositiveInts(excludedIds);

  url.searchParams.delete('tags');
  url.searchParams.delete(NEGATIVE_TAG_PARAM);
  url.searchParams.delete(TAG_GROUPS_PARAM);
  url.searchParams.delete(TAG_BUNDLES_PARAM);

  for (const id of positiveIds) url.searchParams.append('tags', String(id));
  for (const id of negatives) url.searchParams.append(NEGATIVE_TAG_PARAM, String(id));
  // As soon as one real OR group exists, emit EVERY group — singletons included. Leaving
  // them implicit made the parser append them after the explicit groups, so [[1],[2,3]]
  // came back as [[2,3],[1]] and each Apply reshuffled the user's groups. Plain one-tag
  // filters still travel as bare `tags=` params.
  if (cleanGroups.some((group) => group.length > 1)) {
    for (const group of cleanGroups) url.searchParams.append(TAG_GROUPS_PARAM, group.join(','));
  }
  const positiveSet = new Set(positiveIds);
  for (const bundle of bundles) {
    const tagIds = uniquePositiveInts(bundle.tagIds).filter((id) => positiveSet.has(id));
    if (!tagIds.includes(bundle.seedId) || tagIds.length < 2) continue;
    url.searchParams.append(TAG_BUNDLES_PARAM, `${bundle.seedId}:${tagIds.join(',')}`);
  }

  if (positiveIds.length >= 2) {
    url.searchParams.set(TAG_MODE_PARAM, mode);
  } else {
    url.searchParams.delete(TAG_MODE_PARAM);
  }
  writeFeedFacetsToUrl(url, facets);
  return url.toString();
}

function parsePositiveInts(values: string[]): number[] {
  return uniquePositiveInts(values.map((v) => Number(v)));
}

export function uniquePositiveInts(values: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// --- last-applied filter stash (survives CivitAI's own navigations) ---

/**
 * CivitAI's own navigation (Images↔Videos tab, period, sort) rebuilds the URL with only the
 * `tags=` it knows and drops every extension param, which silently changes group semantics.
 * The content script keeps the last applied filter in localStorage — shared
 * between the isolated and MAIN worlds — so either side can put the markers back before the
 * feed request goes out, provided the surviving `tags=` set is exactly the stashed one.
 */
export const FEED_FILTER_STASH_KEY = 'cllp:feed-filter-stash';

export interface FeedFilterStash {
  v: 1;
  groups: number[][];
  negatives: number[];
  mode: TagMode;
  bundles: FeedTagBundle[];
  facets: Partial<FeedFacetFilter> | null;
}

const EXTENSION_PARAMS = [TAG_MODE_PARAM, NEGATIVE_TAG_PARAM, TAG_GROUPS_PARAM, TAG_BUNDLES_PARAM];

/** True when the URL carries `tags=` but none of our markers — the stripped-navigation shape. */
export function feedFilterMarkersStripped(search: string, facetParams: readonly string[]): boolean {
  const sp = new URLSearchParams(search);
  if (!sp.has('tags')) return false;
  return !EXTENSION_PARAMS.some((param) => sp.has(param)) && !facetParams.some((param) => sp.has(param));
}

export function writeFeedFilterStash(
  store: Pick<Storage, 'setItem'> | null | undefined,
  stash: Omit<FeedFilterStash, 'v'>
): void {
  try {
    store?.setItem(FEED_FILTER_STASH_KEY, JSON.stringify({ v: 1, ...stash }));
  } catch {
    /* quota / privacy mode — restoration is best-effort */
  }
}

/**
 * Restore markers in place if the current URL is a stripped copy of the stashed filter.
 * Uses replaceState so the site's router sees no navigation; the existing history state is
 * kept (Next.js keys off it), with its `as`/`url` strings refreshed so a later back/forward
 * lands on the restored URL rather than the stripped one. Returns the restored href or null.
 */
export function restoreStrippedFeedFilterInPlace(
  win: Pick<Window, 'location' | 'history' | 'localStorage'>,
  facetParams: readonly string[]
): string | null {
  let restored: string | null = null;
  try {
    restored = restoreStrippedFeedFilterHref(win.location.href, readFeedFilterStash(win.localStorage), facetParams);
    if (!restored) return null;
    const next = new URL(restored);
    const pathAndSearch = `${next.pathname}${next.search}${next.hash}`;
    const state = win.history.state;
    const nextState = state && typeof state === 'object'
      ? {
          ...state,
          ...(typeof state.as === 'string' ? { as: pathAndSearch } : {}),
          ...(typeof state.url === 'string' ? { url: pathAndSearch } : {}),
        }
      : state;
    win.history.replaceState(nextState, '', restored);
    return restored;
  } catch {
    return null;
  }
}

export function readFeedFilterStash(store: Pick<Storage, 'getItem'> | null | undefined): FeedFilterStash | null {
  try {
    const raw = store?.getItem(FEED_FILTER_STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FeedFilterStash>;
    if (parsed?.v !== 1 || !Array.isArray(parsed.groups)) return null;
    return {
      v: 1,
      groups: parsed.groups.map((group) => uniquePositiveInts(Array.isArray(group) ? group : [])).filter((g) => g.length),
      negatives: uniquePositiveInts(Array.isArray(parsed.negatives) ? parsed.negatives : []),
      mode: parsed.mode === 'all' ? 'all' : 'any',
      bundles: Array.isArray(parsed.bundles) ? parsed.bundles : [],
      facets: parsed.facets ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * If `href` is a stripped feed URL whose `tags=` set equals the stash's positive tags, return
 * the href with every extension marker restored; otherwise null. The set must match exactly —
 * a site navigation that changed the tags (e.g. clicking a tag chip) is a new intent.
 */
export function restoreStrippedFeedFilterHref(
  href: string,
  stash: FeedFilterStash | null,
  facetParams: readonly string[]
): string | null {
  if (!stash) return null;
  const url = new URL(href);
  if (!getFeedKind(url.pathname) || !feedFilterMarkersStripped(url.search, facetParams)) return null;
  const urlIds = parseTagsFromSearch(url.search).sort((a, b) => a - b);
  const stashIds = uniquePositiveInts(stash.groups.flat()).sort((a, b) => a - b);
  if (!urlIds.length || urlIds.length !== stashIds.length || urlIds.some((id, i) => id !== stashIds[i])) return null;
  const restored = buildHrefWithTagFilter(href, stash.groups, stash.negatives, stash.mode, stash.facets, stash.bundles);
  return restored === href ? null : restored;
}
