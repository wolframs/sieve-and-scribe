/**
 * Feed tag-filter data layer.
 *
 * CivitAI's /images and /videos *feeds* have no free-text tag filter UI, but the
 * feed URL accepts repeated `?tags=<id>&tags=<id>` numeric tag IDs. This module
 * resolves tag names → numeric IDs via CivitAI's own tRPC endpoint, builds the
 * filter URL, and caches tag data in WXT storage.
 *
 * The feed currently intersects repeated `tags=` IDs (verified live in September 2026).
 * Our MAIN-world interceptor (entrypoints/civitai-and.content.ts) synthesizes unions
 * for OR groups and applies AND between groups. This module owns URL/data plumbing.
 *
 * All requests are same-origin (the content script runs on civitai.com) and use the
 * user's cookies. Works logged-out too (it's the public filter autocomplete).
 */
import { feedPopularTagsStorage, feedTagNamesStorage } from './storage';
import type { FeedFacetFilter } from './feed-facets';
import {
  uniquePositiveInts,
  type FeedTag,
  type FeedTagBundle,
  type TagMode,
} from './feed-filter-url';

// The URL contract lives in feed-filter-url.ts (pure, MAIN-world safe); re-exported here so
// existing imports keep working.
export * from './feed-filter-url';
import {
  // Direct IndexedDB access is only used to read/delete the LEGACY page-origin DB during
  // migration. All live corpus access goes through the background RPC (shared DB).
  getPopularMeta as getLocalPageDbMeta,
  readAllStoredFeedTags as readLocalPageDbTags,
  deleteTagDatabase as deleteLocalPageDb,
  type PopularTagDbMeta,
} from './feed-tag-db';
import {
  rpcAcquireSyncLease,
  rpcCountFeedTags,
  rpcGetFeedTagsByIds,
  rpcGetPopularMeta,
  rpcGetSyncStatus,
  rpcGetTopFeedTags,
  rpcImportStoredFeedTags,
  rpcPruneFeedTagsUpdatedBefore,
  rpcReleaseSyncLease,
  rpcSearchCachedFeedTags,
  rpcSetPopularMeta,
  rpcUpsertFeedTags,
  TAGDB_STATUS_BROADCAST,
  type TagDbStatusBroadcast,
} from './feed-tag-rpc';

export type FeedTagHealthIssueKind = 'unresolved' | 'duplicate-name' | 'name-noise';

export interface FeedTagHealthIssue {
  id: number;
  kind: FeedTagHealthIssueKind;
  label: string;
}

/**
 * Move one positive tag between OR groups.
 *
 * `targetGroupIndex === null` splits the tag into its own standalone AND group. The target
 * group is captured before the source is removed so moving a singleton cannot invalidate a
 * later target index.
 */
export function moveFeedTagBetweenGroups(
  groups: FeedTag[][],
  tagId: number,
  targetGroupIndex: number | null
): FeedTag[][] {
  const sourceGroupIndex = groups.findIndex((group) => group.some((tag) => tag.id === tagId));
  if (sourceGroupIndex === -1) return groups.map((group) => [...group]);
  if (targetGroupIndex !== null && !groups[targetGroupIndex]) {
    return groups.map((group) => [...group]);
  }
  if (targetGroupIndex === sourceGroupIndex) return groups.map((group) => [...group]);
  if (targetGroupIndex === null && groups[sourceGroupIndex].length === 1) {
    return groups.map((group) => [...group]);
  }

  const next = groups.map((group) => [...group]);
  const tag = next[sourceGroupIndex].find((candidate) => candidate.id === tagId)!;
  const target = targetGroupIndex === null ? null : next[targetGroupIndex];
  next[sourceGroupIndex] = next[sourceGroupIndex].filter((candidate) => candidate.id !== tagId);

  if (target) target.push(tag);
  else next.push([tag]);
  return next.filter((group) => group.length > 0);
}

/** Merge one complete positive OR group into another, preserving target-first tag order. */
export function mergeFeedTagGroups(
  groups: FeedTag[][],
  sourceGroupIndex: number,
  targetGroupIndex: number
): FeedTag[][] {
  if (
    sourceGroupIndex === targetGroupIndex ||
    !groups[sourceGroupIndex] ||
    !groups[targetGroupIndex]
  ) {
    return groups.map((group) => [...group]);
  }

  const target = groups[targetGroupIndex];
  const source = groups[sourceGroupIndex];
  return groups
    .map((group, index) =>
      index === targetGroupIndex ? [...target, ...source] : [...group]
    )
    .filter((_group, index) => index !== sourceGroupIndex);
}

const TAG_LOG_PREFIX = '[CLLP tags]';

function tagLog(message: string, detail?: unknown): void {
  if (detail === undefined) console.log(TAG_LOG_PREFIX, message);
  else console.log(TAG_LOG_PREFIX, message, detail);
}

function tagWarn(message: string, detail?: unknown): void {
  if (detail === undefined) console.warn(TAG_LOG_PREFIX, message);
  else console.warn(TAG_LOG_PREFIX, message, detail);
}

/**
 * Reject user-noise tag variants the autocomplete is full of: empty names, names ending in
 * separator punctuation ("forest,", "orgasm -"), or carrying control/backslash/section
 * junk ("orgasm\\", "forest§"). Parentheses/brackets are allowed because CivitAI has real
 * disambiguated tags such as character/source names ending in `)`. We drop `entityType:['Image']`
 * from the queries below
 * because — verified live — it silently erases legit moderated tags (e.g. "orgasm",
 * a perfectly valid feed filter). That filter was really just a noise gate, so we
 * replace it with this lightweight client-side clean instead, keeping the moderated tags.
 */
// `!`/`?` can be legit trailing chars (e.g. "yu-gi-oh!"), and `)`/`]` can be legit
// disambiguators, so they're not in the trailing set.
const TAG_NOISE = /[\\§]|[\s,.;:'"\-]$/;
const TAG_HARD_NOISE = /[\\§\u0000-\u001f\u007f]/;
export function isCleanTagName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !TAG_NOISE.test(n);
}

/** Find configuration problems worth reviewing without mutating the selected tags. */
export function findFeedTagHealthIssues(tags: FeedTag[]): FeedTagHealthIssue[] {
  const issues: FeedTagHealthIssue[] = [];
  const names = new Map<string, FeedTag[]>();
  for (const tag of tags) {
    const name = tag.name.trim();
    const normalized = name.toLocaleLowerCase();
    if (normalized) names.set(normalized, [...(names.get(normalized) ?? []), tag]);
    if (name === `#${tag.id}` || name === String(tag.id)) {
      issues.push({ id: tag.id, kind: 'unresolved', label: 'Name unresolved' });
    } else if (!isCleanTagName(name)) {
      issues.push({ id: tag.id, kind: 'name-noise', label: 'Suspicious punctuation' });
    }
  }
  for (const matches of names.values()) {
    if (matches.length < 2 || new Set(matches.map((tag) => tag.id)).size < 2) continue;
    matches.forEach((tag) => issues.push({
      id: tag.id,
      kind: 'duplicate-name',
      label: 'Duplicate visible name',
    }));
  }
  return issues;
}

function isPlausibleTagName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && !TAG_HARD_NOISE.test(n);
}


/**
 * Resolve a tag-name query to numeric tag IDs via tRPC `tag.getAll`.
 * No `entityType` filter (it hides moderated tags — see isCleanTagName); we ask for a
 * generous limit to leave headroom for CivitAI ranking quirks and client-side denoise.
 */
export async function searchFeedTags(query: string, signal?: AbortSignal): Promise<FeedTag[]> {
  const q = query.trim();
  if (!q) return [];
  const variants = tagQueryVariants(q);
  tagLog('live lookup started', { query: q, variants });
  const responses = await Promise.allSettled(variants.map((v) => fetchTagQuery(v, signal)));
  const merged: FeedTag[] = [];
  const seen = new Set<number>();
  const summary: Array<{ query: string; count?: number; error?: string }> = [];
  for (const [i, response] of responses.entries()) {
    if (response.status !== 'fulfilled') {
      summary.push({ query: variants[i], error: response.reason instanceof Error ? response.reason.message : String(response.reason) });
      continue;
    }
    summary.push({ query: variants[i], count: response.value.length });
    for (const tag of response.value) {
      if (seen.has(tag.id)) continue;
      seen.add(tag.id);
      merged.push(tag);
    }
  }
  merged.sort((a, b) => tagMatchScore(a.name, q) - tagMatchScore(b.name, q));
  await rememberTagNames(merged);
  tagLog('live lookup finished', {
    query: q,
    results: merged.length,
    variants: summary,
    top: merged.slice(0, 5),
  });
  return merged;
}

export async function searchCachedFeedTags(query: string, limit: number): Promise<FeedTag[]> {
  const q = query.trim();
  const started = performance.now();
  const tags = await rpcSearchCachedFeedTags(q, limit);
  tagLog('cached lookup finished', {
    query: q || '(browse)',
    limit,
    results: tags.length,
    ms: Math.round(performance.now() - started),
    top: tags.slice(0, 5),
  });
  return tags;
}

function tagQueryVariants(query: string): string[] {
  const variants = new Set<string>();
  const add = (v: string) => {
    const trimmed = v.trim();
    if (trimmed) variants.add(trimmed);
  };
  add(query);
  add(query.replace(/_/g, ' '));
  add(query.replace(/\s+/g, '_'));
  add(query.replace(/-/g, ' '));
  add(query.replace(/\s*\([^)]*\)\s*$/, ''));
  return [...variants].slice(0, 5);
}

async function fetchTagQuery(query: string, signal?: AbortSignal): Promise<FeedTag[]> {
  const input = encodeURIComponent(JSON.stringify({ json: { query, limit: 100 } }));
  const res = await fetch(`/api/trpc/tag.getAll?input=${input}`, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    tagWarn('live lookup request failed', { query, status: res.status });
    return [];
  }
  const data = await res.json().catch(() => null);
  const items: unknown = data?.result?.data?.json?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((t: any) => typeof t?.id === 'number' && typeof t?.name === 'string' && isPlausibleTagName(t.name))
    .map((t: any) => ({ id: t.id as number, name: t.name as string }));
}

function tagMatchScore(name: string, query: string): number {
  const n = normalizeTagText(name);
  const q = normalizeTagText(query);
  if (n === q) return 0;
  if (n.replace(/_/g, ' ') === q.replace(/_/g, ' ')) return 1;
  if (n.startsWith(q)) return 2;
  if (n.includes(q)) return 3;
  return 4;
}

function normalizeTagText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// --- bulk popular-tag preload + local filtering (instant autocomplete) ---

// v5 = IndexedDB corpus with small WXT migration metadata; v6 = rank-preserving upserts —
// the bump forces one full (non-destructive) resync to heal ranks corroded by pre-v6
// live-lookup clobbering.
const POPULAR_VERSION = 6;
const POPULAR_TTL = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const PAGE_LIMIT = 200; // server caps tag.getAll at 200; paginate for more
const INITIAL_PAGES = 6; // seed quickly on a cold cache, then continue in the background
const MAX_PAGES = 650; // → up to ~130k raw tags, enough for CivitAI's 120k+ tag universe
const POPULAR_TARGET = 125000;
const CHECKPOINT_EVERY_PAGES = 25;
const TOP_TAGS_LIMIT = 200;
let popularRefreshPromise: Promise<PopularTagDbMeta> | null = null;

export interface PopularTagCacheStatus {
  count: number;
  pages: number;
  target: number;
  complete: boolean;
  syncing: boolean;
}

const popularCacheListeners = new Set<(status: PopularTagCacheStatus) => void>();
let statusBroadcastHooked = false;

/** Reflect background-broadcast meta changes (e.g. another tab syncing) into local listeners. */
function hookStatusBroadcast(): void {
  if (statusBroadcastHooked) return;
  statusBroadcastHooked = true;
  browser.runtime.onMessage.addListener((msg: unknown) => {
    const b = msg as TagDbStatusBroadcast;
    if (!b || b.type !== TAGDB_STATUS_BROADCAST) return;
    notifyPopularCache(b.meta, b.syncing || !!popularRefreshPromise);
  });
}

export function watchPopularTagCache(
  listener: (status: PopularTagCacheStatus) => void
): () => void {
  hookStatusBroadcast();
  popularCacheListeners.add(listener);
  getPopularTagCacheStatus().then(listener).catch(() => {});
  return () => {
    popularCacheListeners.delete(listener);
  };
}

export async function getPopularTagCacheStatus(): Promise<PopularTagCacheStatus> {
  await ensureTagDbMigrations();
  const { meta, syncing } = await rpcGetSyncStatus();
  const status = popularCacheStatus(meta, syncing || !!popularRefreshPromise);
  tagLog('cache status read', status);
  return status;
}

function notifyPopularCache(cache: PopularTagDbMeta, syncing = !!popularRefreshPromise) {
  const status = popularCacheStatus(cache, syncing);
  tagLog('cache status changed', status);
  for (const listener of popularCacheListeners) listener(status);
}

function popularCacheStatus(
  cache: PopularTagDbMeta,
  syncing: boolean
): PopularTagCacheStatus {
  return {
    count: cache.count,
    pages: cache.pages,
    target: POPULAR_TARGET,
    complete: !!cache.complete || cache.count >= POPULAR_TARGET,
    syncing,
  };
}

/**
 * Load a large list of the most-used image tags, cached in WXT storage (weekly TTL).
 * Filtering this locally is instant — unlike the per-keystroke live lookup. Paginates
 * because tag.getAll caps `limit` at 200. Honours `signal` so an in-flight warm aborts
 * cleanly when the user navigates away.
 */
export async function loadPopularTags(signal?: AbortSignal): Promise<FeedTag[]> {
  await ensureTagDbMigrations();
  const cached = await rpcGetPopularMeta();
  const sameVersion = cached.v === POPULAR_VERSION;
  const fresh = sameVersion && Date.now() - cached.ts < POPULAR_TTL;
  const completeEnough = !!cached.complete || cached.count >= POPULAR_TARGET;
  tagLog('popular cache load decision', {
    meta: popularCacheStatus(cached, !!popularRefreshPromise),
    expectedVersion: POPULAR_VERSION,
    sameVersion,
    fresh,
    completeEnough,
  });

  if (fresh && cached.count && completeEnough) {
    tagLog('popular cache is fresh and complete enough; using IndexedDB only');
    return rpcGetTopFeedTags(TOP_TAGS_LIMIT);
  }

  // Stale or older-version data is still good enough for instant local autocomplete.
  // Refresh it in the background instead of making the UI wait for hundreds of pages.
  // `restart` re-walks from page 1 but never clears — see refreshPopularTags.
  if (cached.count) {
    tagLog('popular cache is usable but needs background sync');
    startPopularRefresh(cached, signal, { restart: !sameVersion || (!fresh && completeEnough) });
    return rpcGetTopFeedTags(TOP_TAGS_LIMIT);
  }

  // Empty cache: fetch a small blocking seed so the first open isn't blank, then keep filling
  // the large corpus in the background.
  tagLog('popular cache is empty; fetching initial seed', { pages: INITIAL_PAGES });
  const seeded = await refreshPopularTags(cached, signal, { restart: true, maxPagesToFetch: INITIAL_PAGES });
  if (!seeded.complete) startPopularRefresh(seeded, signal);
  return rpcGetTopFeedTags(TOP_TAGS_LIMIT);
}

let migrationPromise: Promise<void> | null = null;

/** All one-time cache migrations, memoized per page load and safe to re-run. */
function ensureTagDbMigrations(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await migrateStoredPopularTags();
      await migratePageOriginTagDb();
    })().catch((err) => {
      tagWarn('tag cache migration failed', err instanceof Error ? err.message : err);
    });
  }
  return migrationPromise;
}

const PAGE_DB_MIGRATED_FLAG = 'cllpTagDbMovedToBackground';

/**
 * One-time move of this page-origin's IndexedDB corpus (the pre-shared-DB layout, where
 * civitai.com and civitai.red each had their own) into the background extension-origin DB.
 * The larger corpus wins; the page-origin DB is deleted afterwards.
 */
async function migratePageOriginTagDb(): Promise<void> {
  try {
    if (localStorage.getItem(PAGE_DB_MIGRATED_FLAG)) return;
  } catch {
    /* localStorage unavailable — fall through and rely on the DB-existence check */
  }
  // Don't create an empty page-origin DB just to look inside it.
  if (typeof indexedDB.databases === 'function') {
    const dbs = await indexedDB.databases().catch(() => null);
    if (dbs && !dbs.some((d) => d.name === 'cllp-feed-tags')) {
      try {
        localStorage.setItem(PAGE_DB_MIGRATED_FLAG, '1');
      } catch { /* non-fatal */ }
      return;
    }
  }

  const [localMeta, localRows] = await Promise.all([getLocalPageDbMeta(), readLocalPageDbTags()]);
  if (localRows.length) {
    const backgroundCount = await rpcCountFeedTags();
    if (localRows.length > backgroundCount) {
      tagLog('moving page-origin tag corpus into the shared background DB', {
        origin: location.origin,
        rows: localRows.length,
        backgroundCount,
      });
      for (let i = 0; i < localRows.length; i += 4000) {
        await rpcImportStoredFeedTags(localRows.slice(i, i + 4000));
      }
      const backgroundMeta = await rpcGetPopularMeta();
      if (localMeta.count > backgroundMeta.count || (localMeta.complete && !backgroundMeta.complete)) {
        await rpcSetPopularMeta({
          v: localMeta.v,
          ts: localMeta.ts,
          pages: localMeta.pages,
          complete: localMeta.complete,
          refreshStartedTs: localMeta.refreshStartedTs,
        });
      }
    } else {
      tagLog('shared background DB already has at least as many tags; skipping import', {
        origin: location.origin,
        rows: localRows.length,
        backgroundCount,
      });
    }
  }
  await deleteLocalPageDb();
  try {
    localStorage.setItem(PAGE_DB_MIGRATED_FLAG, '1');
  } catch { /* non-fatal */ }
}

async function migrateStoredPopularTags(): Promise<void> {
  const stored = await feedPopularTagsStorage.getValue();
  if (stored.indexedDb && stored.v === POPULAR_VERSION && !stored.tags?.length) return;

  if (stored.tags?.length) {
    tagLog('migrating WXT popular-tag blob into IndexedDB', {
      tags: stored.tags.length,
      pages: stored.pages,
      complete: !!stored.complete,
    });
    await rpcUpsertFeedTags(stored.tags, 0);
    const meta = await rpcSetPopularMeta({
      v: POPULAR_VERSION,
      ts: stored.ts || Date.now(),
      pages: stored.pages ?? Math.ceil(stored.tags.length / PAGE_LIMIT),
      complete: !!stored.complete || stored.tags.length >= POPULAR_TARGET,
    });
    notifyPopularCache(meta, false);
  }

  tagLog('marking WXT popular-tag cache as IndexedDB-backed', {
    previousVersion: stored.v,
    hadLegacyBlob: !!stored.tags?.length,
  });
  await feedPopularTagsStorage.setValue({
    v: POPULAR_VERSION,
    ts: Date.now(),
    pages: stored.pages ?? 0,
    complete: !!stored.complete,
    indexedDb: true,
  });
}

function startPopularRefresh(
  cached: PopularTagDbMeta,
  signal?: AbortSignal,
  options: { restart?: boolean } = {}
) {
  if (popularRefreshPromise) return;
  tagLog('popular cache sync started', {
    from: popularCacheStatus(cached, true),
    restart: !!options.restart,
  });
  notifyPopularCache(cached, true);
  popularRefreshPromise = refreshPopularTags(cached, signal, options)
    .then((cache) => {
      tagLog('popular cache sync finished', popularCacheStatus(cache, false));
      notifyPopularCache(cache, false);
      return cache;
    })
    .catch((err) => {
      // e.g. the sync lease was lost to another tab mid-walk — stop quietly.
      tagWarn('popular cache sync stopped', err instanceof Error ? err.message : err);
      notifyPopularCache(cached, false);
      return cached;
    })
    .finally(() => {
      popularRefreshPromise = null;
    });
}

/**
 * Sync the corpus from tag.getAll. NEVER clears up front: a restart re-walks from page 1,
 * upserting rows in place, and rows the walk didn't touch are pruned only once the walk
 * completes (refreshStartedTs, persisted in meta so an interrupted walk resumes across
 * page loads and still prunes correctly at the end). A cross-tab lease in the background
 * ensures only one tab does this at a time.
 */
async function refreshPopularTags(
  cached: PopularTagDbMeta,
  signal?: AbortSignal,
  options: { restart?: boolean; maxPagesToFetch?: number } = {}
): Promise<PopularTagDbMeta> {
  const lease = await rpcAcquireSyncLease();
  if (!lease.granted || !lease.token) {
    tagLog('another tab holds the sync lease; skipping this sync');
    return cached;
  }
  try {
    return await runPopularRefresh(cached, lease.token, signal, options);
  } finally {
    await rpcReleaseSyncLease(lease.token).catch(() => {});
  }
}

async function runPopularRefresh(
  cached: PopularTagDbMeta,
  leaseToken: string,
  signal?: AbortSignal,
  options: { restart?: boolean; maxPagesToFetch?: number } = {}
): Promise<PopularTagDbMeta> {
  const sameVersion = cached.v === POPULAR_VERSION;
  const restart = options.restart || !sameVersion;
  let refreshStartedTs = restart ? Date.now() : cached.refreshStartedTs;
  let meta = restart
    ? await rpcSetPopularMeta(
        { v: POPULAR_VERSION, ts: Date.now(), pages: 0, complete: false, refreshStartedTs },
        leaseToken
      )
    : cached;
  const seen = new Set<number>();
  let pages = restart ? 0 : cached.pages;
  const firstPage = pages + 1;
  const lastPage = Math.min(MAX_PAGES, firstPage + (options.maxPagesToFetch ?? MAX_PAGES) - 1);
  let complete = false;
  let pendingNames: FeedTag[] = [];

  for (let page = firstPage; page <= lastPage; page++) {
    if (signal?.aborted) return meta;
    const input = encodeURIComponent(
      JSON.stringify({
        // NB: sort "Most Images" is silently ignored here (returns name-sorted junk);
        // "Most Models" is the working popularity sort that returns real ranked tags.
        // No `entityType` — it excludes moderated tags from the corpus (see isCleanTagName).
        json: {
          sort: 'Most Models',
          unlisted: false,
          categories: false,
          limit: PAGE_LIMIT,
          page,
        },
      })
    );
    let items: any[] = [];
    try {
      const r = await fetch(`/api/trpc/tag.getAll?input=${input}`, {
        headers: { accept: 'application/json' },
        signal,
      });
      if (!r.ok) {
        tagWarn('popular cache page request failed', { page, status: r.status });
        break;
      }
      items = (await r.json())?.result?.data?.json?.items ?? [];
    } catch {
      tagWarn('popular cache page request errored or aborted', { page });
      break; // network error or abort — return whatever we accumulated
    }
    if (!items.length) {
      tagLog('popular cache reached empty page', { page });
      break;
    }
    pages = page;
    const pageTags: FeedTag[] = [];
    for (const t of items) {
      if (
        typeof t?.id === 'number' &&
        typeof t?.name === 'string' &&
        isCleanTagName(t.name) &&
        !seen.has(t.id)
      ) {
        seen.add(t.id);
        const tag = { id: t.id, name: t.name };
        pageTags.push(tag);
        pendingNames.push(tag);
      }
    }
    if (pageTags.length) await rpcUpsertFeedTags(pageTags, (page - 1) * PAGE_LIMIT);
    complete = items.length < PAGE_LIMIT || page >= MAX_PAGES;
    meta = await rpcSetPopularMeta(
      { v: POPULAR_VERSION, ts: Date.now(), pages, complete, refreshStartedTs },
      leaseToken
    );
    if (meta.count >= POPULAR_TARGET && !meta.complete) {
      complete = true;
      meta = await rpcSetPopularMeta({ ...meta, complete: true }, leaseToken);
    }
    if (
      complete ||
      page === firstPage ||
      page === lastPage ||
      page % CHECKPOINT_EVERY_PAGES === 0
    ) {
      tagLog('popular cache checkpoint', {
        page,
        rawItems: items.length,
        accepted: pageTags.length,
        status: popularCacheStatus(meta, true),
      });
      notifyPopularCache(meta, true);
      if (pendingNames.length) {
        await rememberTagNames(pendingNames);
        pendingNames = [];
      }
    }
    if (complete) break;
  }

  // Full walk finished: now (and only now) drop rows the walk never touched — tags that
  // no longer exist upstream or fell out of the ranked corpus. An interrupted walk keeps
  // everything and prunes on a later completion instead.
  if (complete && refreshStartedTs) {
    try {
      const removed = await rpcPruneFeedTagsUpdatedBefore(refreshStartedTs);
      if (removed) tagLog('pruned stale tags after completed resync', { removed });
    } catch (err) {
      tagWarn('stale-tag prune failed (corpus kept as-is)', err instanceof Error ? err.message : err);
    }
    meta = await rpcSetPopularMeta(
      { v: POPULAR_VERSION, ts: meta.ts, pages: meta.pages, complete: meta.complete },
      leaseToken
    );
  }

  return meta;
}

/** Filter a tag list locally (instant). Empty query → the top of the list (browse mode). */
export function localFilterTags(list: FeedTag[], query: string, limit = 12): FeedTag[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const matches: FeedTag[] = [];
  for (const t of list) {
    if (t.name.toLowerCase() === q) {
      matches.push(t);
      if (matches.length >= limit) return matches;
    }
  }
  for (const t of list) {
    const n = t.name.toLowerCase();
    if (n !== q && n.startsWith(q)) {
      matches.push(t);
      if (matches.length >= limit) return matches;
    }
  }
  for (const t of list) {
    const n = t.name.toLowerCase();
    if (n !== q && !n.startsWith(q) && n.includes(q)) {
      matches.push(t);
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

// --- id → name cache (so chips restore with names after a full-reload navigation) ---

const NAME_MAP_CAP = 5000; // recent-chip fallback; the large name corpus lives in IndexedDB

/** Merge tags into the persistent id→name map, refreshing recency and pruning to cap. */
export async function rememberTagNames(tags: FeedTag[]): Promise<void> {
  if (!tags.length) return;
  try {
    await rpcUpsertFeedTags(tags);
  } catch (error) {
    // A sleeping/restarting MV3 background must not prevent the independent WXT fallback
    // from retaining names selected in the current page.
    tagWarn('background tag-name cache unavailable; keeping recent-name fallback',
      error instanceof Error ? error.message : error);
  }
  const store = await feedTagNamesStorage.getValue();
  const map = { ...store.map };
  const order = store.order.filter((id) => id in map); // drop any stale ids
  const orderSet = new Set(order);
  for (const t of tags) {
    map[t.id] = t.name;
    if (orderSet.has(t.id)) order.splice(order.indexOf(t.id), 1);
    else orderSet.add(t.id);
    order.push(t.id); // most-recent at the end
  }
  while (order.length > NAME_MAP_CAP) {
    const evicted = order.shift();
    if (evicted !== undefined) delete map[evicted];
  }
  await feedTagNamesStorage.setValue({ v: store.v, ts: Date.now(), map, order });
}

export async function resolveTagNames(ids: number[]): Promise<Map<number, string>> {
  const uniqueIds = uniquePositiveInts(ids);
  let fromDb = new Map<number, string>();
  try {
    fromDb = new Map(await rpcGetFeedTagsByIds(uniqueIds));
  } catch (error) {
    tagWarn('background tag-name lookup unavailable; trying fallbacks',
      error instanceof Error ? error.message : error);
  }
  for (const [id, name] of fromDb) {
    if (name === `#${id}` || name === String(id)) fromDb.delete(id);
  }
  let missing = uniqueIds.filter((id) => !fromDb.has(id));
  if (missing.length) {
    const fallback = await feedTagNamesStorage.getValue();
    for (const id of missing) {
      const name = fallback.map[id];
      if (name && name !== `#${id}` && name !== String(id)) fromDb.set(id, name);
    }
  }
  missing = uniqueIds.filter((id) => !fromDb.has(id));
  if (missing.length) {
    const live = await fetchFeedTagsByIds(missing);
    for (const tag of live) fromDb.set(tag.id, tag.name);
    await rememberTagNames(live);
  }
  return fromDb;
}

/** Resolve long-tail/unlisted IDs omitted by the curated local corpus. */
async function fetchFeedTagsByIds(ids: number[]): Promise<FeedTag[]> {
  const queue = [...ids];
  const found: FeedTag[] = [];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()!;
      const input = encodeURIComponent(JSON.stringify({ json: { id } }));
      try {
        const response = await fetch(`/api/trpc/tag.getById?input=${input}`, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          tagWarn('live tag-id lookup failed', { id, status: response.status });
          continue;
        }
        const value = (await response.json().catch(() => null))?.result?.data?.json;
        if (value?.id === id && typeof value?.name === 'string' && isPlausibleTagName(value.name)) {
          found.push({ id, name: value.name });
        }
      } catch (error) {
        tagWarn('live tag-id lookup errored', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return found;
}

/** Load the full id→name map (hydrated once into the widget for synchronous chip render). */
export async function loadTagNameMap(): Promise<Map<number, string>> {
  const store = await feedTagNamesStorage.getValue();
  const m = new Map<number, string>();
  for (const [id, name] of Object.entries(store.map)) m.set(Number(id), name);
  return m;
}

// --- one-time migration from the old raw-localStorage caches ---

const LEGACY_KEYS = ['cllpPopularTags', 'cllpPopularTags_v2', 'cllpTagNames'];

/**
 * Migrate the previous raw-localStorage caches into WXT storage, then delete the legacy
 * keys (including the orphaned v1 popular-tags key). Idempotent and best-effort.
 */
export async function migrateLegacyCaches(): Promise<void> {
  let legacyPopular: unknown = null;
  let legacyNames: unknown = null;
  try {
    legacyPopular = JSON.parse(localStorage.getItem('cllpPopularTags_v2') || 'null');
    legacyNames = JSON.parse(localStorage.getItem('cllpTagNames') || 'null');
  } catch {
    /* corrupt legacy data — ignore */
  }

  // Popular tags: adopt only if the new cache is still empty.
  if (legacyPopular && Array.isArray((legacyPopular as any).tags)) {
    const tags = (legacyPopular as any).tags as FeedTag[];
    const meta = await rpcGetPopularMeta();
    if (!meta.count && tags.length) {
      tagLog('migrating legacy localStorage popular tags into IndexedDB', {
        tags: tags.length,
      });
      await rpcUpsertFeedTags(tags, 0);
      const next = await rpcSetPopularMeta({
        v: POPULAR_VERSION,
        ts: (legacyPopular as any).ts ?? Date.now(),
        pages: Math.ceil(tags.length / PAGE_LIMIT),
        complete: tags.length >= POPULAR_TARGET,
      });
      notifyPopularCache(next, false);
      await feedPopularTagsStorage.setValue({
        v: POPULAR_VERSION,
        ts: next.ts,
        pages: next.pages,
        complete: next.complete,
        indexedDb: true,
      });
    }
  }

  // Name map: merge any legacy names in (rememberTagNames handles dedupe/prune).
  if (legacyNames && typeof legacyNames === 'object') {
    const tags: FeedTag[] = Object.entries(legacyNames as Record<string, string>)
      .map(([id, name]) => ({ id: Number(id), name }))
      .filter((t) => Number.isInteger(t.id) && typeof t.name === 'string');
    if (tags.length) {
      tagLog('migrating legacy localStorage tag-name map into IndexedDB', { tags: tags.length });
      await rememberTagNames(tags);
    }
  }

  for (const k of LEGACY_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* non-fatal */
    }
  }
}
