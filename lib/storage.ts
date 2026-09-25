// `storage` is auto-imported by WXT (from wxt/utils/storage)
import type { ExtensionSettings, Conversation } from './types';
import type { FeedTag, FeedTagBundle } from './civitai-feed-tags';
import type { FeedFacetFilter } from './feed-facets';
import { DEFAULT_SETTINGS } from './constants';

// Settings storage (local only - keeps API keys on-device)
export const settingsStorage = storage.defineItem<ExtensionSettings>(
  'local:cllpSettings',
  {
    fallback: DEFAULT_SETTINGS,
  }
);

// Conversations storage (local)
export const conversationsStorage = storage.defineItem<Conversation[]>(
  'local:cllpConversations',
  {
    fallback: [],
  }
);

// Active conversation ID (local)
export const activeConversationIdStorage = storage.defineItem<string | null>(
  'local:cllpActiveConversationId',
  {
    fallback: null,
  }
);

// --- Feed tag-filter caches (replaces the old raw-localStorage caches) ---

// Popular-tag cache metadata (the large corpus lives in IndexedDB). v2 = "Most Models" sort fix;
// v3 = dropped entityType filter so moderated tags are included;
// v4 = progressive large-corpus cache in WXT storage;
// v5 = IndexedDB corpus with small WXT metadata/migration glue.
export const feedPopularTagsStorage = storage.defineItem<{
  v: number;
  ts: number;
  tags?: FeedTag[]; // legacy v4 blob, imported to IndexedDB then cleared
  pages?: number;
  complete?: boolean;
  indexedDb?: boolean;
}>(
  'local:cllpFeedPopularTags',
  {
    fallback: { v: 5, ts: 0, pages: 0, complete: false, indexedDb: true },
  }
);

// id → name map so chips restore with real names after a cold-cache navigation.
// `order` is an LRU-ish list (oldest first) used to bound the map's growth.
export const feedTagNamesStorage = storage.defineItem<{
  v: number;
  ts: number;
  map: Record<number, string>;
  order: number[];
}>('local:cllpFeedTagNames', {
  fallback: { v: 1, ts: 0, map: {}, order: [] },
});

// Persisted widget UI state: panel state, preferred multi-tag mode, and explicitly expanded
// large tag groups. Group keys are stable sorted tag-id lists, so expansion survives reloads.
export const feedFilterUiStorage = storage.defineItem<{
  expanded: boolean;
  mode: 'all' | 'any';
  expandedGroupKeys?: string[];
}>(
  'local:cllpFeedFilterUi',
  {
    fallback: { expanded: false, mode: 'all', expandedGroupKeys: [] },
  }
);

export interface FeedFilterPreset {
  id: string;
  name: string;
  groups: FeedTag[][];
  negatives: FeedTag[];
  mode: 'all' | 'any';
  /** Optional for backwards compatibility with presets saved before similarity bundles. */
  bundles?: FeedTagBundle[];
  /** Optional for backwards compatibility with v1 tag-only presets. */
  facets?: FeedFacetFilter;
}

export interface FeedGroupPreset {
  id: string;
  name: string;
  tags: FeedTag[];
  bundles?: FeedTagBundle[];
}

// Tags keep their names so loading a preset never depends on a warm autocomplete cache.
export const feedFilterPresetsStorage = storage.defineItem<{
  v: number;
  presets: FeedFilterPreset[];
}>('local:cllpFeedFilterPresets', {
  fallback: { v: 3, presets: [] },
});

// Reusable OR groups can be inserted into or replace a group in any complete filter.
export const feedGroupPresetsStorage = storage.defineItem<{
  v: number;
  presets: FeedGroupPreset[];
}>('local:cllpFeedGroupPresets', {
  fallback: { v: 1, presets: [] },
});

// Tag tray: tags picked up on image-detail pages, waiting to be assigned to the filter
// (as their own AND group, OR-ed into a group, or as an exclusion). Extension-wide, so a
// tag grabbed in one tab is available in every feed tab.
export const feedTagTrayStorage = storage.defineItem<{ v: number; tags: FeedTag[] }>(
  'local:cllpFeedTagTray',
  {
    fallback: { v: 1, tags: [] },
  }
);

// Last applied feed filter, so image-detail pages (whose URL carries no tags) can show and
// build on the filter the user was just browsing with.
export const feedLastFilterStorage = storage.defineItem<{
  v: number;
  groups: number[][];
  negatives: number[];
  mode: 'all' | 'any';
  kind: 'images' | 'videos';
  /** Optional for backwards compatibility with tag-only last-filter records. */
  bundles?: FeedTagBundle[];
  /** Optional for backwards compatibility with the v1 last-filter record. */
  facets?: FeedFacetFilter;
}>('local:cllpFeedLastFilter', {
  fallback: { v: 3, groups: [], negatives: [], mode: 'all', kind: 'images', bundles: [], facets: undefined },
});

// Helper: Get the active provider config
export async function getActiveProvider(): Promise<ExtensionSettings['providers'][string] | null> {
  const settings = await settingsStorage.getValue();
  const activeId = settings.activeProviderId;
  return settings.providers[activeId] ?? null;
}

// Direct conversation upsert. Only the background's serialized host may call this —
// content scripts go through lib/conversation-rpc.ts so concurrent tabs can't clobber
// each other's read-modify-write over the shared array.
export async function saveConversationDirect(conversation: Conversation): Promise<void> {
  const conversations = await conversationsStorage.getValue();
  const index = conversations.findIndex((c) => c.id === conversation.id);
  if (index >= 0) {
    conversations[index] = conversation;
  } else {
    conversations.unshift(conversation);
  }
  await conversationsStorage.setValue(conversations);
}

// Helper: Get a conversation by ID
export async function getConversation(id: string): Promise<Conversation | null> {
  const conversations = await conversationsStorage.getValue();
  return conversations.find((c) => c.id === id) ?? null;
}

// Direct conversation delete — same background-only rule as saveConversationDirect.
export async function deleteConversationDirect(id: string): Promise<void> {
  const conversations = await conversationsStorage.getValue();
  const filtered = conversations.filter((c) => c.id !== id);
  await conversationsStorage.setValue(filtered);
  const activeId = await activeConversationIdStorage.getValue();
  if (activeId === id) {
    await activeConversationIdStorage.setValue(null);
  }
}
