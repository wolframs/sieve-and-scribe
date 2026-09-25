/**
 * Background-side host for the shared tag corpus (see feed-tag-rpc.ts for the why).
 *
 * Runs in the MV3 service worker: owns the extension-origin IndexedDB, serves content-script
 * RPCs, hands out the cross-tab sync lease, and broadcasts meta changes to all civitai tabs
 * so every widget's "N cached tags" footer stays live no matter which tab is syncing.
 *
 * The lease is in-memory: if the worker is killed it simply expires and the next tab's sync
 * request re-acquires. Lease loss mid-sync is harmless — the sync checkpoints meta per page
 * and upserts are idempotent.
 */
import {
  countFeedTags,
  findVariantTags,
  getFeedTagsByIds,
  getPopularMeta,
  getTopFeedTags,
  importStoredFeedTags,
  pruneFeedTagsUpdatedBefore,
  searchCachedFeedTags,
  setPopularMeta,
  upsertFeedTags,
  type PopularTagDbMeta,
  type StoredFeedTag,
} from './feed-tag-db';
import type { FeedTag } from './civitai-feed-tags';
import { TAGDB_MSG, TAGDB_STATUS_BROADCAST } from './feed-tag-rpc';

const LEASE_TTL = 60_000; // sync checkpoints renew it every page; a dead tab frees it in ≤60s

let lease: { token: string; ts: number } | null = null;

// --- optional semantic-map asset (shipped as tag-semantics.json when generated) ---

interface SemanticsAsset {
  v: number;
  categories?: string[];
  cat?: Record<string, number>;
  /** member tag id -> cluster head id */
  heads?: Record<string, number>;
  /** head id -> semantically related head ids (e.g. gown ~ dress, gendered variants) */
  related?: Record<string, number[]>;
}

let semanticsPromise: Promise<SemanticsAsset | null> | null = null;

function loadSemantics(): Promise<SemanticsAsset | null> {
  if (!semanticsPromise) {
    semanticsPromise = fetch(browser.runtime.getURL('/tag-semantics.json'))
      .then((r) => (r.ok ? (r.json() as Promise<SemanticsAsset>) : null))
      .catch(() => null);
  }
  return semanticsPromise;
}

async function semanticRelated(id: number): Promise<FeedTag[]> {
  const sem = await loadSemantics();
  if (!sem?.related) return [];
  const headId = sem.heads?.[String(id)] ?? id;
  const ids = (sem.related[String(headId)] ?? []).filter((x) => x !== id);
  if (!ids.length) return [];
  const names = await getFeedTagsByIds(ids);
  return [...names.entries()].map(([tagId, name]) => ({ id: tagId, name }));
}

function leaseActive(): boolean {
  return lease !== null && Date.now() - lease.ts < LEASE_TTL;
}

async function broadcastStatus(meta: PopularTagDbMeta): Promise<void> {
  const message = { type: TAGDB_STATUS_BROADCAST, meta, syncing: leaseActive() };
  try {
    const tabs = await browser.tabs.query({
      url: ['https://civitai.com/*', 'https://civitai.red/*'],
    });
    await Promise.allSettled(
      tabs.map((tab) => (tab.id ? browser.tabs.sendMessage(tab.id, message) : Promise.resolve()))
    );
  } catch {
    /* no tabs / no listener — fine */
  }
}

async function handle(message: Record<string, unknown>): Promise<unknown> {
  switch (message.op) {
    case 'upsert':
      await upsertFeedTags(message.tags as FeedTag[], message.rankBase as number | undefined);
      return undefined;
    case 'importRows':
      await importStoredFeedTags(message.rows as StoredFeedTag[]);
      return undefined;
    case 'count':
      return countFeedTags();
    case 'getMeta':
      return getPopularMeta();
    case 'setMeta': {
      const token = message.leaseToken as string | undefined;
      if (token) {
        if (lease?.token === token) {
          lease.ts = Date.now(); // sync heartbeat
        } else if (!leaseActive()) {
          // The in-memory lease died with a service-worker restart (or expired during a
          // slow page) while the holder's walk kept going — re-establish it so mutual
          // exclusion and the `syncing` status stay correct.
          lease = { token, ts: Date.now() };
        } else {
          // Another tab acquired the lease in the meantime — this walk must stop.
          throw new Error('sync lease lost to another tab');
        }
      }
      const next = await setPopularMeta(message.meta as Omit<PopularTagDbMeta, 'count'>);
      void broadcastStatus(next);
      return next;
    }
    case 'top':
      return getTopFeedTags(message.limit as number);
    case 'byIds': {
      const map = await getFeedTagsByIds(message.ids as number[]);
      return [...map.entries()]; // Maps don't survive message serialization
    }
    case 'search':
      return searchCachedFeedTags(message.query as string, message.limit as number);
    case 'similar': {
      // Surface variants from a live corpus scan + (if the semantic asset is shipped)
      // curated semantically-related tags.
      const [variants, related] = await Promise.all([
        findVariantTags(message.name as string, message.id as number, (message.limit as number) ?? 10),
        semanticRelated(message.id as number),
      ]);
      return { variants, related };
    }
    case 'prune':
      return pruneFeedTagsUpdatedBefore(message.ts as number);
    case 'acquireLease': {
      if (leaseActive()) return { granted: false };
      lease = { token: crypto.randomUUID(), ts: Date.now() };
      return { granted: true, token: lease.token };
    }
    case 'releaseLease': {
      if (lease?.token === message.token) lease = null;
      void getPopularMeta().then(broadcastStatus);
      return undefined;
    }
    case 'status':
      return { meta: await getPopularMeta(), syncing: leaseActive() };
    default:
      throw new Error(`unknown op ${String(message.op)}`);
  }
}

export function registerFeedTagDbHost(): void {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== TAGDB_MSG) return;
    handle(message as Record<string, unknown>)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  });
}
