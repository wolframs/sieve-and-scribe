/**
 * RPC client for the background-owned tag corpus.
 *
 * The feed-tag IndexedDB used to be opened from the content script, which puts it in the
 * *page's* origin — so civitai.com and civitai.red each had their own (independently cold,
 * independently syncing) corpus, which read as "the cache randomly reset". The DB now lives
 * in the background service worker (extension origin, one shared corpus); content scripts
 * go through these thin message wrappers.
 *
 * The network sync itself still runs in the content script (the tRPC tag endpoints are
 * session-gated and same-origin only) — only storage crosses the process boundary. A
 * background-held sync lease keeps multiple tabs from running duplicate syncs.
 */
import type { FeedTag } from './civitai-feed-tags';
import type { PopularTagDbMeta, StoredFeedTag } from './feed-tag-db';

export const TAGDB_MSG = 'cllp:tagdb';
export const TAGDB_STATUS_BROADCAST = 'cllp:tagdb:status';

export interface TagDbStatusBroadcast {
  type: typeof TAGDB_STATUS_BROADCAST;
  meta: PopularTagDbMeta;
  syncing: boolean;
}

interface RpcOk {
  ok: true;
  result: unknown;
}
interface RpcErr {
  ok: false;
  error: string;
}

async function rpc<T>(op: string, args?: Record<string, unknown>): Promise<T> {
  const response = (await browser.runtime.sendMessage({ type: TAGDB_MSG, op, ...args })) as
    | RpcOk
    | RpcErr
    | undefined;
  if (!response) throw new Error(`tagdb rpc ${op}: no response (background unavailable?)`);
  if (!response.ok) throw new Error(`tagdb rpc ${op}: ${response.error}`);
  return response.result as T;
}

export function rpcUpsertFeedTags(tags: FeedTag[], rankBase?: number): Promise<void> {
  return rpc('upsert', { tags, rankBase });
}

export function rpcImportStoredFeedTags(rows: StoredFeedTag[]): Promise<void> {
  return rpc('importRows', { rows });
}

export function rpcCountFeedTags(): Promise<number> {
  return rpc('count');
}

export function rpcGetPopularMeta(): Promise<PopularTagDbMeta> {
  return rpc('getMeta');
}

export function rpcSetPopularMeta(
  meta: Omit<PopularTagDbMeta, 'count'>,
  leaseToken?: string
): Promise<PopularTagDbMeta> {
  return rpc('setMeta', { meta, leaseToken });
}

export function rpcGetTopFeedTags(limit: number): Promise<FeedTag[]> {
  return rpc('top', { limit });
}

export function rpcGetFeedTagsByIds(ids: number[]): Promise<Array<[number, string]>> {
  return rpc('byIds', { ids });
}

export function rpcSearchCachedFeedTags(query: string, limit: number): Promise<FeedTag[]> {
  return rpc('search', { query, limit });
}

/** Surface variants (typos/plurals/reorderings) + curated semantic relatives of a tag. */
export function rpcFindSimilarTags(
  id: number,
  name: string,
  limit = 10
): Promise<{ variants: FeedTag[]; related: FeedTag[] }> {
  return rpc('similar', { id, name, limit });
}

export function rpcPruneFeedTagsUpdatedBefore(ts: number): Promise<number> {
  return rpc('prune', { ts });
}

/** Cross-tab sync coordination: only the lease holder runs the pagination loop. */
export function rpcAcquireSyncLease(): Promise<{ granted: boolean; token?: string }> {
  return rpc('acquireLease');
}

export function rpcReleaseSyncLease(token: string): Promise<void> {
  return rpc('releaseLease', { token });
}

/** Combined meta + cross-tab syncing flag (background knows who holds the lease). */
export function rpcGetSyncStatus(): Promise<{ meta: PopularTagDbMeta; syncing: boolean }> {
  return rpc('status');
}
