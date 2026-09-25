import { parse as parseDevalue, stringify as stringifyDevalue } from 'devalue';
import {
  FEED_FACET_PARAMS,
  hasFeedFacets,
  matchesFeedFacets,
  parseFeedFacetsFromSearch,
  type FeedFacetFilter,
} from '@/lib/feed-facets';
import { restoreStrippedFeedFilterInPlace } from '@/lib/feed-filter-url';

/**
 * Tag-group filtering engine — MAIN-world `fetch` interceptor.
 *
 * CivitAI's feed currently intersects multiple `?tags=` IDs. We need OR within a group
 * and, in Any mode, across groups. This script patches the page's `window.fetch` and
 * synthesizes union pages from one-tag requests. All mode intersects those groups against
 * embedded `tagIds`. Extension-only `tagneg=` params exclude matching items.
 *
 * Density matters: if we asked the server for the OR superset, a single common tag would
 * swamp the feed and the rare intersection would barely appear. Instead we pick a single
 * "driver" tag (the one whose sampled feed yields the most full-AND matches), drive the
 * upstream feed by that ONE tag (so every page is dense in it), and client-filter for the
 * rest. Driving by one tag also keeps pagination coherent — we walk that tag's cursors and
 * hand its `nextCursor` back, so infinite-scroll continues correctly. Extra cursor pages
 * are pulled transparently to fill each returned page.
 *
 * Defensive by design: anything it doesn't recognise (unexpected envelope, missing
 * `tagIds`, parse error, non-feed request) is passed through untouched with a site-health
 * warning, rather than returning malformed data to the page.
 *
 * Runs in MAIN world at document_start (before CivitAI's bundle issues any feed fetch).
 * It is URL-driven — it reads `location.search` and the request's own input — so it needs
 * no message channel with the isolated content script.
 */
const FEED_PATH = '/api/trpc/image.getInfinite';
const MODE_PARAM = 'tagmode';
const NEGATIVE_TAG_PARAM = 'tagneg';
const TAG_GROUPS_PARAM = 'taggroups';
const MAX_EXTRA_FETCHES = 4; // bound the cursor-walk latency
const FILL_TARGET = 28; // stop walking once we have ~a viewport's worth — scroll loads more
const DRIVER_CACHE_CAP = 10; // remember the chosen driver per tag-set
const RESP_CACHE_TTL = 4000; // dedupe strict-mode double-renders / retries of the same page
const RESP_CACHE_CAP = 40;
const UNION_CURSOR_PREFIX = 'cllp-union-v1:';
const UNION_FETCH_CONCURRENCY = 6;

/** Chosen driver tag per sorted tag-set key, so we don't re-probe on every scroll page. */
const driverCache = new Map<string, number>();
/**
 * Per-item superjson markers (the `items.<i>.<path>` entries of meta.values) harvested from
 * each source page, keyed by item object so they travel with the item through filtering and
 * cross-page reordering. Without this, a typed marker (e.g. `user.deletedAt: ["Date"]`, which
 * appears whenever a feed page contains an image by a deleted user — common on Year/AllTime
 * windows) forced a passthrough to native tag matching for the whole page.
 */
const itemMarkers = new WeakMap<object, Record<string, unknown>>();
/** Short-lived per-input-URL response cache: collapses duplicate concurrent/rapid requests. */
const respCache = new Map<string, { ts: number; promise: Promise<string | null> }>();

export interface DecodedFeedEnvelope {
  root: any;
  node: any;
  transport: 'devalue' | 'superjson';
}

interface FeedPage {
  body: any;
  envelope: DecodedFeedEnvelope;
  node: any;
}

interface UnionCursor {
  signature: string;
  cursors: unknown[];
}

function driverCacheSet(key: string, val: number) {
  if (driverCache.size >= DRIVER_CACHE_CAP) driverCache.delete(driverCache.keys().next().value!);
  driverCache.set(key, val);
}

export default defineContentScript({
  matches: ['https://civitai.com/*', 'https://civitai.red/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installAndInterceptor();
  },
});

export function installAndInterceptor() {
  const w = window as unknown as { __cllpAndPatched?: boolean };
  if (w.__cllpAndPatched) return;
  w.__cllpAndPatched = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const url = requestUrl(input);
      // CivitAI's tab/period/sort navigation drops our markers; the content script normally
      // restores them first, but on a cold load it may not have run yet — backstop here so
      // the very first feed request already sees the full filter.
      if (url.includes(FEED_PATH)) restoreStrippedFeedFilterInPlace(window, FEED_FACET_PARAMS);
      if (
        url.includes(FEED_PATH) &&
        method(input, init) === 'GET' &&
        shouldFilterFeed(location.search)
      ) {
        const handled = await andFilter(originalFetch, url);
        if (handled) return handled; // null → fall through to a normal fetch
      }
    } catch {
      /* never let the interceptor break the page — fall through */
    }
    return originalFetch(input, init);
  };
}

/**
 * Returns a synthesized tag-filtered Response, or null to pass through. Wraps the heavy work
 * in a short-TTL per-URL/filter cache so React's double-render and tRPC retries of the
 * *same* page don't each trigger a fresh cursor-walk.
 */
async function andFilter(originalFetch: typeof fetch, url: string): Promise<Response | null> {
  const u = new URL(url, location.origin);
  const key = `${u.href}#${location.search}`;
  const now = Date.now();
  const hit = respCache.get(key);
  if (hit && now - hit.ts < RESP_CACHE_TTL) {
    const body = await hit.promise;
    return body == null ? null : jsonResponse(body);
  }
  const promise = computeBody(originalFetch, u).catch(() => null);
  respCache.set(key, { ts: now, promise });
  if (respCache.size > RESP_CACHE_CAP) respCache.delete(respCache.keys().next().value!);
  const body = await promise;
  // Don't cache passthrough/error results — a transient failure shouldn't pin us to native
  // for the whole TTL; let the next identical request retry.
  if (body == null) {
    respCache.delete(key);
    return null;
  }
  return jsonResponse(body);
}

/** Returns the filtered response body as a JSON string, or null to pass through. */
export async function computeBody(originalFetch: typeof fetch, u: URL): Promise<string | null> {
  const batch = u.searchParams.get('batch') === '1';
  const rawInput = u.searchParams.get('input');
  if (!rawInput) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return null;
  }

  const query = batch ? parsed['0'] : parsed;
  const wanted: number[] = (query?.json?.tags ?? []).filter((n: unknown) => typeof n === 'number');
  const negativeSet = new Set(parseTagList(location.search, NEGATIVE_TAG_PARAM));
  const facets = parseFeedFacetsFromSearch(location.search);
  const mode = new URLSearchParams(location.search).get(MODE_PARAM);
  const groups = positiveGroupsFromSearch(location.search, wanted);
  const positiveIds = uniquePositiveInts(groups.flat());

  // One OR group still needs a union: CivitAI now intersects the tags within a native
  // request. Old extension links with taggroups but no explicit mode also mean Any.
  if (positiveIds.length > 1 && (mode !== 'all' || groups.length === 1)) {
    return unionTagPages(originalFetch, u, parsed, query, batch, positiveIds, negativeSet, facets);
  }

  if (mode !== 'all') {
    if (!negativeSet.size && !hasFeedFacets(facets)) return null;
    return filterNativePages(originalFetch, u, parsed, query, batch, negativeSet, facets);
  }

  if (groups.length < 2) {
    if (!negativeSet.size && !hasFeedFacets(facets)) return null;
    return filterNativePages(originalFetch, u, parsed, query, batch, negativeSet, facets);
  }

  const driverCandidates = uniquePositiveInts(groups.flat());
  const driverLimit = typeof query?.json?.limit === 'number' ? query.json.limit : 100;
  const incomingCursor = query?.json?.cursor ?? null;
  // Scope the driver choice to period+sort too: the densest driver for a Month window
  // isn't necessarily the densest for Year, and a scoped key re-probes on filter changes.
  const setKey = [
    groups.map((group) => group.join('.')).join('|'),
    [...negativeSet].sort((a, b) => a - b).join('.'),
    JSON.stringify(facets),
    String(query?.json?.period ?? ''),
    String(query?.json?.sort ?? ''),
  ].join('!');

  const matches: any[] = [];
  const seen = new Set<number>();
  let template: FeedPage | null = null;
  let cursor: unknown = incomingCursor;
  let driver = driverCache.get(setKey);

  // Cold start (no driver yet, first page): fold the probe INTO the first fetch — request each
  // tag's first page in parallel, pick the densest as the driver, and seed matches from the
  // winning page. One parallel batch instead of a probe round-trip followed by a walk.
  if (driver === undefined && incomingCursor == null) {
    const pages = await Promise.all(
      driverCandidates.map(async (tag) => {
        try {
          const r = await originalFetch(withTags(u, parsed, batch, [tag], null, driverLimit), {
            headers: { accept: 'application/json' },
            credentials: 'include',
          });
          if (!r.ok) return null;
          const b = await r.json();
          const page = decodeFeedPage(b, batch);
          if (!page) return null;
          let score = 0;
          for (const it of page.node.items) {
            if (matchesFilter(it, groups, negativeSet, facets)) score++;
          }
          return { tag, ...page, score };
        } catch {
          return null;
        }
      })
    );
    let best: any = null;
    for (const p of pages) if (p && (!best || p.score > best.score)) best = p;
    if (!best) return passthrough('driver probe got no usable page');
    // An EMPTY page is a legitimate AND answer (nothing matches this period), not a contract
    // break — only pages with items that lack tagIds mean we cannot intersect.
    if (lacksTagIds(best.node.items)) return passthrough('feed items carry no tagIds');
    driver = best.tag;
    driverCacheSet(setKey, driver!);
    template = best;
    collectMatches(best.node, groups, negativeSet, facets, matches, seen);
    cursor = best.node.nextCursor;
  }

  // Reaching here with no driver means a scroll page (incomingCursor set) whose driver-cache
  // entry was evicted. The incoming cursor is tag-specific to the old driver, so we can't safely
  // re-probe — pass through for this one page rather than return wrong/empty results.
  if (driver === undefined) return passthrough('driver-cache entry evicted mid-scroll');

  // Top up only until we've got ~a viewport's worth; the virtualized feed loads more on scroll.
  // A page-1 request with a cached driver (post-TTL refetch, sort/period change, back-nav)
  // starts a fresh driver walk — `cursor == null` is a valid walk START, not an end, there.
  let firstPage = incomingCursor == null && template === null;
  let extra = 0;
  while (matches.length < FILL_TARGET && (firstPage || cursor != null) && extra < MAX_EXTRA_FETCHES) {
    firstPage = false;
    extra++;
    let body: any;
    try {
      const r = await originalFetch(withTags(u, parsed, batch, [driver], cursor, driverLimit), {
        headers: { accept: 'application/json' },
        credentials: 'include',
      });
      if (!r.ok) break;
      body = await r.json();
    } catch {
      break;
    }
    const page = decodeFeedPage(body, batch);
    if (!page) break;
    if (template === null) {
      if (lacksTagIds(page.node.items)) return passthrough('feed items carry no tagIds');
      template = page;
    }
    collectMatches(page.node, groups, negativeSet, facets, matches, seen);
    cursor = page.node.nextCursor;
  }

  if (template === null) return passthrough('never got a usable driver page');
  const outNode = template.node;
  outNode.items = matches;
  outNode.nextCursor = cursor ?? null; // driver's cursor → infinite-scroll continues
  if (template.envelope.transport === 'superjson') {
    rebuildItemMeta(template.envelope.root, matches);
  }
  return encodeFeedEnvelope(template.body, template.envelope);
}

/**
 * One small page per tag gives the native feed's OR union without discarding unread items.
 * Each source has its own server cursor, carried in our synthetic nextCursor. Assign an
 * item to its first selected tag, so the same image never appears on another source page.
 */
async function unionTagPages(
  originalFetch: typeof fetch,
  u: URL,
  parsed: any,
  query: any,
  batch: boolean,
  tags: number[],
  negativeSet: Set<number>,
  facets: FeedFacetFilter
): Promise<string | null> {
  const signature = unionSignature(tags, query);
  const incoming = query?.json?.cursor;
  let cursors: unknown[] = tags.map(() => undefined);
  if (incoming != null) {
    if (typeof incoming !== 'string' || !incoming.startsWith(UNION_CURSOR_PREFIX))
      return passthrough('unrecognized union cursor');
    try {
      const saved = JSON.parse(incoming.slice(UNION_CURSOR_PREFIX.length)) as UnionCursor;
      if (saved.signature !== signature || !Array.isArray(saved.cursors) || saved.cursors.length !== tags.length)
        return passthrough('union cursor does not match filter');
      cursors = saved.cursors;
    } catch {
      return passthrough('malformed union cursor');
    }
  }

  const requestedLimit = typeof query?.json?.limit === 'number' && query.json.limit > 0
    ? query.json.limit : 100;
  const sourceLimit = Math.max(FILL_TARGET, Math.ceil(Math.min(requestedLimit, 100) / tags.length));
  const pages: Array<FeedPage | null> = tags.map(() => null);
  for (let start = 0; start < tags.length; start += UNION_FETCH_CONCURRENCY) {
    const indices = tags.slice(start, start + UNION_FETCH_CONCURRENCY).map((_, i) => start + i);
    const fetched = await Promise.all(indices.map(async (index) => {
      if (cursors[index] === null) return null;
      try {
        const response = await originalFetch(
          withTags(u, parsed, batch, [tags[index]], cursors[index], sourceLimit),
          { headers: { accept: 'application/json' }, credentials: 'include' }
        );
        if (!response.ok) return undefined;
        return decodeFeedPage(await response.json(), batch) ?? undefined;
      } catch {
        return undefined;
      }
    }));
    for (let i = 0; i < indices.length; i++) {
      if (fetched[i] === undefined) return passthrough('union source unavailable');
      pages[indices[i]] = fetched[i] ?? null;
    }
  }

  const template = pages.find((page): page is FeedPage => page !== null);
  if (!template) return passthrough('union has no source page');
  const ranked: Array<{ item: any; rank: number; source: number }> = [];
  const firstTagIndex = new Map(tags.map((tag, index) => [tag, index]));
  for (let index = 0; index < tags.length; index++) {
    const page = pages[index];
    if (!page) continue;
    for (let rank = 0; rank < page.node.items.length; rank++) {
      const item = page.node.items[rank];
      if (!Array.isArray(item?.tagIds)) return passthrough('feed items carry no tagIds');
      let owner = Infinity;
      for (const id of item.tagIds) owner = Math.min(owner, firstTagIndex.get(id) ?? Infinity);
      if (owner === index && matchesFilter(item, [], negativeSet, facets))
        ranked.push({ item, rank, source: index });
    }
    cursors[index] = page.node.nextCursor ?? null;
  }

  // The site does not expose a common score for every sort. Interleave each source's
  // native ranking, keeping its internal order and avoiding a first-tag-only page.
  ranked.sort((a, b) => a.rank - b.rank || a.source - b.source);
  const matches = ranked.map(({ item }) => item);
  template.node.items = matches;
  template.node.nextCursor = cursors.some((cursor) => cursor != null)
    ? UNION_CURSOR_PREFIX + JSON.stringify({ signature, cursors })
    : null;
  if (template.envelope.transport === 'superjson') rebuildItemMeta(template.envelope.root, matches);
  return encodeFeedEnvelope(template.body, template.envelope);
}

function unionSignature(tags: number[], query: any): string {
  const input = { ...query?.json };
  delete input.cursor;
  const source = JSON.stringify([location.pathname, location.search, tags, input]);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function filterNativePages(
  originalFetch: typeof fetch,
  u: URL,
  parsed: any,
  query: any,
  batch: boolean,
  negativeSet: Set<number>,
  facets: FeedFacetFilter
): Promise<string | null> {
  const matches: any[] = [];
  const seen = new Set<number>();
  const tags: number[] = Array.isArray(query?.json?.tags) ? query.json.tags : [];
  const limit = typeof query?.json?.limit === 'number' ? query.json.limit : 100;
  let cursor: unknown = query?.json?.cursor ?? null;
  let template: FeedPage | null = null;

  for (let pageIndex = 0; pageIndex < MAX_EXTRA_FETCHES && matches.length < FILL_TARGET; pageIndex++) {
    const href = pageIndex === 0 ? u.href : withTags(u, parsed, batch, tags, cursor, limit);
    let body: any;
    try {
      const response = await originalFetch(href, {
        headers: { accept: 'application/json' },
        credentials: 'include',
      });
      if (!response.ok) break;
      body = await response.json();
    } catch {
      break;
    }
    const page = decodeFeedPage(body, batch);
    if (!page) break;
    // Without tagIds we cannot exclude anything, and silently returning the unfiltered
    // page reads as "the negative filter did nothing". Say so, like the AND walk does.
    if (template === null && negativeSet.size > 0 && lacksTagIds(page.node.items))
      return passthrough('feed items carry no tagIds');
    template ??= page;
    collectMatches(page.node, [], negativeSet, facets, matches, seen);
    cursor = page.node.nextCursor;
    if (cursor == null) break;
  }

  if (!template) return null;
  template.node.items = matches;
  template.node.nextCursor = cursor ?? null;
  if (template.envelope.transport === 'superjson') rebuildItemMeta(template.envelope.root, matches);
  return encodeFeedEnvelope(template.body, template.envelope);
}

/** Collect items matching all positive groups and no negative tags, deduped by image id. */
function collectMatches(
  node: any,
  groups: number[][],
  negativeSet: Set<number>,
  facets: FeedFacetFilter,
  matches: any[],
  seen: Set<number>
): void {
  for (const it of node.items) {
    if (!matchesFilter(it, groups, negativeSet, facets)) continue;
    const id = typeof it?.id === 'number' ? it.id : NaN;
    if (Number.isNaN(id) || seen.has(id)) continue;
    seen.add(id);
    matches.push(it);
  }
}

/** True when a page has items but none carries the `tagIds` array we filter on. */
function lacksTagIds(items: any[]): boolean {
  return items.length > 0 && !items.some((it: any) => Array.isArray(it?.tagIds));
}

function matchesFilter(
  it: any,
  groups: number[][],
  negativeSet: Set<number>,
  facets: FeedFacetFilter
): boolean {
  const idSet = new Set<number>(Array.isArray(it?.tagIds) ? it.tagIds : []);
  for (const id of negativeSet) {
    if (idSet.has(id)) return false;
  }
  for (const group of groups) {
    if (!group.some((id) => idSet.has(id))) return false;
  }
  return matchesFeedFacets(it, facets);
}

/**
 * Log-and-pass-through. Every silent fallback to native tag matching has already cost a debugging
 * session once ("filter melts down into OR") — name the reason where it happens, and tell
 * the isolated-world content script so it can toast the user (MAIN world can't import the
 * site-health module; the detail is a JSON STRING because plain objects don't reliably
 * cross Chrome's world boundary).
 */
function passthrough(reason: string): null {
  console.debug(`[cllp tag-filter] passing through to native matching: ${reason}`);
  try {
    window.dispatchEvent(
      new CustomEvent('cllp:sitehealth', {
        detail: JSON.stringify({
          key: `and-or-fallback:${reason}`,
          message: `Tag filter fell back to CivitAI's native multi-tag behavior (${reason}). Group matching may be wrong.`,
        }),
      })
    );
  } catch {
    /* feedback is best-effort */
  }
  return null;
}

function shouldFilterFeed(search: string): boolean {
  const sp = new URLSearchParams(search);
  return (
    sp.get(MODE_PARAM) === 'all' ||
    sp.get(MODE_PARAM) === 'any' ||
    sp.has(TAG_GROUPS_PARAM) ||
    sp.has(NEGATIVE_TAG_PARAM) ||
    FEED_FACET_PARAMS.some((param) => sp.has(param))
  );
}

function positiveGroupsFromSearch(search: string, fallback: number[]): number[][] {
  const sp = new URLSearchParams(search);
  const groups = sp
    .getAll(TAG_GROUPS_PARAM)
    .map((raw) => uniquePositiveInts(raw.split(',').map((v) => Number(v))))
    .filter((group) => group.length > 0);
  if (!groups.length) return uniquePositiveInts(fallback).map((id) => [id]);

  const grouped = new Set(groups.flat());
  for (const id of uniquePositiveInts(fallback)) {
    if (!grouped.has(id)) groups.push([id]);
  }
  return groups;
}

function parseTagList(search: string, param: string): number[] {
  return uniquePositiveInts(new URLSearchParams(search).getAll(param).map((v) => Number(v)));
}

function uniquePositiveInts(values: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** The envelope root (unwraps the batched array form). */
function rootOf(body: any, batch: boolean): any {
  return batch ? (Array.isArray(body) ? body[0] : body) : body;
}

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Decode either CivitAI feed transport:
 *
 * - Current responses put a devalue-flattened JSON string in `result.data`.
 * - Older responses used tRPC's SuperJSON-shaped `result.data.{json,meta}` envelope.
 *
 * Keep both paths because civitai.com and civitai.red may roll backend changes at different
 * times, and falling back to native matching during a staggered rollout would change group semantics.
 */
export function decodeFeedEnvelope(body: any, batch: boolean): DecodedFeedEnvelope | null {
  const root = rootOf(body, batch);
  const data = root?.result?.data;

  if (typeof data === 'string') {
    try {
      const node = parseDevalue(data);
      if (!node || typeof node !== 'object') return null;
      return { root, node, transport: 'devalue' };
    } catch {
      return null;
    }
  }

  const node = data?.json;
  if (!node || typeof node !== 'object') return null;
  return { root, node, transport: 'superjson' };
}

/** Re-encode a decoded feed node in the same transport shape the page requested. */
export function encodeFeedEnvelope(body: any, envelope: DecodedFeedEnvelope): string {
  if (envelope.transport === 'devalue') {
    envelope.root.result.data = stringifyDevalue(envelope.node);
  }
  return JSON.stringify(body);
}

/**
 * Decode a feed page and prepare any legacy SuperJSON item metadata for filtering/reordering.
 * Devalue tracks types and shared references while re-stringifying the final object, so it
 * needs no positional marker bookkeeping.
 */
function decodeFeedPage(body: any, batch: boolean): FeedPage | null {
  const envelope = decodeFeedEnvelope(body, batch);
  if (!envelope || !Array.isArray(envelope.node.items)) return null;
  if (envelope.transport === 'superjson') {
    inlineRefs(envelope.root);
    harvestItemMeta(envelope.root, envelope.node);
  }
  return { body, envelope, node: envelope.node };
}

/**
 * Inline superjson's shared-reference dedup (`referentialEqualities`) into the items so each
 * item is self-contained, then drop it. Those entries identify duplicate objects (e.g. the
 * same user cosmetic across many items) by absolute item index — which goes stale the moment
 * we filter/reorder, causing the client's deserialize to throw ("Unable to transform response").
 */
export function inlineRefs(root: any): void {
  const meta = root?.result?.data?.meta;
  const json = root?.result?.data?.json;
  if (!meta?.referentialEqualities || !json) return;
  for (const [canon, dupes] of Object.entries(meta.referentialEqualities)) {
    const val = getByPath(json, canon);
    if (val === undefined) continue;
    for (const d of Array.isArray(dupes) ? dupes : [dupes as string]) {
      setByPath(json, d, structuredClone(val));
      // Typed markers under the canonical path apply to the clone too — mirror them so the
      // dupe's fields deserialize with the same types (superjson resolved refs after transforms).
      if (meta.values) {
        for (const [k, v] of Object.entries(meta.values)) {
          if (k === canon || k.startsWith(`${canon}.`)) {
            meta.values[d + k.slice(canon.length)] = structuredClone(v);
          }
        }
      }
    }
  }
  delete meta.referentialEqualities;
}

export function getByPath(obj: any, path: string): any {
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function setByPath(obj: any, path: string, val: any): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return;
    cur = cur[parts[i]];
  }
  if (cur != null) cur[parts[parts.length - 1]] = val;
}

/**
 * Detach each `items.<i>.<path>` superjson marker from a page's meta and attach it to the
 * item object itself (via the itemMarkers WeakMap), so filtering/reordering — including
 * pulling items from several cursor pages — can't desync markers from their items. Must run
 * after inlineRefs (which may add mirrored markers for shared-ref clones).
 */
export function harvestItemMeta(root: any, node: any): void {
  const values = root?.result?.data?.meta?.values;
  if (!values || !Array.isArray(node?.items)) return;
  for (const [k, v] of Object.entries(values)) {
    const m = /^items\.(\d+)\.(.+)$/.exec(k);
    if (!m) continue;
    const it = node.items[Number(m[1])];
    if (it && typeof it === 'object') {
      let rec = itemMarkers.get(it);
      if (!rec) itemMarkers.set(it, (rec = {}));
      rec[m[2]] = v;
    }
  }
}

/**
 * Regenerate the superjson `items.*` meta markers to match a replaced items array, re-emitting
 * each surviving item's harvested markers ('undefined', Date, bigint, … — copied verbatim) at
 * the item's new index. Non-item meta entries from the template page stay untouched.
 */
export function rebuildItemMeta(root: any, items: any[]): void {
  const data = root?.result?.data;
  if (!data) return;
  // Shared-ref dedup was inlined per page; ensure none of its stale index paths survive.
  if (data.meta?.referentialEqualities) delete data.meta.referentialEqualities;
  const kept: Record<string, unknown> = {};
  if (data.meta?.values) {
    for (const [k, v] of Object.entries(data.meta.values)) {
      if (!/^items\./.test(k)) kept[k] = v;
    }
  }
  items.forEach((it, i) => {
    const rec = it && typeof it === 'object' ? itemMarkers.get(it) : undefined;
    if (!rec) return;
    for (const [path, v] of Object.entries(rec)) kept[`items.${i}.${path}`] = v;
  });
  if (Object.keys(kept).length) {
    data.meta = { ...(data.meta ?? {}), values: kept };
  } else if (data.meta?.values) {
    delete data.meta.values;
  }
}

/** Build a same-endpoint URL with the input's tags/cursor/limit overridden. */
function withTags(
  u: URL,
  parsed: any,
  batch: boolean,
  tags: number[],
  cursor: unknown,
  limit: number
): string {
  const clone = JSON.parse(JSON.stringify(parsed));
  const query = batch ? clone['0'] : clone;
  query.json = { ...query.json, tags, limit };
  if (cursor == null) delete query.json.cursor;
  else query.json.cursor = cursor;
  // Drop any superjson meta marking cursor as undefined (we set concrete values).
  if (query.meta?.values && 'cursor' in query.meta.values) delete query.meta.values.cursor;
  const out = new URL(u.href);
  out.searchParams.set('input', JSON.stringify(clone));
  return out.href;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return '';
}

function method(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}
