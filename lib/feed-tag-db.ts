import type { FeedTag } from './civitai-feed-tags';

const DB_NAME = 'cllp-feed-tags';
const DB_VERSION = 2; // v2 adds the updatedAt index (post-sync stale-row pruning)
const TAG_STORE = 'tags';
const META_STORE = 'meta';
const POPULAR_META_KEY = 'popular-cache';
const MAX_LOCAL_SCAN = 50000;

/**
 * Ranks at or above this floor belong to rows the popular-tag sync does NOT own: names
 * cached by a live lookup (`upsertFeedTags` without a rank base) and migration imports.
 * Sync ranks are page offsets and stay orders of magnitude below it, so the floor cleanly
 * separates the two — and keeps long-tail names alive through a post-resync prune.
 */
export const RANKLESS_RANK_FLOOR = 1e15;

export interface StoredFeedTag extends FeedTag {
  normalized: string;
  rank: number;
  updatedAt: number;
}

export interface PopularTagDbMeta {
  v: number;
  ts: number;
  pages: number;
  complete: boolean;
  count: number;
  /**
   * Set while a full resync (from page 1) is in flight, possibly spanning sessions.
   * Rows older than this are pruned once the resync completes — the corpus is never
   * cleared up front, so an interrupted resync keeps the old data usable.
   */
  refreshStartedTs?: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function normalizeTagName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, ' ');
}

export async function upsertFeedTags(tags: FeedTag[], rankBase?: number): Promise<void> {
  if (!tags.length) return;
  const db = await openTagDb();
  const tx = db.transaction(TAG_STORE, 'readwrite');
  const store = tx.objectStore(TAG_STORE);
  const now = Date.now();
  tags.forEach((tag, i) => {
    if (rankBase !== undefined) {
      store.put({
        ...tag,
        normalized: normalizeTagName(tag.name),
        rank: rankBase + i,
        updatedAt: now,
      } satisfies StoredFeedTag);
      return;
    }
    // Rank-less upsert (live-lookup name caching): NEVER clobber an existing row's sync
    // rank — that was silently corroding popularity ordering with every search. Only
    // brand-new rows get the bottom-of-the-list placeholder (above RANKLESS_RANK_FLOOR, so
    // the post-resync prune knows the sync walk does not own them).
    const get = store.get(tag.id);
    get.onsuccess = () => {
      const existing = get.result as StoredFeedTag | undefined;
      store.put({
        ...tag,
        normalized: normalizeTagName(tag.name),
        rank: existing?.rank ?? Number.MAX_SAFE_INTEGER - now + i,
        updatedAt: now,
      } satisfies StoredFeedTag);
    };
  });
  await txDone(tx);
}

export async function clearFeedTags(): Promise<void> {
  const db = await openTagDb();
  const tx = db.transaction(TAG_STORE, 'readwrite');
  tx.objectStore(TAG_STORE).clear();
  await txDone(tx);
}

/** Delete ranked rows last touched before `ts`. Used to drop tags that vanished upstream,
 * only after a full resync has confirmed the rest of the corpus. Rank-less rows (live name
 * lookups for long-tail tags the ranked walk never visits) are kept — pruning them lost the
 * names of tags the user had selected. Returns rows removed. */
export async function pruneFeedTagsUpdatedBefore(ts: number): Promise<number> {
  const db = await openTagDb();
  const tx = db.transaction(TAG_STORE, 'readwrite');
  const idx = tx.objectStore(TAG_STORE).index('updatedAt');
  let removed = 0;
  await new Promise<void>((resolve, reject) => {
    const request = idx.openCursor(IDBKeyRange.upperBound(ts, true));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const row = cursor.value as StoredFeedTag;
      if (typeof row?.rank !== 'number' || row.rank < RANKLESS_RANK_FLOOR) {
        cursor.delete();
        removed++;
      }
      cursor.continue();
    };
  });
  await txDone(tx);
  return removed;
}

/** Read the entire corpus with stored ranks (used for the one-time page-origin → background migration). */
export async function readAllStoredFeedTags(): Promise<StoredFeedTag[]> {
  const db = await openTagDb();
  const store = db.transaction(TAG_STORE, 'readonly').objectStore(TAG_STORE);
  return req<StoredFeedTag[]>(store.getAll() as IDBRequest<StoredFeedTag[]>);
}

/** Write pre-built rows verbatim (rank/updatedAt preserved). Migration import path. */
export async function importStoredFeedTags(rows: StoredFeedTag[]): Promise<void> {
  if (!rows.length) return;
  const db = await openTagDb();
  const tx = db.transaction(TAG_STORE, 'readwrite');
  const store = tx.objectStore(TAG_STORE);
  for (const row of rows) {
    if (typeof row?.id !== 'number' || typeof row?.name !== 'string') continue;
    store.put({
      id: row.id,
      name: row.name,
      normalized: row.normalized ?? normalizeTagName(row.name),
      rank: typeof row.rank === 'number' ? row.rank : Number.MAX_SAFE_INTEGER,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    } satisfies StoredFeedTag);
  }
  await txDone(tx);
}

/** Drop the whole database (used to remove a page-origin DB after its data moved to the background). */
export async function deleteTagDatabase(): Promise<void> {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      /* already closed */
    }
    dbPromise = null;
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve(); // best-effort
    request.onblocked = () => resolve(); // another tab holds it open — it'll win eventually
  });
}

export async function getPopularMeta(): Promise<PopularTagDbMeta> {
  const db = await openTagDb();
  const meta = await req<PopularTagDbMeta | undefined>(
    db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(POPULAR_META_KEY)
  );
  if (meta) return meta;
  return { v: 0, ts: 0, pages: 0, complete: false, count: await countFeedTags() };
}

export async function setPopularMeta(meta: Omit<PopularTagDbMeta, 'count'>): Promise<PopularTagDbMeta> {
  const next = { ...meta, count: await countFeedTags() };
  const db = await openTagDb();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put(next, POPULAR_META_KEY);
  await txDone(tx);
  return next;
}

export async function countFeedTags(): Promise<number> {
  const db = await openTagDb();
  return req<number>(db.transaction(TAG_STORE, 'readonly').objectStore(TAG_STORE).count());
}

export async function getTopFeedTags(limit: number): Promise<FeedTag[]> {
  const db = await openTagDb();
  const idx = db.transaction(TAG_STORE, 'readonly').objectStore(TAG_STORE).index('rank');
  return cursorCollect(idx.openCursor(), limit, () => true);
}

export async function getFeedTagsByIds(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const db = await openTagDb();
  const store = db.transaction(TAG_STORE, 'readonly').objectStore(TAG_STORE);
  await Promise.all(
    ids.map(async (id) => {
      const tag = await req<StoredFeedTag | undefined>(store.get(id));
      if (tag) out.set(id, tag.name);
    })
  );
  return out;
}

export async function searchCachedFeedTags(
  query: string,
  limit: number
): Promise<FeedTag[]> {
  const q = normalizeTagName(query);
  if (!q) return getTopFeedTags(limit);

  const exact = await getExactCachedTags(q, limit);
  if (exact.length >= limit) return exact;

  const seen = new Set(exact.map((t) => t.id));
  const ranked = await scanRankedCachedTags(q, limit - exact.length, seen);
  return [...exact, ...ranked];
}

async function getExactCachedTags(normalized: string, limit: number): Promise<FeedTag[]> {
  const db = await openTagDb();
  const idx = db.transaction(TAG_STORE, 'readonly').objectStore(TAG_STORE).index('normalized');
  const range = IDBKeyRange.only(normalized);
  const found = await cursorCollect(idx.openCursor(range), limit, () => true);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

const MAX_FUZZY_CANDIDATES = 400;

/**
 * Rank-ordered scan with typo tolerance. Prefix/substring matches fill the result first
 * (popularity order); if those don't reach `limit`, near-miss tags within a bounded
 * edit distance (1 for short queries, 2 from 5 chars) top it up, closest first. The
 * corpus is full of user typos ("dresss", "silver dres"), so a strict substring match
 * regularly finds nothing while the intended tag sits one edit away.
 */
async function scanRankedCachedTags(
  normalized: string,
  limit: number,
  seen: Set<number>
): Promise<FeedTag[]> {
  const db = await openTagDb();
  const idx = db.transaction(TAG_STORE, 'readonly').objectStore(TAG_STORE).index('rank');
  const prefix: Array<{ tag: FeedTag; order: number }> = [];
  const contains: FeedTag[] = [];
  const fuzzy: Array<{ tag: FeedTag; dist: number; order: number }> = [];
  const maxDist = normalized.length < 3 ? 0 : normalized.length <= 4 ? 1 : 2;
  const wanted = limit * 3; // overscan a little so tiering has material to work with
  let scanned = 0;
  await new Promise<void>((resolve, reject) => {
    const request = idx.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || prefix.length + contains.length >= wanted || scanned >= MAX_LOCAL_SCAN) {
        resolve();
        return;
      }
      scanned++;
      const tag = cursor.value as StoredFeedTag;
      if (!seen.has(tag.id)) {
        if (tag.normalized.startsWith(normalized)) {
          seen.add(tag.id);
          prefix.push({ tag: { id: tag.id, name: tag.name }, order: scanned });
        } else if (normalized.length >= 3 && tag.normalized.includes(normalized)) {
          seen.add(tag.id);
          contains.push({ id: tag.id, name: tag.name });
        } else if (maxDist > 0 && fuzzy.length < MAX_FUZZY_CANDIDATES) {
          const dist = boundedEditDistance(tag.normalized, normalized, maxDist);
          if (dist <= maxDist) {
            fuzzy.push({ tag: { id: tag.id, name: tag.name }, dist, order: scanned });
          }
        }
      }
      cursor.continue();
    };
  });

  // Tiered: prefix completions > substring > near-miss typos; popularity order within a
  // tier (a length/closeness sort just floats the corpus's endless typo variants to the top).
  prefix.sort((a, b) => a.order - b.order);
  fuzzy.sort((a, b) => a.dist - b.dist || a.order - b.order);
  const out: FeedTag[] = [];
  for (const list of [prefix.map((p) => p.tag), contains, fuzzy.map((f) => f.tag)]) {
    for (const tag of list) {
      if (out.length >= limit) return out;
      out.push(tag);
    }
  }
  return out;
}

/**
 * Optimal-string-alignment (Damerau-Levenshtein w/o repeated transposition) distance,
 * capped at `max` — returns max+1 as soon as the bound is provably exceeded.
 */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] | null = null;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      let best = Math.min(prev[j] + 1, row[j - 1] + 1, substitution);
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prevPrev[j - 2] + 1);
      }
      row.push(best);
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > max) return max + 1; // whole band above the bound — cannot recover
    prevPrev = prev;
    prev = row;
  }
  return Math.min(prev[b.length], max + 1);
}

// --- similar-tag detection (quasi-duplicates: typos, plurals, reorderings, decoration) ---

/** Tags ranked better than this are "real" — never claimed as someone else's typo. */
const TYPO_VARIANT_MIN_RANK = 25000;

/** Aggressive fold: strip decoration/punctuation so "dress," ~ "dress*" ~ "dress". */
function foldTagName(s: string): string {
  return normalizeTagName(s)
    .replace(/[.,;:!?*#'"´`’|~^°§\\/()[\]{}<>+=%&@-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const IRREGULAR_PLURALS: Record<string, string> = {
  women: 'woman', men: 'man', children: 'child', people: 'person', feet: 'foot',
  teeth: 'tooth', mice: 'mouse', geese: 'goose', wolves: 'wolf', elves: 'elf',
  knives: 'knife', wives: 'wife', leaves: 'leaf', thieves: 'thief', scarves: 'scarf',
};

function singularWord(word: string): string {
  const irregular = IRREGULAR_PLURALS[word];
  if (irregular) return irregular;
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(sses|shes|ches|xes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ss')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function singularFold(s: string): string {
  return foldTagName(s).split(' ').map(singularWord).join(' ');
}

function tokenSortFold(s: string): string {
  return singularFold(s).split(' ').sort().join(' ');
}

/**
 * Scan the corpus for surface variants of one tag: identical after folding (case,
 * punctuation, underscores), singular/plural forms, token reorderings, and 1–2-edit
 * typos. Popularity-ordered. This is what powers "group similar tags" — turning one
 * pick into an OR group that also catches the typo/duplicate swamp.
 */
export async function findVariantTags(name: string, excludeId: number, limit: number): Promise<FeedTag[]> {
  const folded = foldTagName(name);
  if (!folded) return [];
  const sing = singularFold(name);
  const sorted = tokenSortFold(name);
  // Distance 2 only for longer names — on short ones it manufactures false relatives
  // ("forest" -> "foxes") faster than it finds real typos.
  const maxDist = folded.length >= 7 ? 2 : 1;
  const db = await openTagDb();
  const idx = db.transaction(TAG_STORE, 'readonly').objectStore(TAG_STORE).index('rank');
  const strong: FeedTag[] = []; // fold/singular/token-sort identity
  const typo: Array<{ tag: FeedTag; dist: number }> = [];
  await new Promise<void>((resolve, reject) => {
    const request = idx.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || strong.length >= limit) {
        resolve();
        return;
      }
      const tag = cursor.value as StoredFeedTag;
      if (tag.id !== excludeId) {
        const f = foldTagName(tag.normalized);
        if (f === folded || singularFold(tag.normalized) === sing || tokenSortFold(tag.normalized) === sorted) {
          strong.push({ id: tag.id, name: tag.name });
        } else if (
          folded.length >= 5 &&
          typo.length < MAX_FUZZY_CANDIDATES &&
          // Edit-distance matches must be unpopular: genuine typo tags always are, while
          // a popular near-neighbour ("roman" vs "woman") is a real, distinct word.
          tag.rank > TYPO_VARIANT_MIN_RANK &&
          // Typos virtually always keep the first letter (or transpose the first two) —
          // rejects distinct rhyming words like press/cress/tress vs dress.
          (f[0] === folded[0] || (f[1] === folded[0] && f[0] === folded[1]))
        ) {
          const dist = boundedEditDistance(f, folded, maxDist);
          if (dist <= maxDist) typo.push({ tag: { id: tag.id, name: tag.name }, dist });
        }
      }
      cursor.continue();
    };
  });
  typo.sort((a, b) => a.dist - b.dist);
  const seen = new Set(strong.map((t) => t.id));
  const out = [...strong];
  for (const { tag } of typo) {
    if (out.length >= limit) break;
    if (!seen.has(tag.id)) {
      seen.add(tag.id);
      out.push(tag);
    }
  }
  return out.slice(0, limit);
}

async function cursorCollect(
  request: IDBRequest<IDBCursorWithValue | null>,
  limit: number,
  accept: (tag: StoredFeedTag) => boolean
): Promise<FeedTag[]> {
  const out: FeedTag[] = [];
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) {
        resolve();
        return;
      }
      const tag = cursor.value as StoredFeedTag;
      if (accept(tag)) out.push({ id: tag.id, name: tag.name });
      cursor.continue();
    };
  });
  return out;
}

function openTagDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tags = db.objectStoreNames.contains(TAG_STORE)
        ? request.transaction!.objectStore(TAG_STORE)
        : db.createObjectStore(TAG_STORE, { keyPath: 'id' });
      if (!tags.indexNames.contains('normalized')) tags.createIndex('normalized', 'normalized');
      if (!tags.indexNames.contains('rank')) tags.createIndex('rank', 'rank');
      if (!tags.indexNames.contains('updatedAt')) tags.createIndex('updatedAt', 'updatedAt');
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
