/**
 * Feed tag-filter widget.
 *
 * Injects a control onto the /images and /videos feeds that CivitAI itself doesn't
 * offer: free-text tag filtering with AND between groups and OR within each group.
 * Type a tag → pick from autocomplete (resolved to numeric IDs via tRPC) → Apply →
 * the feed reloads with `?tags=<id>&tags=<id>&tagmode=<mode>`. The MAIN-world
 * interceptor (civitai-and.content.ts) applies the group logic to the feed.
 *
 * Built once (shell) then patched incrementally — the input/dropdown are never torn
 * down mid-interaction, so you can add several tags in a row without losing focus.
 * Self-contained in a shadow root (no CSS bleed from/into CivitAI).
 */
import {
  searchFeedTags,
  loadPopularTags,
  searchCachedFeedTags,
  parseNegativeTagsFromSearch,
  parseTagBundlesFromSearch,
  parseTagGroupsFromSearch,
  parseTagsFromSearch,
  parseModeFromSearch,
  buildHrefWithTagFilter,
  mergeFeedTagGroups,
  moveFeedTagBetweenGroups,
  findFeedTagHealthIssues,
  resolveTagNames,
  rememberTagNames,
  migrateLegacyCaches,
  getFeedKind,
  watchPopularTagCache,
  restoreStrippedFeedFilterInPlace,
  writeFeedFilterStash,
  type FeedTag,
  type FeedTagBundle,
  type FeedTagHealthIssue,
  type PopularTagCacheStatus,
  type TagMode,
} from '@/lib/civitai-feed-tags';
import {
  EMPTY_FEED_FACETS,
  FEED_FACET_PARAMS,
  feedFacetCount,
  feedFacetSummary,
  hasFeedFacets,
  normalizeFeedFacetFilter,
  parseFeedFacetsFromSearch,
  sameFeedFacets,
  type FeedFacetFilter,
  type FeedOrientation,
  type FeedResourceRef,
} from '@/lib/feed-facets';
import { searchFeedResources } from '@/lib/feed-resources';
import { formatFeedTagExpression, parseFeedTagExpression } from '@/lib/feed-tag-expression';
import {
  feedFilterUiStorage,
  feedFilterPresetsStorage,
  feedGroupPresetsStorage,
  feedTagTrayStorage,
  feedLastFilterStorage,
  type FeedFilterPreset,
  type FeedGroupPreset,
} from '@/lib/storage';
import { rpcFindSimilarTags } from '@/lib/feed-tag-rpc';
import { reportSiteIssue } from './site-health';
import { NativeFilterDock, type FilterPlacement } from './native-filter-dock';
import { FEED_TAG_FILTER_STYLES } from './feed-tag-filter.styles';

const HOST_ID = 'cllp-tagfilter-host';
const FEED_SWITCH_ID = 'cllp-feed-kind-switch';
const FEED_SWITCH_STYLE_ID = 'cllp-feed-kind-switch-style';
const SUGGEST_LIMIT = 12;
const COLLAPSED_GROUP_PREVIEW = 3;
const LARGE_GROUP_THRESHOLD = 8;
const TAG_LOG_PREFIX = '[CLLP tags]';

type PageMode = 'feed' | 'detail';
type ChipKind = 'pos' | 'neg' | 'tray';
type DetailTagState = 'tray' | 'positive' | 'negative' | null;

interface FilterDraftSnapshot {
  positiveGroups: FeedTag[][];
  excluded: FeedTag[];
  mode: TagMode;
  facets: FeedFacetFilter;
  bundles: FeedTagBundle[];
}

/** Image/video detail views — where tags can be picked up into the tray. */
function isMediaDetailPage(pathname: string): boolean {
  return /^\/(images|videos)\/\d+/.test(pathname.replace(/\/+$/, ''));
}

function truncate(s: string, n = 26): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function tagFilterLog(message: string, detail?: unknown): void {
  if (detail === undefined) console.log(TAG_LOG_PREFIX, message);
  else console.log(TAG_LOG_PREFIX, message, detail);
}

/** The subset of WXT's ContentScriptContext this widget relies on (auto-cleaned timers). */
interface FeedCtx {
  setTimeout(cb: () => void, ms: number): number;
  setInterval(cb: () => void, ms: number): number;
  signal: AbortSignal;
  onInvalidated(cb: () => void): void;
}

export class TagFilterWidget {
  private ctx: FeedCtx;
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private nativeDock: NativeFilterDock;
  private placement: FilterPlacement = 'unavailable';

  private positiveGroups: FeedTag[][] = [];
  private excluded: FeedTag[] = [];
  private tray: FeedTag[] = [];
  private presets: FeedFilterPreset[] = [];
  private groupPresets: FeedGroupPreset[] = [];
  private pageMode: PageMode = 'feed';
  private expanded = false;
  private mode: TagMode = 'all';
  private facets: FeedFacetFilter = { ...EMPTY_FEED_FACETS };
  private facetEditorOpen = false;
  private groupEditorOpen = false;
  private groupEditorIndex = -1;
  private groupEditorSelection = new Set<number>();
  private groupEditorOriginalOrder: number[] = [];
  private groupEditorReviewOnly = false;
  private expressionEditorOpen = false;
  private nameMap = new Map<number, string>();
  private expandedGroupKeys = new Set<string>();
  private tagBundles: FeedTagBundle[] = [];
  private expandedBundleSeeds = new Set<number>();
  private undoStack: FilterDraftSnapshot[] = [];
  private redoStack: FilterDraftSnapshot[] = [];
  private appliedDraft?: FilterDraftSnapshot;
  private lastHistoryKey?: string;
  private lastHistoryAt = 0;

  private searchSeq = 0;
  private debounce?: number;
  private abort?: AbortController;
  private popularLoad?: Promise<void>;
  private popularLoaded = false;
  private cacheStatus?: PopularTagCacheStatus;
  private unwatchPopularCache?: () => void;
  private currentOptions: FeedTag[] = [];
  private dropdownQuery = '';
  private activeIndex = -1;
  private blurTimer?: number;
  private switchEl?: HTMLButtonElement;
  private onDocPointerDown: (e: Event) => void;
  private draggedTagId?: number;
  private draggedFromGroup?: number;
  private draggedGroupIndex?: number;
  private dragDropped = false;

  private unwatchTray?: () => void;
  private unwatchPresets?: () => void;
  private unwatchGroupPresets?: () => void;
  /** Set on destroy(): pending ctx timers must not touch the page for this instance. */
  private dead = false;

  // element refs (captured once in buildShell)
  private panelEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private dragStatusEl!: HTMLElement;
  private trayEl!: HTMLElement;
  private menuEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private dropdownEl!: HTMLElement;
  private applyBtn!: HTMLButtonElement;
  private presetSelectEl!: HTMLSelectElement;
  private presetLoadBtn!: HTMLButtonElement;
  private presetSaveBtn!: HTMLButtonElement;
  private presetDeleteBtn!: HTMLButtonElement;
  private groupPresetSelectEl!: HTMLSelectElement;
  private groupPresetEditorSelectEl!: HTMLSelectElement;
  private expressionViewEl!: HTMLElement;
  private expressionInputEl!: HTMLTextAreaElement;
  private expressionStatusEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private explainerEl!: HTMLElement;
  private modeBtns!: NodeListOf<HTMLButtonElement>;
  private modeEl!: HTMLElement;
  private presetRowEl!: HTMLElement;
  private groupLibraryEl!: HTMLElement;
  private tagViewEl!: HTMLElement;
  private groupViewEl!: HTMLElement;
  private groupEditorTitleEl!: HTMLElement;
  private groupEditorSearchEl!: HTMLInputElement;
  private groupEditorListEl!: HTMLElement;
  private groupEditorCountEl!: HTMLElement;
  private groupEditorTargetEl!: HTMLSelectElement;
  private historySummaryEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private revertBtn!: HTMLButtonElement;
  private facetViewEl!: HTMLElement;
  private facetSummaryEl!: HTMLElement;
  private facetBadgeEl!: HTMLElement;
  private facetCreatorIncludeEl!: HTMLInputElement;
  private facetCreatorExcludeEl!: HTMLInputElement;
  private facetNumberEls!: NodeListOf<HTMLInputElement>;
  private facetCheckEls!: NodeListOf<HTMLInputElement>;
  private orientationBtns!: NodeListOf<HTMLButtonElement>;
  private resourceSearchEl!: HTMLInputElement;
  private resourceResultsEl!: HTMLElement;
  private resourceSelectionsEl!: HTMLElement;
  private resourceOptions: FeedResourceRef[] = [];
  private resourceSearchSeq = 0;
  private resourceDebounce?: number;
  private resourceAbort?: AbortController;

  constructor(ctx: FeedCtx) {
    this.ctx = ctx;
    tagFilterLog('widget mounting', { href: location.href, path: location.pathname });
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.host.style.display = 'none';
    this.root = this.host.attachShadow({ mode: 'open' });
    document.body.appendChild(this.host);

    this.buildShell();
    this.nativeDock = new NativeFilterDock(this.host, (placement) => {
      this.placement = placement;
      this.host.dataset.placement = placement;
      this.host.style.display = placement === 'docked' ? '' : 'none';
      this.closeDropdown();
      this.closeMenu();
      this.updateExpanded();
      this.updateActionState();
    });

    // Close the dropdown/menu on any click that isn't inside them (so clicking a chip,
    // the mode toggle, Apply, or anywhere on the page closes them).
    this.onDocPointerDown = (e: Event) => {
      const path = e.composedPath();
      if (!path.includes(this.menuEl)) this.closeMenu();
      if (path.includes(this.inputEl) || path.includes(this.dropdownEl)) return;
      this.closeDropdown();
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    ctx.onInvalidated(() => this.destroy());
    this.unwatchPopularCache = watchPopularTagCache((status) => this.onPopularCacheStatus(status));
    this.scheduleFeedSwitcherRefreshes();

    // Tray: shared across tabs/pages via extension storage; keep it live-synced.
    feedTagTrayStorage.getValue().then((t) => {
      this.tray = t.tags;
      this.renderTray();
    });
    this.unwatchTray = feedTagTrayStorage.watch((t) => {
      this.tray = t?.tags ?? [];
      this.renderTray();
    });

    feedFilterPresetsStorage.getValue().then((stored) => {
      this.presets = stored.presets;
      this.renderPresets();
    });
    this.unwatchPresets = feedFilterPresetsStorage.watch((stored) => {
      this.presets = stored?.presets ?? [];
      this.renderPresets();
    });

    feedGroupPresetsStorage.getValue().then((stored) => {
      this.groupPresets = stored.presets;
      this.renderGroupPresets();
    });
    this.unwatchGroupPresets = feedGroupPresetsStorage.watch((stored) => {
      this.groupPresets = stored?.presets ?? [];
      this.renderGroupPresets();
    });

    // Hydrate persisted UI prefs, then reflect the current URL.
    feedFilterUiStorage.getValue().then((ui) => {
      this.expanded = ui.expanded;
      this.mode = ui.mode;
      this.expandedGroupKeys = new Set(ui.expandedGroupKeys ?? []);
      this.refreshFromUrl();
      this.updateExpanded();
    });

    // The rank-ordered popular list is loaded lazily on first suggestion use so collapsed
    // widgets don't spend page-load work on autocomplete data. Chip names are resolved
    // by ID from IndexedDB as needed instead of hydrating the whole tag corpus.
  }

  destroy() {
    this.dead = true;
    this.nativeDock.destroy();
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    this.unwatchPopularCache?.();
    this.unwatchTray?.();
    this.unwatchPresets?.();
    this.unwatchGroupPresets?.();
    this.abort?.abort();
    this.resourceAbort?.abort();
    this.removeFeedSwitcher();
    stopDetailTagPickup();
    this.host.remove();
  }

  /** Feed pages edit the URL-applied filter; detail pages collect tags + edit the last-applied one. */
  setPageMode(mode: PageMode) {
    if (this.pageMode === mode) return;
    this.pageMode = mode;
    if (mode === 'detail') startDetailTagPickup(this);
    else stopDetailTagPickup();
    // Caller (route sync) follows up with refreshFromUrl().
  }

  // --- one-time shell + permanent listeners ---

  private buildShell() {
    const backIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    this.root.innerHTML = `
      <style>${FEED_TAG_FILTER_STYLES}</style>
      <div class="panel">
        <div class="head">
          <span class="title">Filter by tags</span>
          <button class="x" title="Collapse" aria-label="Collapse tag filter">×</button>
        </div>
        <div class="tag-view">
          <div class="composer">
            <div class="field">
              <svg class="field-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
              <input class="in" type="text" placeholder="Add a tag — e.g. cyberpunk, watercolor…" autocomplete="off"
                     role="combobox" aria-expanded="false" aria-controls="cllp-dd" aria-autocomplete="list" aria-label="Search tags" />
              <div class="dropdown" id="cllp-dd" role="listbox"></div>
            </div>
            <div class="mode">
              <span class="mode-label">Images must match</span>
              <div class="seg" role="group" aria-label="How to combine tag groups">
                <button class="seg-btn" data-mode="all" type="button" title="Every group must match (narrower)">all groups</button>
                <button class="seg-btn" data-mode="any" type="button" title="Any one group is enough (wider)">any group</button>
              </div>
            </div>
            <div class="explainer"></div>
          </div>
          <div class="tray"></div>
          <div class="chips"></div>
          <div class="presets">
            <div class="section">Saved filters</div>
            <div class="preset-row">
              <select class="select preset-select" aria-label="Saved feed filters"><option value="">Saved filters…</option></select>
              <button class="preset-btn preset-load" type="button" disabled>Load</button>
              <button class="preset-btn preset-save" type="button" disabled title="Save the current tags and filters under a name">Save current…</button>
              <button class="preset-btn preset-delete" type="button" disabled>Delete</button>
            </div>
            <div class="group-library">
              <select class="select group-preset-select group-preset-main" aria-label="Reusable tag groups"><option value="">Reusable groups…</option></select>
              <button class="group-preset-btn group-preset-insert" type="button" disabled>Insert</button>
              <button class="group-preset-btn group-preset-delete" type="button" disabled>Delete</button>
            </div>
            <div class="library-foot">
              <button class="link-btn expression-open" type="button" title="Copy this filter as text, or paste one in">Copy / paste as text</button>
            </div>
          </div>
          <div class="drag-status sr-only" aria-live="polite"></div>
          <div class="menu" role="menu"></div>
          <button class="more-filters" type="button">
            <span class="more-label">More filters</span><span class="facet-summary">None</span><span class="facet-badge"></span>
            <svg class="more-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="group-view">
          <div class="subhead group-editor-head">
            <button class="group-editor-back" type="button" aria-label="Back to tags">${backIcon}</button>
            <span class="group-editor-title">Edit group</span>
            <span class="group-editor-count"></span>
          </div>
          <input class="group-editor-search" type="search" placeholder="Find tags in this group…" autocomplete="off" />
          <div class="group-editor-tools">
            <button class="group-editor-tool" type="button" data-group-editor-action="select-shown">Select shown</button>
            <button class="group-editor-tool" type="button" data-group-editor-action="clear-selection">Clear selection</button>
            <button class="group-editor-tool" type="button" data-group-editor-action="toggle-review" hidden>Review issues</button>
            <button class="group-editor-tool" type="button" data-group-editor-action="sort-alpha">Sort A–Z</button>
            <button class="group-editor-tool" type="button" data-group-editor-action="sort-origin">By source</button>
            <button class="group-editor-tool" type="button" data-group-editor-action="restore-order">Original order</button>
          </div>
          <div class="group-editor-list"></div>
          <div class="section">With selected tags</div>
          <div class="group-editor-bulk">
            <select class="select group-editor-target" aria-label="Destination group"></select>
            <button class="group-editor-action" type="button" data-group-editor-action="move">Move there</button>
          </div>
          <div class="group-editor-secondary">
            <button class="group-editor-action" type="button" data-group-editor-action="new-group">Split off</button>
            <button class="group-editor-action exclude" type="button" data-group-editor-action="exclude">Exclude</button>
            <button class="group-editor-action remove" type="button" data-group-editor-action="remove">Remove</button>
          </div>
          <div class="section">Reusable groups</div>
          <div class="group-library editor">
            <select class="select group-preset-select group-preset-editor" aria-label="Reusable tag groups"><option value="">Reusable groups…</option></select>
            <button class="group-preset-btn group-preset-save" type="button" title="Save this group so you can insert it into other filters">Save this group</button>
            <button class="group-preset-btn group-preset-editor-insert" type="button" disabled>Insert</button>
            <button class="group-preset-btn group-preset-replace" type="button" disabled>Replace</button>
            <button class="group-preset-btn group-preset-editor-delete group-preset-delete" type="button" disabled>Delete</button>
          </div>
        </div>
        <div class="expression-view">
          <div class="subhead"><button class="back expression-back" type="button" aria-label="Back to tags">${backIcon}</button><span class="subtitle">Filter as text</span></div>
          <textarea class="expression-input" spellcheck="false" aria-label="Readable tag-filter expression"></textarea>
          <div class="expression-status"></div>
          <div class="expression-actions">
            <button class="group-preset-btn expression-refresh" type="button" title="Replace the text with the current filter">Refresh</button>
            <button class="group-preset-btn expression-copy" type="button">Copy</button>
            <button class="group-preset-btn expression-import" type="button" title="Replace the current draft with the text above">Use this text</button>
          </div>
          <div class="expression-help">Share a filter by copying this text. Groups go in parentheses, <code>OR</code> joins tags inside a group, <code>AND</code> joins groups, and <code>AND NOT (…)</code> lists excluded tags.</div>
        </div>
        <div class="facet-view">
          <div class="subhead"><button class="back" type="button" aria-label="Back to tags">${backIcon}</button><span class="subtitle facet-title">More filters</span></div>
          <div class="section">Creators</div>
          <div class="facet-section">
            <label class="facet-label" for="cllp-creators-in">Only these creators</label>
            <input class="facet-input" id="cllp-creators-in" data-facet="creatorsInclude" placeholder="alice, bob" autocomplete="off" />
            <div class="facet-note">Comma-separated CivitAI usernames.</div>
          </div>
          <div class="facet-section">
            <label class="facet-label" for="cllp-creators-out">Hide these creators</label>
            <input class="facet-input" id="cllp-creators-out" data-facet="creatorsExclude" placeholder="username" autocomplete="off" />
          </div>
          <div class="section">Shape</div>
          <div class="facet-section">
            <div class="facet-pills" role="group" aria-label="Allowed orientations">
              <button class="orientation-btn" data-orientation="portrait" type="button" aria-pressed="false">Portrait</button>
              <button class="orientation-btn" data-orientation="square" type="button" aria-pressed="false">Square</button>
              <button class="orientation-btn" data-orientation="landscape" type="button" aria-pressed="false">Landscape</button>
            </div>
          </div>
          <div class="section">At least</div>
          <div class="facet-section facet-metrics">
            <label><span class="facet-label">Reactions</span><input class="facet-input" data-facet-number="minReactions" type="number" min="0" step="1" inputmode="numeric" placeholder="any" /></label>
            <label><span class="facet-label">Views</span><input class="facet-input" data-facet-number="minViews" type="number" min="0" step="1" inputmode="numeric" placeholder="any" /></label>
            <label><span class="facet-label">Comments</span><input class="facet-input" data-facet-number="minComments" type="number" min="0" step="1" inputmode="numeric" placeholder="any" /></label>
            <label><span class="facet-label">Collections</span><input class="facet-input" data-facet-number="minCollections" type="number" min="0" step="1" inputmode="numeric" placeholder="any" /></label>
          </div>
          <div class="section">Source</div>
          <div class="facet-section facet-pills">
            <label class="facet-check"><input data-facet-check="hasMeta" type="checkbox" />Has generation data</label>
            <label class="facet-check"><input data-facet-check="onSite" type="checkbox" />Made on CivitAI</label>
          </div>
          <div class="section">Models &amp; resources</div>
          <div class="facet-section resource-picker">
            <div class="resource-selections"></div>
            <input class="facet-input resource-search" type="search" placeholder="Search models, LoRAs, embeddings…" autocomplete="off" />
            <div class="resource-results"></div>
            <div class="facet-note">“Model” requires that checkpoint; “Any” matches items using any of the listed resources.</div>
          </div>
        </div>
        <div class="history" aria-label="Filter draft history">
          <span class="history-summary"></span>
          <button class="history-btn undo" type="button" title="Undo the last change to this draft">Undo</button>
          <button class="history-btn redo" type="button" title="Redo">Redo</button>
          <button class="history-btn revert" type="button" title="Discard draft changes and go back to what's applied">Revert</button>
        </div>
        <div class="actions">
          <button class="btn apply" disabled>Apply</button>
          <button class="btn clear" title="Remove every tag and filter from the draft">Clear</button>
        </div>
        <div class="hint"></div>
      </div>
    `;

    this.panelEl = this.root.querySelector('.panel')!;
    this.chipsEl = this.root.querySelector('.chips')!;
    this.dragStatusEl = this.root.querySelector('.drag-status')!;
    this.trayEl = this.root.querySelector('.tray')!;
    this.menuEl = this.root.querySelector('.menu')!;
    this.inputEl = this.root.querySelector('.in')!;
    this.dropdownEl = this.root.querySelector('.dropdown')!;
    this.applyBtn = this.root.querySelector('.apply')!;
    this.presetSelectEl = this.root.querySelector('.preset-select')!;
    this.presetLoadBtn = this.root.querySelector('.preset-load')!;
    this.presetSaveBtn = this.root.querySelector('.preset-save')!;
    this.presetDeleteBtn = this.root.querySelector('.preset-delete')!;
    this.groupPresetSelectEl = this.root.querySelector('.group-preset-main')!;
    this.groupPresetEditorSelectEl = this.root.querySelector('.group-preset-editor')!;
    this.expressionViewEl = this.root.querySelector('.expression-view')!;
    this.expressionInputEl = this.root.querySelector('.expression-input')!;
    this.expressionStatusEl = this.root.querySelector('.expression-status')!;
    this.hintEl = this.root.querySelector('.hint')!;
    this.explainerEl = this.root.querySelector('.explainer')!;
    this.modeBtns = this.root.querySelectorAll('.seg-btn');
    this.modeEl = this.root.querySelector('.mode')!;
    this.presetRowEl = this.root.querySelector('.preset-row')!;
    this.groupLibraryEl = this.root.querySelector('.group-library:not(.editor)')!;
    this.tagViewEl = this.root.querySelector('.tag-view')!;
    this.groupViewEl = this.root.querySelector('.group-view')!;
    this.groupEditorTitleEl = this.root.querySelector('.group-editor-title')!;
    this.groupEditorSearchEl = this.root.querySelector('.group-editor-search')!;
    this.groupEditorListEl = this.root.querySelector('.group-editor-list')!;
    this.groupEditorCountEl = this.root.querySelector('.group-editor-count')!;
    this.groupEditorTargetEl = this.root.querySelector('.group-editor-target')!;
    this.historySummaryEl = this.root.querySelector('.history-summary')!;
    this.undoBtn = this.root.querySelector('.history-btn.undo')!;
    this.redoBtn = this.root.querySelector('.history-btn.redo')!;
    this.revertBtn = this.root.querySelector('.history-btn.revert')!;
    this.facetViewEl = this.root.querySelector('.facet-view')!;
    this.facetSummaryEl = this.root.querySelector('.facet-summary')!;
    this.facetBadgeEl = this.root.querySelector('.facet-badge')!;
    this.facetCreatorIncludeEl = this.root.querySelector('[data-facet="creatorsInclude"]')!;
    this.facetCreatorExcludeEl = this.root.querySelector('[data-facet="creatorsExclude"]')!;
    this.facetNumberEls = this.root.querySelectorAll('[data-facet-number]');
    this.facetCheckEls = this.root.querySelectorAll('[data-facet-check]');
    this.orientationBtns = this.root.querySelectorAll('.orientation-btn');
    this.resourceSearchEl = this.root.querySelector('.resource-search')!;
    this.resourceResultsEl = this.root.querySelector('.resource-results')!;
    this.resourceSelectionsEl = this.root.querySelector('.resource-selections')!;

    // Permanent listeners (bound once; transient content uses delegation).
    this.root.querySelector('.x')!.addEventListener('click', () => this.setExpanded(false));
    this.root.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (this.dropdownEl.style.display === 'block') this.closeDropdown();
      else if (this.menuEl.style.display === 'block') this.closeMenu();
      else if (this.groupEditorOpen) this.closeGroupEditor();
      else if (this.facetEditorOpen) this.setFacetEditorOpen(false);
      else if (this.expressionEditorOpen) this.setExpressionEditorOpen(false);
      else this.setExpanded(false);
    });

    this.inputEl.addEventListener('input', () => this.showSuggestions(this.inputEl.value));
    this.inputEl.addEventListener('focus', () => this.showSuggestions(this.inputEl.value));
    this.inputEl.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.inputEl.addEventListener('blur', () => {
      // Delay so a click on an option still registers before we close.
      this.blurTimer = this.ctx.setTimeout(() => {
        if (this.root.activeElement !== this.inputEl) this.closeDropdown();
      }, 150);
    });

    // Keep input focused when clicking an option (prevents blur flicker), then select.
    this.dropdownEl.addEventListener('mousedown', (e) => e.preventDefault());
    this.dropdownEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action][data-id]') as HTMLElement | null;
      if (!btn) return;
      const tag = this.currentOptions.find((t) => t.id === Number(btn.dataset.id));
      if (!tag) return;
      if (btn.dataset.action === 'group') this.selectOption(tag, 'group');
      else if (btn.dataset.action === 'exclude') this.selectOption(tag, 'exclude');
      else if (btn.dataset.action === 'similar') this.addWithSimilar(tag);
      else this.selectOption(tag, 'include');
    });

    // Chip interactions: the tag name opens a small action menu (regroup/exclude/…), the × removes.
    const onChipAreaClick = (e: Event) => {
      const groupEdit = (e.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-edit-group]'
      );
      if (groupEdit) {
        this.openGroupEditor(Number(groupEdit.dataset.editGroup));
        return;
      }
      const groupHealth = (e.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-review-group]'
      );
      if (groupHealth) {
        this.openGroupEditor(Number(groupHealth.dataset.reviewGroup), true);
        return;
      }
      const bundleToggle = (e.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-toggle-bundle]'
      );
      if (bundleToggle) {
        const seedId = Number(bundleToggle.dataset.toggleBundle);
        if (this.expandedBundleSeeds.has(seedId)) this.expandedBundleSeeds.delete(seedId);
        else this.expandedBundleSeeds.add(seedId);
        this.renderChips();
        return;
      }
      const groupToggle = (e.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-toggle-group]'
      );
      if (groupToggle) {
        this.toggleGroupExpanded(Number(groupToggle.dataset.toggleGroup));
        return;
      }
      const groupButton = (e.target as HTMLElement).closest<HTMLButtonElement>(
        'button.group-grip[data-group]'
      );
      if (groupButton) {
        this.openGroupMenu(groupButton, Number(groupButton.dataset.group));
        return;
      }
      const btn = (e.target as HTMLElement).closest('button[data-id]') as HTMLElement | null;
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const kind = (btn.dataset.kind ?? 'pos') as ChipKind;
      const trayAction = btn.dataset.trayAction;
      if (kind === 'tray' && trayAction) {
        if (trayAction === 'more') this.openTrayMoreMenu(btn, id);
        else this.onMenuAction(trayAction, id, kind);
        return;
      }
      if (btn.classList.contains('name')) {
        this.openChipMenu(btn, kind, id);
        return;
      }
      if (kind === 'neg') this.removeNegative(id);
      else if (kind === 'tray') this.removeFromTray(id);
      else this.removePositive(Number(btn.dataset.group), id);
    };
    this.chipsEl.addEventListener('click', onChipAreaClick);
    this.trayEl.addEventListener('click', onChipAreaClick);
    this.chipsEl.addEventListener('dragstart', (e) => this.onChipDragStart(e as DragEvent));
    this.chipsEl.addEventListener('dragover', (e) => this.onChipDragOver(e as DragEvent));
    this.chipsEl.addEventListener('dragleave', (e) => this.onChipDragLeave(e as DragEvent));
    this.chipsEl.addEventListener('drop', (e) => this.onChipDrop(e as DragEvent));
    this.chipsEl.addEventListener('dragend', () => this.finishChipDrag());

    this.menuEl.addEventListener('click', (e) => {
      const groupBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(
        'button[data-menu-group-action]'
      );
      if (groupBtn) {
        this.mergeGroups(
          Number(groupBtn.dataset.sourceGroup),
          Number(groupBtn.dataset.targetGroup)
        );
        return;
      }
      const btn = (e.target as HTMLElement).closest('button[data-menu-action]') as HTMLElement | null;
      if (!btn) return;
      this.onMenuAction(
        btn.dataset.menuAction!,
        Number(btn.dataset.id),
        (btn.dataset.kind ?? 'pos') as ChipKind,
        btn.dataset.group === undefined ? undefined : Number(btn.dataset.group)
      );
    });

    this.modeBtns.forEach((b) =>
      b.addEventListener('click', () => this.setMode(b.dataset.mode as TagMode))
    );
    this.applyBtn.addEventListener('click', () => this.apply());
    this.undoBtn.addEventListener('click', () => this.undoDraft());
    this.redoBtn.addEventListener('click', () => this.redoDraft());
    this.revertBtn.addEventListener('click', () => this.revertDraft());
    this.root.querySelector('.clear')!.addEventListener('click', () => this.clearSelection());
    this.presetSelectEl.addEventListener('change', () => this.updatePresetButtons());
    this.presetLoadBtn.addEventListener('click', () => this.loadSelectedPreset());
    this.presetSaveBtn.addEventListener('click', () => void this.savePreset());
    this.presetDeleteBtn.addEventListener('click', () => void this.deleteSelectedPreset());
    this.groupPresetSelectEl.addEventListener('change', () => {
      this.groupPresetEditorSelectEl.value = this.groupPresetSelectEl.value;
      this.updateGroupPresetButtons();
    });
    this.groupPresetEditorSelectEl.addEventListener('change', () => {
      this.groupPresetSelectEl.value = this.groupPresetEditorSelectEl.value;
      this.updateGroupPresetButtons();
    });
    this.root.querySelector('.group-preset-insert')!.addEventListener('click', () => this.insertSelectedGroupPreset());
    this.root.querySelector('.group-preset-editor-insert')!.addEventListener('click', () => this.insertSelectedGroupPreset());
    this.root.querySelector('.group-preset-save')!.addEventListener('click', () => void this.saveFocusedGroupPreset());
    this.root.querySelector('.group-preset-replace')!.addEventListener('click', () => this.replaceWithSelectedGroupPreset());
    this.root.querySelector('.group-library:not(.editor) .group-preset-delete')!.addEventListener('click', () => void this.deleteSelectedGroupPreset());
    this.root.querySelector('.group-preset-editor-delete')!.addEventListener('click', () => void this.deleteSelectedGroupPreset());
    this.root.querySelector('.expression-open')!.addEventListener('click', () => this.setExpressionEditorOpen(true));
    this.root.querySelector('.expression-back')!.addEventListener('click', () => this.setExpressionEditorOpen(false));
    this.root.querySelector('.expression-refresh')!.addEventListener('click', () => this.exportExpression());
    this.root.querySelector('.expression-copy')!.addEventListener('click', () => void this.copyExpression());
    this.root.querySelector('.expression-import')!.addEventListener('click', () => this.importExpression());
    this.expressionInputEl.addEventListener('input', () => this.previewExpression());
    this.root.querySelector('.more-filters')!.addEventListener('click', () => this.setFacetEditorOpen(true));
    this.root.querySelector('.back')!.addEventListener('click', () => this.setFacetEditorOpen(false));
    this.root.querySelector('.group-editor-back')!.addEventListener('click', () => this.closeGroupEditor());
    this.groupEditorSearchEl.addEventListener('input', () => this.renderGroupEditor());
    this.groupEditorListEl.addEventListener('change', (event) => {
      const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>('[data-group-tag-id]');
      if (!checkbox) return;
      const id = Number(checkbox.dataset.groupTagId);
      if (checkbox.checked) this.groupEditorSelection.add(id);
      else this.groupEditorSelection.delete(id);
      this.updateGroupEditorControls();
    });
    this.groupViewEl.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-group-editor-action]');
      if (button) this.onGroupEditorAction(button.dataset.groupEditorAction!);
    });
    // The resource search box lives inside the facet view but is a lookup, not a facet value —
    // its keystrokes must not record history (which would also clear the redo stack).
    const onFacetEdit = (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest('.resource-search')) return;
      this.updateFacetsFromEditor();
    };
    this.facetViewEl.addEventListener('input', onFacetEdit);
    this.facetViewEl.addEventListener('change', onFacetEdit);
    this.orientationBtns.forEach((button) =>
      button.addEventListener('click', () => {
        const active = !button.classList.contains('active');
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        this.updateFacetsFromEditor();
      })
    );
    this.resourceSearchEl.addEventListener('input', () => this.searchResources(this.resourceSearchEl.value));
    this.resourceResultsEl.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-resource-action][data-version-id]');
      if (!button) return;
      const resource = this.resourceOptions.find((option) => option.versionId === Number(button.dataset.versionId));
      if (resource) this.assignResource(resource, button.dataset.resourceAction as 'primary' | 'include' | 'exclude');
    });
    this.resourceSelectionsEl.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-resource]');
      if (!button) return;
      this.removeResource(button.dataset.removeResource!, Number(button.dataset.versionId));
    });
  }

  // --- URL <-> state ---

  private captureDraft(): FilterDraftSnapshot {
    return {
      positiveGroups: this.positiveGroups.map((group) => group.map((tag) => ({ ...tag }))),
      excluded: this.excluded.map((tag) => ({ ...tag })),
      mode: this.mode,
      facets: normalizeFeedFacetFilter(this.facets),
      bundles: this.tagBundles.map((bundle) => ({ ...bundle, tagIds: [...bundle.tagIds] })),
    };
  }

  private draftIdentity(snapshot: FilterDraftSnapshot): string {
    return JSON.stringify({
      groups: snapshot.positiveGroups.map((group) => group.map((tag) => tag.id)),
      excluded: snapshot.excluded.map((tag) => tag.id),
      mode: snapshot.mode,
      facets: normalizeFeedFacetFilter(snapshot.facets),
      bundles: snapshot.bundles,
    });
  }

  private sameDraft(a: FilterDraftSnapshot, b: FilterDraftSnapshot): boolean {
    return this.draftIdentity(a) === this.draftIdentity(b);
  }

  private recordHistory(coalesceKey?: string) {
    const now = Date.now();
    if (
      coalesceKey &&
      this.lastHistoryKey === coalesceKey &&
      now - this.lastHistoryAt < 800
    ) {
      this.lastHistoryAt = now;
      return;
    }
    const current = this.captureDraft();
    const previous = this.undoStack[this.undoStack.length - 1];
    if (!previous || !this.sameDraft(previous, current)) this.undoStack.push(current);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.lastHistoryKey = coalesceKey;
    this.lastHistoryAt = now;
    this.updateHistoryControls();
  }

  private restoreDraft(snapshot: FilterDraftSnapshot) {
    if (this.groupEditorOpen) this.closeGroupEditor();
    this.positiveGroups = snapshot.positiveGroups.map((group) =>
      group.map((tag) => ({ ...tag, name: this.nameMap.get(tag.id) ?? tag.name }))
    );
    this.excluded = snapshot.excluded.map((tag) => ({
      ...tag,
      name: this.nameMap.get(tag.id) ?? tag.name,
    }));
    this.mode = snapshot.mode;
    this.facets = normalizeFeedFacetFilter(snapshot.facets);
    this.tagBundles = snapshot.bundles.map((bundle) => ({
      ...bundle,
      tagIds: [...bundle.tagIds],
    }));
    for (const tag of [...this.positiveGroups.flat(), ...this.excluded]) {
      this.nameMap.set(tag.id, tag.name);
    }
    this.renderChips();
    this.updateModeButtons();
    this.renderFacetEditor();
    this.resolveSelectedNames([...this.positiveGroups.flat(), ...this.excluded].map((tag) => tag.id));
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private resetDraftHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this.lastHistoryKey = undefined;
    this.lastHistoryAt = 0;
    this.appliedDraft = this.captureDraft();
    this.updateHistoryControls();
  }

  private undoDraft() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.captureDraft());
    this.lastHistoryKey = undefined;
    this.restoreDraft(previous);
  }

  private redoDraft() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.captureDraft());
    this.lastHistoryKey = undefined;
    this.restoreDraft(next);
  }

  private revertDraft() {
    if (!this.appliedDraft || this.sameDraft(this.captureDraft(), this.appliedDraft)) return;
    this.recordHistory();
    this.restoreDraft(this.appliedDraft);
  }

  private updateHistoryControls() {
    if (!this.historySummaryEl) return;
    const current = this.captureDraft();
    const dirty = !!this.appliedDraft && !this.sameDraft(current, this.appliedDraft);
    const tagCount = this.positiveGroups.flat().length;
    const parts = [
      `${this.positiveGroups.length} ${this.positiveGroups.length === 1 ? 'group' : 'groups'}`,
      `${tagCount} ${tagCount === 1 ? 'tag' : 'tags'}`,
    ];
    if (this.excluded.length) parts.push(`${this.excluded.length} excluded`);
    const facetCount = feedFacetCount(this.facets);
    if (facetCount) parts.push(`${facetCount} more`);
    this.historySummaryEl.textContent = `${dirty ? 'Draft' : 'Applied'} · ${parts.join(' · ')}`;
    this.historySummaryEl.classList.toggle('dirty', dirty);
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
    this.revertBtn.disabled = !dirty;
  }

  /** Re-read applied tags + mode from the URL (or, on detail pages, the last applied filter). */
  refreshFromUrl() {
    // CivitAI's own navigation keeps `tags=` but drops our markers; if this is the filter we
    // last applied, put them back before the site (or our interceptor) fetches the feed.
    if (this.pageMode === 'feed') {
      const restored = restoreStrippedFeedFilterInPlace(window, FEED_FACET_PARAMS);
      if (restored) tagFilterLog('restored stripped filter markers', { href: restored });
    }
    const groups = parseTagGroupsFromSearch(location.search);
    const bundles = parseTagBundlesFromSearch(location.search);
    const negativeIds = parseNegativeTagsFromSearch(location.search);
    const facets = parseFeedFacetsFromSearch(location.search);
    if (!groups.length && !negativeIds.length && !hasFeedFacets(facets) && this.pageMode === 'detail') {
      // Detail URLs carry no filter — continue editing the one the user last applied.
      feedLastFilterStorage.getValue().then((last) => {
        this.applySelection(last.groups, last.negatives, last.mode, last.facets, last.bundles);
      });
      return;
    }
    const ids = [...groups.flat(), ...negativeIds];
    // Only let the URL override the mode when it explicitly carries one — buildHrefWithTagFilter
    // omits `tagmode` for <2 tags (where it makes no difference), and treating that absence
    // as "any" would clobber the user's persisted All preference on every single-tag apply.
    const searchParams = new URLSearchParams(location.search);
    const urlHasMode = searchParams.has('tagmode');
    const mode = ids.length && urlHasMode ? parseModeFromSearch(location.search) : this.mode;
    // Detect a site navigation that kept `tags` but stripped our extension params (and that
    // the stash above could not repair): the widget would keep displaying All/negatives while
    // the actual feed runs native tag matching. Only the SAME tag set we were just showing counts — a
    // different set (site tag chip, shared link) is a new filter, not a stripped one.
    const previousIds = this.positiveGroups.flat().map((tag) => tag.id).sort((a, b) => a - b);
    const urlIds = [...groups.flat()].sort((a, b) => a - b);
    const sameTags =
      previousIds.length > 0 &&
      previousIds.length === urlIds.length &&
      previousIds.every((id, index) => id === urlIds[index]);
    const degraded =
      sameTags &&
      ((groups.flat().length >= 2 && !urlHasMode &&
        (this.mode === 'all' || !searchParams.has('taggroups'))) ||
        (this.excluded.length > 0 && !negativeIds.length));
    if (degraded) {
      reportSiteIssue(
        'feed-params-stripped',
        'CivitAI navigation dropped the tag-filter markers from the URL — group matching may be wrong. Re-apply the filter to restore it.'
      );
    }
    this.applySelection(groups, negativeIds, mode, facets, bundles);
    // Remember the applied filter so detail pages (and the next session) can build on it.
    if (this.pageMode === 'feed' && (ids.length || hasFeedFacets(facets)) && !degraded) {
      feedLastFilterStorage.setValue({
        v: 3,
        groups,
        negatives: negativeIds,
        mode,
        kind: getFeedKind(location.pathname) ?? 'images',
        bundles,
        facets,
      });
      writeFeedFilterStash(localStorage, { groups, negatives: negativeIds, mode, bundles, facets });
    }
  }

  private applySelection(
    groups: number[][],
    negativeIds: number[],
    mode: TagMode,
    facets?: Partial<FeedFacetFilter> | null,
    bundles: FeedTagBundle[] = []
  ) {
    if (this.groupEditorOpen) this.closeGroupEditor();
    const ids = [...groups.flat(), ...negativeIds];
    this.positiveGroups = groups.map((group) =>
      group.map((id) => ({ id, name: this.nameMap.get(id) ?? `#${id}` }))
    );
    this.excluded = negativeIds.map((id) => ({ id, name: this.nameMap.get(id) ?? `#${id}` }));
    this.mode = mode;
    this.facets = normalizeFeedFacetFilter(facets);
    this.tagBundles = bundles.map((bundle) => ({ ...bundle, tagIds: [...bundle.tagIds] }));
    this.renderChips();
    this.resolveSelectedNames(ids);
    this.updateModeButtons();
    this.renderFacetEditor();
    this.resetDraftHistory();
    this.updateActionState();
    this.updateFeedSwitcher();
    this.scheduleFeedSwitcherRefreshes();
  }

  private appliedIds(): number[] {
    return parseTagsFromSearch(location.search).sort((a, b) => a - b);
  }

  private selectedIds(): number[] {
    return this.positiveGroups.flat().map((t) => t.id).sort((a, b) => a - b);
  }

  private excludedIds(): number[] {
    return this.excluded.map((t) => t.id).sort((a, b) => a - b);
  }

  private selectedGroups(): number[][] {
    return this.positiveGroups
      .map((group) => group.map((t) => t.id).sort((a, b) => a - b))
      .sort(compareNumberArrays);
  }

  private effectiveBundles(bundles = this.tagBundles): FeedTagBundle[] {
    const positiveIds = new Set(this.positiveGroups.flat().map((tag) => tag.id));
    return bundles
      .map((bundle) => ({
        seedId: bundle.seedId,
        tagIds: [...new Set(bundle.tagIds)].filter((id) => positiveIds.has(id)).sort((a, b) => a - b),
      }))
      .filter((bundle) => bundle.tagIds.includes(bundle.seedId) && bundle.tagIds.length > 1)
      .sort((a, b) => a.seedId - b.seedId);
  }

  private get dirty(): boolean {
    // On a detail page "Apply" always means "go to the feed with this filter".
    if (this.pageMode === 'detail') {
      return this.positiveGroups.length > 0 || this.excluded.length > 0 || hasFeedFacets(this.facets);
    }
    if (!sameFeedFacets(parseFeedFacetsFromSearch(location.search), this.facets)) return true;
    const a = this.appliedIds();
    const b = this.selectedIds();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) return true;
    const appliedGroups = parseTagGroupsFromSearch(location.search)
      .map((group) => [...group].sort((x, y) => x - y))
      .sort(compareNumberArrays);
    const selectedGroups = this.selectedGroups();
    if (!sameNumberGroups(appliedGroups, selectedGroups)) return true;
    const appliedNegatives = parseNegativeTagsFromSearch(location.search).sort((x, y) => x - y);
    const negatives = this.excludedIds();
    if (appliedNegatives.length !== negatives.length || appliedNegatives.some((x, i) => x !== negatives[i])) {
      return true;
    }
    const appliedBundles = this.effectiveBundles(parseTagBundlesFromSearch(location.search));
    if (JSON.stringify(appliedBundles) !== JSON.stringify(this.effectiveBundles())) return true;
    // Same tags, but a mode flip changes the URL only when ≥2 tags are selected.
    return this.positiveGroups.flat().length >= 2 && this.mode !== parseModeFromSearch(location.search);
  }

  // --- mutations (incremental patches, no full re-render) ---

  private add(tag: FeedTag, record = true) {
    if (this.hasSelectedTag(tag.id)) return;
    if (record) this.recordHistory();
    this.positiveGroups.push([tag]);
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private addToOrGroup(tag: FeedTag, record = true) {
    if (this.hasSelectedTag(tag.id)) return;
    if (record) this.recordHistory();
    const last = this.positiveGroups[this.positiveGroups.length - 1];
    if (last) last.push(tag);
    else this.positiveGroups.push([tag]);
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private addNegative(tag: FeedTag, record = true) {
    if (this.hasSelectedTag(tag.id)) return;
    if (record) this.recordHistory();
    this.excluded.push(tag);
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private hasSelectedTag(id: number): boolean {
    return this.positiveGroups.some((group) => group.some((t) => t.id === id)) || this.excluded.some((t) => t.id === id);
  }

  private removePositive(groupIndex: number, id: number, record = true) {
    if (!this.positiveGroups[groupIndex]?.some((tag) => tag.id === id)) return;
    if (record) this.recordHistory();
    this.positiveGroups = this.positiveGroups
      .map((group, i) => (i === groupIndex ? group.filter((t) => t.id !== id) : group))
      .filter((group) => group.length > 0);
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
    if (this.dropdownEl.style.display !== 'none') this.showSuggestions(this.inputEl.value);
  }

  private onChipDragStart(e: DragEvent) {
    const groupHandle = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      '.group-grip[data-group]'
    );
    if (groupHandle && e.dataTransfer) {
      const groupIndex = Number(groupHandle.dataset.group);
      const group = this.positiveGroups[groupIndex];
      if (!Number.isInteger(groupIndex) || !group) {
        e.preventDefault();
        return;
      }

      this.draggedGroupIndex = groupIndex;
      this.draggedTagId = undefined;
      this.draggedFromGroup = undefined;
      this.dragDropped = false;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `group:${groupIndex}`);
      groupHandle.setAttribute('aria-grabbed', 'true');
      groupHandle.closest('.group')?.classList.add('dragging');
      this.chipsEl.classList.add('group-drag-active');
      const names = group.map((tag) => this.nameMap.get(tag.id) ?? tag.name).join(' or ');
      this.dragStatusEl.textContent = `Moving OR group: ${names}. Drop onto another tag or OR group.`;
      return;
    }

    const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(
      '.chip[data-kind="pos"][data-id][data-group]'
    );
    if (!chip || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    const id = Number(chip.dataset.id);
    const groupIndex = Number(chip.dataset.group);
    if (!Number.isInteger(id) || !this.positiveGroups[groupIndex]?.some((tag) => tag.id === id)) {
      e.preventDefault();
      return;
    }

    this.draggedTagId = id;
    this.draggedFromGroup = groupIndex;
    this.draggedGroupIndex = undefined;
    this.dragDropped = false;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
    chip.classList.add('dragging');
    chip.setAttribute('aria-grabbed', 'true');
    this.chipsEl.classList.add('drag-active');
    this.chipsEl.classList.toggle('can-split', this.positiveGroups[groupIndex].length > 1);
    this.chipsEl.querySelector('.and-dropzone')?.setAttribute('aria-hidden', 'false');

    const tag = this.positiveGroups[groupIndex].find((candidate) => candidate.id === id);
    if (tag) {
      const suffix =
        this.positiveGroups[groupIndex].length > 1
          ? ' Drop onto another tag or OR group, or use the separate AND target.'
          : ' Drop onto another tag or OR group.';
      this.dragStatusEl.textContent = `Moving ${this.nameMap.get(id) ?? tag.name}.${suffix}`;
    }
  }

  private onChipDragOver(e: DragEvent) {
    const target = this.dropTargetFor(e.target);
    this.clearDropHighlights();
    if (!target || !this.validDropTarget(target.groupIndex)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    target.element.classList.add('drop-target');
  }

  private onChipDragLeave(e: DragEvent) {
    const related = e.relatedTarget;
    if (related instanceof Node && this.chipsEl.contains(related)) return;
    this.clearDropHighlights();
  }

  private onChipDrop(e: DragEvent) {
    const target = this.dropTargetFor(e.target);
    if (
      this.draggedGroupIndex !== undefined &&
      target?.groupIndex !== null &&
      target?.groupIndex !== undefined &&
      this.validDropTarget(target.groupIndex)
    ) {
      e.preventDefault();
      const sourceGroupIndex = this.draggedGroupIndex;
      const targetGroupIndex = target.groupIndex;
      this.dragDropped = true;
      this.finishChipDrag();
      this.mergeGroups(sourceGroupIndex, targetGroupIndex);
      return;
    }
    if (
      this.draggedTagId === undefined ||
      !target ||
      !this.validDropTarget(target.groupIndex)
    ) {
      return;
    }
    e.preventDefault();
    const tag = this.positiveGroups
      .flat()
      .find((candidate) => candidate.id === this.draggedTagId);
    if (!tag) return;

    const targetLabel =
      target.groupIndex === null
        ? ''
        : this.positiveGroups[target.groupIndex]
            .map((candidate) => this.nameMap.get(candidate.id) ?? candidate.name)
            .join(' or ');
    this.recordHistory();
    this.positiveGroups = moveFeedTagBetweenGroups(
      this.positiveGroups,
      this.draggedTagId,
      target.groupIndex
    );
    this.dragDropped = true;
    this.finishChipDrag();
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
    if (this.dropdownEl.style.display !== 'none') this.showSuggestions(this.inputEl.value);

    const name = this.nameMap.get(tag.id) ?? tag.name;
    this.dragStatusEl.textContent =
      target.groupIndex === null
        ? `${name} is now a separate AND tag.`
        : `${name} moved into the OR group containing ${targetLabel}.`;
  }

  private dropTargetFor(
    rawTarget: EventTarget | null
  ): { element: HTMLElement; groupIndex: number | null } | null {
    const element = rawTarget instanceof HTMLElement ? rawTarget : null;
    if (!element) return null;
    const standalone = element.closest<HTMLElement>('.and-dropzone');
    if (standalone) return { element: standalone, groupIndex: null };
    const group = element.closest<HTMLElement>('.group[data-group]');
    if (group) return { element: group, groupIndex: Number(group.dataset.group) };
    const chip = element.closest<HTMLElement>('.chip[data-kind="pos"][data-group]');
    if (chip) return { element: chip, groupIndex: Number(chip.dataset.group) };
    return null;
  }

  private validDropTarget(groupIndex: number | null): boolean {
    if (this.draggedGroupIndex !== undefined) {
      return (
        groupIndex !== null &&
        Number.isInteger(groupIndex) &&
        groupIndex !== this.draggedGroupIndex &&
        this.positiveGroups[groupIndex] !== undefined
      );
    }
    if (this.draggedTagId === undefined || this.draggedFromGroup === undefined) return false;
    if (groupIndex === null) return this.positiveGroups[this.draggedFromGroup]?.length > 1;
    return (
      Number.isInteger(groupIndex) &&
      groupIndex !== this.draggedFromGroup &&
      this.positiveGroups[groupIndex] !== undefined
    );
  }

  private clearDropHighlights() {
    this.chipsEl
      .querySelectorAll('.drop-target')
      .forEach((element) => element.classList.remove('drop-target'));
  }

  private finishChipDrag() {
    this.clearDropHighlights();
    this.chipsEl.classList.remove('drag-active', 'group-drag-active', 'can-split');
    this.chipsEl.querySelector('.and-dropzone')?.setAttribute('aria-hidden', 'true');
    this.chipsEl.querySelectorAll('[aria-grabbed="true"]').forEach((element) => {
      element.removeAttribute('aria-grabbed');
      element.classList.remove('dragging');
    });
    this.chipsEl.querySelectorAll('.group.dragging').forEach((element) => {
      element.classList.remove('dragging');
    });
    if (!this.dragDropped) {
      if (this.draggedTagId !== undefined) this.dragStatusEl.textContent = 'Tag move cancelled.';
      else if (this.draggedGroupIndex !== undefined) this.dragStatusEl.textContent = 'Group merge cancelled.';
    }
    this.draggedTagId = undefined;
    this.draggedFromGroup = undefined;
    this.draggedGroupIndex = undefined;
    this.dragDropped = false;
  }

  private mergeGroups(sourceGroupIndex: number, targetGroupIndex: number) {
    this.closeMenu();
    const source = this.positiveGroups[sourceGroupIndex];
    const target = this.positiveGroups[targetGroupIndex];
    if (!source || !target || sourceGroupIndex === targetGroupIndex) return;
    this.recordHistory();

    const targetLabel = target
      .map((tag) => this.nameMap.get(tag.id) ?? tag.name)
      .join(' or ');
    const sourceSize = source.length;
    this.positiveGroups = mergeFeedTagGroups(
      this.positiveGroups,
      sourceGroupIndex,
      targetGroupIndex
    );
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
    if (this.dropdownEl.style.display !== 'none') this.showSuggestions(this.inputEl.value);
    this.dragStatusEl.textContent = `Merged the ${sourceSize}-tag OR group into the group containing ${targetLabel}.`;
  }

  private groupKey(group: FeedTag[]): string {
    return group.map((tag) => tag.id).sort((a, b) => a - b).join(',');
  }

  private toggleGroupExpanded(groupIndex: number) {
    const group = this.positiveGroups[groupIndex];
    if (!group || group.length <= LARGE_GROUP_THRESHOLD) return;
    const key = this.groupKey(group);
    if (this.expandedGroupKeys.has(key)) this.expandedGroupKeys.delete(key);
    else this.expandedGroupKeys.add(key);
    // Bound persisted UI history while retaining the most recently toggled group keys.
    const expandedGroupKeys = [...this.expandedGroupKeys].slice(-50);
    this.expandedGroupKeys = new Set(expandedGroupKeys);
    feedFilterUiStorage.getValue().then((ui) =>
      feedFilterUiStorage.setValue({ ...ui, expandedGroupKeys })
    );
    this.renderChips();
  }

  private removeNegative(id: number, record = true) {
    if (!this.excluded.some((tag) => tag.id === id)) return;
    if (record) this.recordHistory();
    this.excluded = this.excluded.filter((t) => t.id !== id);
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
    if (this.dropdownEl.style.display !== 'none') this.showSuggestions(this.inputEl.value);
  }

  private clearSelection() {
    if (!this.positiveGroups.length && !this.excluded.length && !hasFeedFacets(this.facets)) return;
    this.recordHistory();
    if (this.groupEditorOpen) this.closeGroupEditor();
    this.positiveGroups = [];
    this.excluded = [];
    this.tagBundles = [];
    this.facets = normalizeFeedFacetFilter(null);
    this.renderChips();
    this.renderFacetEditor();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  // --- named filter presets ---

  private suggestedPresetName(): string {
    const positive = this.positiveGroups
      .map((group) => group.map((tag) => this.nameMap.get(tag.id) ?? tag.name).join(' or '))
      .join(this.mode === 'all' ? ' + ' : ' or ');
    const negative = this.excluded
      .map((tag) => `not ${this.nameMap.get(tag.id) ?? tag.name}`)
      .join(', ');
    return truncate([positive, negative, feedFacetSummary(this.facets)].filter(Boolean).join(' · '), 64);
  }

  private async savePreset() {
    if (!this.positiveGroups.length && !this.excluded.length && !hasFeedFacets(this.facets)) return;
    const entered = window.prompt('Name this feed-filter preset', this.suggestedPresetName());
    const name = entered?.trim().slice(0, 80);
    if (!name) return;

    const stored = await feedFilterPresetsStorage.getValue();
    const existing = stored.presets.find(
      (preset) => preset.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
    );
    const preset: FeedFilterPreset = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      groups: this.positiveGroups.map((group) => group.map((tag) => ({ ...tag }))),
      negatives: this.excluded.map((tag) => ({ ...tag })),
      mode: this.mode,
      bundles: this.effectiveBundles(),
      facets: normalizeFeedFacetFilter(this.facets),
    };
    const presets = existing
      ? stored.presets.map((candidate) => candidate.id === existing.id ? preset : candidate)
      : [...stored.presets, preset];
    this.presets = presets;
    await feedFilterPresetsStorage.setValue({ v: 3, presets });
    this.renderPresets(preset.id);
    this.hintEl.textContent = existing ? `Updated “${name}”` : `Saved “${name}”`;
  }

  private loadSelectedPreset() {
    const preset = this.presets.find((candidate) => candidate.id === this.presetSelectEl.value);
    if (!preset) return;
    this.recordHistory();
    this.positiveGroups = preset.groups.map((group) => group.map((tag) => ({ ...tag })));
    this.excluded = preset.negatives.map((tag) => ({ ...tag }));
    this.mode = preset.mode;
    this.tagBundles = (preset.bundles ?? []).map((bundle) => ({
      ...bundle,
      tagIds: [...bundle.tagIds],
    }));
    this.facets = normalizeFeedFacetFilter(preset.facets);
    for (const tag of [...this.positiveGroups.flat(), ...this.excluded]) {
      this.nameMap.set(tag.id, tag.name);
    }
    this.renderChips();
    this.updateModeButtons();
    this.renderFacetEditor();
    this.resolveSelectedNames([...this.positiveGroups.flat(), ...this.excluded].map((tag) => tag.id));
    this.updateActionState();
    this.updateFeedSwitcher();
    this.hintEl.textContent = `Loaded “${preset.name}” — press Apply to use it`;
  }

  private async deleteSelectedPreset() {
    const preset = this.presets.find((candidate) => candidate.id === this.presetSelectEl.value);
    if (!preset || !window.confirm(`Delete the saved filter “${preset.name}”?`)) return;
    const stored = await feedFilterPresetsStorage.getValue();
    const presets = stored.presets.filter((candidate) => candidate.id !== preset.id);
    this.presets = presets;
    await feedFilterPresetsStorage.setValue({ v: 3, presets });
    this.renderPresets();
    this.hintEl.textContent = `Deleted “${preset.name}”`;
  }

  // --- reusable OR-group presets ---

  private selectedGroupPreset(): FeedGroupPreset | undefined {
    return this.groupPresets.find((preset) => preset.id === this.groupPresetSelectEl.value);
  }

  private async saveFocusedGroupPreset() {
    const group = this.positiveGroups[this.groupEditorIndex];
    if (!this.groupEditorOpen || !group?.length) return;
    const suggestion = truncate(group.map((tag) => this.nameMap.get(tag.id) ?? tag.name).join(' or '), 64);
    const entered = window.prompt('Name this reusable OR group', suggestion);
    const name = entered?.trim().slice(0, 80);
    if (!name) return;
    const stored = await feedGroupPresetsStorage.getValue();
    const existing = stored.presets.find(
      (preset) => preset.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
    );
    const preset: FeedGroupPreset = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      tags: group.map((tag) => ({ id: tag.id, name: this.nameMap.get(tag.id) ?? tag.name })),
      bundles: this.activeBundlesForGroup(group).map((bundle) => ({
        seedId: bundle.seedId,
        tagIds: [...bundle.tagIds],
      })),
    };
    const presets = existing
      ? stored.presets.map((candidate) => candidate.id === existing.id ? preset : candidate)
      : [...stored.presets, preset];
    this.groupPresets = presets;
    await feedGroupPresetsStorage.setValue({ v: 1, presets });
    this.renderGroupPresets(preset.id);
    this.hintEl.textContent = existing ? `Updated group “${name}”` : `Saved group “${name}”`;
  }

  private appendPresetBundles(preset: FeedGroupPreset, allowedIds: Set<number>) {
    const additions = (preset.bundles ?? []).map((bundle) => ({
      seedId: bundle.seedId,
      tagIds: bundle.tagIds.filter((id) => allowedIds.has(id)),
    })).filter((bundle) => bundle.tagIds.length > 1 && bundle.tagIds.includes(bundle.seedId));
    this.tagBundles = [...this.effectiveBundles(), ...additions];
  }

  private insertSelectedGroupPreset() {
    const preset = this.selectedGroupPreset();
    if (!preset) return;
    const occupied = new Set([...this.positiveGroups.flat(), ...this.excluded].map((tag) => tag.id));
    const tags = preset.tags.filter((tag) => !occupied.has(tag.id)).map((tag) => ({ ...tag }));
    if (!tags.length) {
      this.hintEl.textContent = `Every tag in “${preset.name}” is already selected`;
      return;
    }
    this.recordHistory();
    this.positiveGroups.push(tags);
    tags.forEach((tag) => this.nameMap.set(tag.id, tag.name));
    this.appendPresetBundles(preset, new Set(tags.map((tag) => tag.id)));
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
    this.hintEl.textContent = `Inserted group “${preset.name}” — press Apply to use it`;
    this.resolveSelectedNames(tags.map((tag) => tag.id));
    if (this.groupEditorOpen) this.renderGroupEditor();
  }

  private replaceWithSelectedGroupPreset() {
    const preset = this.selectedGroupPreset();
    const current = this.positiveGroups[this.groupEditorIndex];
    if (!preset || !this.groupEditorOpen || !current) return;
    const occupied = new Set([
      ...this.positiveGroups.filter((_group, index) => index !== this.groupEditorIndex).flat(),
      ...this.excluded,
    ].map((tag) => tag.id));
    const tags = preset.tags.filter((tag) => !occupied.has(tag.id)).map((tag) => ({ ...tag }));
    if (!tags.length) {
      this.hintEl.textContent = `Every tag in “${preset.name}” is used elsewhere`;
      return;
    }
    this.recordHistory();
    const replacedIds = new Set(current.map((tag) => tag.id));
    this.tagBundles = this.effectiveBundles().filter((bundle) =>
      bundle.tagIds.every((id) => !replacedIds.has(id))
    );
    this.positiveGroups[this.groupEditorIndex] = tags;
    tags.forEach((tag) => this.nameMap.set(tag.id, tag.name));
    this.appendPresetBundles(preset, new Set(tags.map((tag) => tag.id)));
    this.groupEditorSelection.clear();
    this.groupEditorOriginalOrder = tags.map((tag) => tag.id);
    this.renderChips();
    this.renderGroupEditor();
    this.updateActionState();
    this.updateFeedSwitcher();
    this.hintEl.textContent = `Replaced with group “${preset.name}” — press Apply to use it`;
    this.resolveSelectedNames(tags.map((tag) => tag.id));
  }

  private async deleteSelectedGroupPreset() {
    const preset = this.selectedGroupPreset();
    if (!preset || !window.confirm(`Delete the reusable group “${preset.name}”?`)) return;
    const stored = await feedGroupPresetsStorage.getValue();
    const presets = stored.presets.filter((candidate) => candidate.id !== preset.id);
    this.groupPresets = presets;
    await feedGroupPresetsStorage.setValue({ v: 1, presets });
    this.renderGroupPresets();
    this.hintEl.textContent = `Deleted group “${preset.name}”`;
  }

  // --- tray (tags picked up on image pages, staged for assignment) ---

  /**
   * Stage a tag in the tray. `canonical` tags (from autocomplete) also refresh the shared
   * name cache; page-derived names (detail-page pills) must not overwrite the corpus, so
   * those are shown as-is and swapped for the canonical name once it resolves.
   */
  addToTray(tag: FeedTag, canonical = true) {
    if (this.tray.some((t) => t.id === tag.id) || this.hasSelectedTag(tag.id)) return;
    this.tray = [...this.tray, tag];
    this.saveTray();
    this.renderTray();
    if (canonical) {
      rememberTagNames([tag]).catch(() => {});
      return;
    }
    resolveTagNames([tag.id])
      .then((names) => {
        const name = names.get(tag.id);
        if (!name || name === tag.name || this.dead) return;
        const entry = this.tray.find((t) => t.id === tag.id);
        if (!entry) return;
        this.tray = this.tray.map((t) => (t.id === tag.id ? { ...t, name } : t));
        this.nameMap.set(tag.id, name);
        this.saveTray();
        this.renderTray();
      })
      .catch(() => {});
  }

  detailTagState(id: number): DetailTagState {
    if (this.tray.some((tag) => tag.id === id)) return 'tray';
    if (this.positiveGroups.some((group) => group.some((tag) => tag.id === id))) return 'positive';
    if (this.excluded.some((tag) => tag.id === id)) return 'negative';
    return null;
  }

  toggleDetailTag(tag: FeedTag) {
    const state = this.detailTagState(tag.id);
    if (state === 'tray') this.removeFromTray(tag.id);
    else if (state === 'positive') {
      this.recordHistory();
      this.removePositiveById(tag.id, false);
    } else if (state === 'negative') {
      this.recordHistory();
      this.removeNegative(tag.id, false);
    }
    else this.addToTray(tag, false);
    refreshPickupButtons();
  }

  private removeFromTray(id: number) {
    this.tray = this.tray.filter((t) => t.id !== id);
    this.saveTray();
    this.renderTray();
  }

  private saveTray() {
    feedTagTrayStorage.setValue({ v: 1, tags: this.tray }).catch(() => {});
  }

  // --- chip action menu (regroup / exclude / tray assignment) ---

  private openGroupMenu(anchor: HTMLElement, sourceGroupIndex: number) {
    const source = this.positiveGroups[sourceGroupIndex];
    if (!source) return;
    const groupLabel = (group: FeedTag[]) =>
      escapeHtml(truncate(group.map((tag) => this.nameMap.get(tag.id) ?? tag.name).join(' or ')));
    const items = [`<div class="menu-title">Merge this ${source.length}-tag group…</div>`];
    this.positiveGroups.forEach((group, targetGroupIndex) => {
      if (targetGroupIndex === sourceGroupIndex) return;
      items.push(
        `<button data-menu-group-action="merge" data-source-group="${sourceGroupIndex}" data-target-group="${targetGroupIndex}">Merge into: ${groupLabel(group)}</button>`
      );
    });
    if (items.length === 1) return;

    this.menuEl.innerHTML = items.join('');
    this.menuEl.style.display = 'block';
    const panelRect = this.panelEl.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    this.menuEl.style.top = `${r.bottom - panelRect.top + 4}px`;
    this.menuEl.style.left = `${Math.max(4, Math.min(r.left - panelRect.left, this.panelEl.clientWidth - 246))}px`;
  }

  private openChipMenu(anchor: HTMLElement, kind: ChipKind, id: number) {
    const tag = this.findTagIn(kind, id);
    if (!tag) return;
    const name = this.nameMap.get(tag.id) ?? tag.name;
    const item = (action: string, label: string, extra = '', danger = false) =>
      `<button data-menu-action="${action}" data-id="${id}" data-kind="${kind}"${extra}${danger ? ' class="danger"' : ''}>${label}</button>`;
    const groupLabel = (group: FeedTag[]) =>
      escapeHtml(truncate(group.map((t) => this.nameMap.get(t.id) ?? t.name).join(' or ')));
    const items: string[] = [`<div class="menu-title">${escapeHtml(truncate(name))}</div>`];
    const ownGroup = kind === 'pos' ? this.findGroupIndex(id) : -1;
    if (kind !== 'pos' || (this.positiveGroups[ownGroup]?.length ?? 0) > 1) {
      items.push(item('and', kind === 'pos' ? 'Move to its own group' : 'Add as a required tag'));
    }
    this.positiveGroups.forEach((group, i) => {
      if (i === ownGroup) return;
      items.push(item('or', `OR into: ${groupLabel(group)}`, ` data-group="${i}"`));
    });
    if (kind === 'pos') items.push(item('similar', 'Add look-alike tags (typos, plurals)'));
    if (kind !== 'neg') items.push(item('exclude', 'Exclude this tag instead'));
    else items.push(item('and', 'Require this tag instead'));
    if (kind !== 'tray') items.push(item('totray', 'Set aside in the tray'));
    items.push(item('remove', kind === 'tray' ? 'Discard from tray' : 'Remove', '', true));

    this.menuEl.innerHTML = items.join('');
    this.menuEl.style.display = 'block';
    const panelRect = this.panelEl.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    this.menuEl.style.top = `${r.bottom - panelRect.top + 4}px`;
    this.menuEl.style.left = `${Math.max(4, Math.min(r.left - panelRect.left, this.panelEl.clientWidth - 246))}px`;
  }

  /** Tray primary actions are direct; this menu holds only variable OR targets + discard. */
  private openTrayMoreMenu(anchor: HTMLElement, id: number) {
    const tag = this.findTagIn('tray', id);
    if (!tag) return;
    const name = this.nameMap.get(tag.id) ?? tag.name;
    const groupLabel = (group: FeedTag[]) =>
      escapeHtml(truncate(group.map((t) => this.nameMap.get(t.id) ?? t.name).join(' or ')));
    const items = [`<div class="menu-title">${escapeHtml(truncate(name))}</div>`];
    this.positiveGroups.forEach((group, i) => {
      items.push(
        `<button data-menu-action="or" data-id="${id}" data-kind="tray" data-group="${i}">OR into: ${groupLabel(group)}</button>`
      );
    });
    items.push(
      `<button class="danger" data-menu-action="remove" data-id="${id}" data-kind="tray">Discard from tray</button>`
    );
    this.menuEl.innerHTML = items.join('');
    this.menuEl.style.display = 'block';
    const panelRect = this.panelEl.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    this.menuEl.style.top = `${r.bottom - panelRect.top + 4}px`;
    this.menuEl.style.left = `${Math.max(4, Math.min(r.right - panelRect.left - 240, this.panelEl.clientWidth - 246))}px`;
  }

  private closeMenu() {
    this.menuEl.style.display = 'none';
    this.menuEl.innerHTML = '';
  }

  private findTagIn(kind: ChipKind, id: number): FeedTag | undefined {
    if (kind === 'tray') return this.tray.find((t) => t.id === id);
    if (kind === 'neg') return this.excluded.find((t) => t.id === id);
    return this.positiveGroups.flat().find((t) => t.id === id);
  }

  private onMenuAction(action: string, id: number, kind: ChipKind, groupIndex?: number) {
    const tag = this.findTagIn(kind, id);
    this.closeMenu();
    if (!tag) return;
    if (action === 'similar') {
      // Pull variants into the chip's existing group — no detach involved.
      void this.addWithSimilar({ id: tag.id, name: this.nameMap.get(tag.id) ?? tag.name });
      return;
    }
    if (!(kind === 'tray' && action === 'remove')) this.recordHistory();
    // Capture the OR target by object identity before detaching (indices shift when a
    // singleton group empties out).
    const target = groupIndex === undefined ? undefined : this.positiveGroups[groupIndex];
    if (kind === 'tray') {
      this.tray = this.tray.filter((t) => t.id !== id);
      this.saveTray();
      this.renderTray();
    } else if (kind === 'neg') {
      this.excluded = this.excluded.filter((t) => t.id !== id);
    } else {
      for (const group of this.positiveGroups) {
        const i = group.findIndex((t) => t.id === id);
        if (i !== -1) group.splice(i, 1);
      }
      this.positiveGroups = this.positiveGroups.filter((group) => group.length > 0);
    }
    switch (action) {
      // Guard pushes so malformed/restored state cannot duplicate a tag across groups.
      case 'and':
        if (!this.hasSelectedTag(id)) this.positiveGroups.push([tag]);
        break;
      case 'or': {
        if (this.hasSelectedTag(id)) break;
        if (target && this.positiveGroups.includes(target)) target.push(tag);
        else this.positiveGroups.push([tag]);
        break;
      }
      case 'exclude':
        if (!this.hasSelectedTag(id)) this.excluded.push(tag);
        break;
      case 'totray':
        if (!this.tray.some((t) => t.id === id)) {
          this.tray = [...this.tray, tag];
          this.saveTray();
          this.renderTray();
        }
        break;
      case 'remove':
        break;
      default:
        return;
    }
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private setMode(mode: TagMode) {
    if ((mode !== 'all' && mode !== 'any') || mode === this.mode) return;
    this.recordHistory();
    this.mode = mode;
    this.renderChips();
    this.updateModeButtons();
    this.updateActionState();
    this.updateFeedSwitcher();
    feedFilterUiStorage.getValue().then((ui) => feedFilterUiStorage.setValue({ ...ui, mode }));
  }

  private setExpanded(expanded: boolean) {
    if (expanded && this.nativeDock.open()) return;
    if (!expanded && this.nativeDock.close()) return;
    this.expanded = expanded;
    this.updateExpanded();
    feedFilterUiStorage.getValue().then((ui) => feedFilterUiStorage.setValue({ ...ui, expanded }));
  }

  private apply() {
    if (!this.dirty) return;
    // Stash first so the landing page's restore check sees THIS draft, not the previous one
    // (same tags re-applied in a different mode must not be "restored" to the old mode).
    writeFeedFilterStash(localStorage, {
      groups: this.positiveGroups.map((group) => group.map((t) => t.id)),
      negatives: this.excluded.map((t) => t.id),
      mode: this.mode,
      bundles: this.effectiveBundles(),
      facets: normalizeFeedFacetFilter(this.facets),
    });
    if (this.pageMode === 'detail') {
      // Jump to the (last used) feed with the edited filter.
      feedLastFilterStorage.getValue().then((last) => {
        const url = new URL(location.href);
        url.pathname = `/${last.kind}`;
        url.search = '';
        location.assign(this.buildCurrentFilterHref(url.toString()));
      });
      return;
    }
    location.assign(this.buildCurrentFilterHref(location.href));
  }

  /**
   * Toggle-style selection: picked tags stay visible (highlighted) in the dropdown, and
   * clicking one again removes it. The query and result list are kept after every pick so
   * several related tags can be added from one search without retyping.
   */
  private selectOption(tag: FeedTag, action: 'include' | 'group' | 'exclude' = 'include') {
    const inPositive = this.findGroupIndex(tag.id) !== -1;
    const inNegative = this.excluded.some((t) => t.id === tag.id);
    const changes =
      action === 'exclude' ||
      action === 'include' ||
      (action === 'group' && !inPositive && !inNegative);
    if (changes) this.recordHistory();
    if (action === 'exclude') {
      if (inNegative) this.removeNegative(tag.id, false);
      else {
        if (inPositive) this.removePositiveById(tag.id, false);
        this.addNegative(tag, false);
      }
    } else if (action === 'group') {
      if (!inPositive && !inNegative) this.addToOrGroup(tag, false);
    } else if (inPositive) {
      this.removePositiveById(tag.id, false);
    } else if (inNegative) {
      // Main click on an excluded tag flips it to a positive filter.
      this.removeNegative(tag.id, false);
      this.add(tag, false);
    } else {
      this.add(tag, false);
    }
    this.inputEl.focus();
    this.showSuggestions(this.inputEl.value); // same query — re-render with fresh pick states
  }

  private findGroupIndex(id: number): number {
    return this.positiveGroups.findIndex((group) => group.some((t) => t.id === id));
  }

  /**
   * Add a tag together with its surface variants (typos, plurals, reorderings — and,
   * once the semantic asset ships, curated relatives) as one OR group. If the tag is
   * already selected, the variants join its existing group instead.
   */
  private async addWithSimilar(tag: FeedTag) {
    let similar: FeedTag[] = [];
    try {
      const res = await rpcFindSimilarTags(tag.id, tag.name, 8);
      similar = [...res.variants, ...res.related];
    } catch {
      /* background unavailable — fall back to adding just the tag */
    }
    const ownGroup = this.findGroupIndex(tag.id);
    if (ownGroup === -1 && this.hasSelectedTag(tag.id)) return; // excluded — don't fight it
    const target = ownGroup !== -1 ? this.positiveGroups[ownGroup] : [];
    const additions = [tag, ...similar].filter((candidate) => !this.hasSelectedTag(candidate.id));
    if (!additions.length) return;
    this.recordHistory();
    if (ownGroup === -1) {
      target.push(tag);
      this.positiveGroups.push(target);
    }
    for (const t of similar) {
      if (!this.hasSelectedTag(t.id)) target.push(t);
    }
    const bundleTagIds = [tag.id, ...similar.map((candidate) => candidate.id)]
      .filter((id) => target.some((candidate) => candidate.id === id));
    this.tagBundles = [
      ...this.tagBundles.filter((bundle) => bundle.seedId !== tag.id),
      { seedId: tag.id, tagIds: [...new Set(bundleTagIds)] },
    ];
    for (const t of target) this.nameMap.set(t.id, t.name);
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
    this.showSuggestions(this.inputEl.value);
  }

  private removePositiveById(id: number, record = true) {
    const groupIndex = this.findGroupIndex(id);
    if (groupIndex !== -1) this.removePositive(groupIndex, id, record);
  }

  // --- suggestions / dropdown ---

  /**
   * Instant local matches from the cached popular list first; a debounced live lookup
   * then appends long-tail tags not in the cache. Empty query → top popular (browse).
   */
  private showSuggestions(value: string) {
    this.ensurePopularLoaded();
    if (this.debounce) clearTimeout(this.debounce);
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const q = value.trim();
    const seq = ++this.searchSeq;
    // Selected tags are NOT filtered out of the results — they render highlighted in place
    // (and clicking again toggles them off), so a search's picks stay visible.
    const hasSameResults =
      this.dropdownQuery === q &&
      this.dropdownEl.style.display !== 'none' &&
      this.currentOptions.length > 0;
    const localPromise = searchCachedFeedTags(q, SUGGEST_LIMIT).catch(() => [] as FeedTag[]);

    if (hasSameResults) {
      // Same query, options already on screen: re-render immediately so pick-state changes
      // show up, without flashing a "Searching…" placeholder.
      this.renderDropdown(this.currentOptions, '', q);
    } else {
      this.renderDropdown([], !q ? this.loadingBrowseText() : 'Searching…', q);
    }
    localPromise.then((local) => {
      if (seq !== this.searchSeq) return;
      this.renderDropdown(local, !q ? '' : local.length ? '' : 'Searching…', q);
    });
    if (!q) return; // browse mode — no live call

    this.debounce = this.ctx.setTimeout(async () => {
      if (this.dead) return; // widget destroyed while the debounce was pending
      let results: FeedTag[] = [];
      try {
        results = await searchFeedTags(q, controller.signal);
      } catch {
        /* aborted / network — keep local results */
      }
      if (seq !== this.searchSeq) return; // superseded by a newer keystroke
      for (const t of results) this.nameMap.set(t.id, t.name); // grow the long-tail index for instant repeats
      const local = await localPromise;
      if (seq !== this.searchSeq) return; // local cache promise may resolve after a newer keystroke
      const merged: FeedTag[] = [];
      const seen = new Set<number>();
      for (const t of [...local, ...results]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        merged.push(t);
      }
      this.renderDropdown(merged.slice(0, SUGGEST_LIMIT), merged.length ? '' : 'No tags found', q);
    }, 250);
  }

  private ensurePopularLoaded() {
    if (this.popularLoaded || this.popularLoad) return;
    this.popularLoad = loadPopularTags(this.ctx.signal)
      .then((tags) => {
        this.popularLoaded = tags.length > 0;
        if (this.shouldRefreshEmptyBrowse()) this.showSuggestions('');
      })
      .catch(() => {})
      .finally(() => {
        this.popularLoad = undefined;
      });
  }

  private onPopularCacheStatus(status: PopularTagCacheStatus) {
    this.cacheStatus = status;
    this.updateActionState();
  }

  private resolveSelectedNames(ids: number[]) {
    const selected = [...this.positiveGroups.flat(), ...this.excluded];
    const unresolvedIds = [...new Set(ids)].filter((id) => {
      const tag = selected.find((candidate) => candidate.id === id);
      const name = this.nameMap.get(id) ?? tag?.name;
      return !name || name === `#${id}` || name === String(id);
    });
    if (!unresolvedIds.length) return;
    resolveTagNames(unresolvedIds)
      .then((names) => {
        let changed = false;
        const update = (tag: FeedTag) => {
          const name = names.get(tag.id);
          if (!name || name === tag.name) return tag;
          changed = true;
          this.nameMap.set(tag.id, name);
          return { id: tag.id, name };
        };
        this.positiveGroups = this.positiveGroups.map((group) => group.map(update));
        this.excluded = this.excluded.map(update);
        if (changed) {
          this.renderChips();
          if (this.groupEditorOpen) this.renderGroupEditor();
        }
      })
      .catch(() => {});
  }

  private shouldRefreshEmptyBrowse(): boolean {
    return (
      this.editorVisible &&
      this.inputEl.value.trim() === '' &&
      this.dropdownEl.style.display !== 'none' &&
      this.currentOptions.length === 0
    );
  }

  private loadingBrowseText(): string {
    if (this.cacheStatus?.syncing && this.cacheStatus.count) return 'Loading cached tags…';
    return 'Loading tags…';
  }

  private renderDropdown(options: FeedTag[], status = '', query = this.dropdownQuery) {
    // Keyboard highlight survives re-renders: remember the active tag by id, not by index.
    const prevActiveId = this.activeIndex >= 0 ? this.currentOptions[this.activeIndex]?.id : undefined;
    this.currentOptions = options;
    this.dropdownQuery = query;
    const opts = options
      .map((t, i) => {
        const picked = this.findGroupIndex(t.id) !== -1;
        const pickedNeg = !picked && this.excluded.some((x) => x.id === t.id);
        const cls = picked ? ' picked' : pickedNeg ? ' picked picked-neg' : '';
        const mark = picked ? '✓' : pickedNeg ? '−' : '';
        const mainTitle = picked
          ? 'Remove from filter'
          : pickedNeg
            ? 'Excluded — click to include instead'
            : 'Add tag';
        const orDisabled = picked || pickedNeg || !this.positiveGroups.length;
        return `<div class="opt${cls}" role="option" aria-selected="${picked || pickedNeg}" id="cllp-opt-${i}">
            <button class="opt-main" type="button" data-action="include" data-id="${t.id}" title="${mainTitle}"><span class="mark">${mark}</span><span class="name-text">${escapeHtml(t.name)}</span></button>
            <button class="opt-act" type="button" data-action="similar" data-id="${t.id}" title="Add this tag together with look-alikes (typos, plurals, variants) as one group"${pickedNeg ? ' disabled' : ''}>+ similar</button>
            <button class="opt-act" type="button" data-action="group" data-id="${t.id}" title="Add to the last group as an alternative (“or”)"${orDisabled ? ' disabled' : ''}>or</button>
            <button class="opt-act neg" type="button" data-action="exclude" data-id="${t.id}" title="${pickedNeg ? 'Stop excluding this tag' : 'Exclude: hide images with this tag'}">exclude</button>
          </div>`;
      })
      .join('');
    this.dropdownEl.innerHTML = (status ? `<div class="dd-status">${escapeHtml(status)}</div>` : '') + opts;
    const open = options.length > 0 || !!status;
    this.dropdownEl.style.display = open ? 'block' : 'none';
    this.inputEl.setAttribute('aria-expanded', String(open));
    this.inputEl.removeAttribute('aria-activedescendant');
    this.activeIndex = prevActiveId === undefined ? -1 : options.findIndex((t) => t.id === prevActiveId);
    if (this.activeIndex !== -1) {
      const active = this.dropdownEl.querySelectorAll<HTMLElement>('.opt')[this.activeIndex];
      if (active) {
        active.classList.add('active');
        this.inputEl.setAttribute('aria-activedescendant', active.id);
      }
    }
  }

  private closeDropdown() {
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.dropdownEl.style.display = 'none';
    this.dropdownEl.innerHTML = '';
    this.currentOptions = [];
    this.dropdownQuery = '';
    this.activeIndex = -1;
    this.inputEl.setAttribute('aria-expanded', 'false');
    this.inputEl.removeAttribute('aria-activedescendant');
  }

  private onKeyDown(e: KeyboardEvent) {
    const open = this.dropdownEl.style.display !== 'none' && this.currentOptions.length > 0;
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      this.highlight(Math.min(this.activeIndex + 1, this.currentOptions.length - 1));
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      this.highlight(Math.max(this.activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      const tag =
        this.activeIndex >= 0 ? this.currentOptions[this.activeIndex] : this.currentOptions[0];
      if (tag) {
        e.preventDefault();
        this.selectOption(tag);
      }
    }
  }

  private highlight(index: number) {
    this.activeIndex = index;
    const opts = this.dropdownEl.querySelectorAll<HTMLElement>('.opt');
    opts.forEach((o, i) => o.classList.toggle('active', i === index));
    const active = opts[index];
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
      this.inputEl.setAttribute('aria-activedescendant', active.id);
    }
  }

  // --- targeted view patches ---

  private openGroupEditor(groupIndex: number, reviewOnly = false) {
    const group = this.positiveGroups[groupIndex];
    if (!group) return;
    this.closeDropdown();
    this.closeMenu();
    this.groupEditorOpen = true;
    this.groupEditorIndex = groupIndex;
    this.groupEditorSelection.clear();
    this.groupEditorOriginalOrder = group.map((tag) => tag.id);
    this.groupEditorReviewOnly = reviewOnly;
    this.groupEditorSearchEl.value = '';
    this.tagViewEl.style.display = 'none';
    this.facetViewEl.style.display = 'none';
    this.groupViewEl.style.display = 'block';
    this.renderGroupEditor();
    this.updateGroupPresetButtons();
    this.groupEditorSearchEl.focus();
  }

  private closeGroupEditor() {
    if (!this.groupEditorOpen) return;
    this.groupEditorOpen = false;
    this.groupEditorIndex = -1;
    this.groupEditorSelection.clear();
    this.groupEditorOriginalOrder = [];
    this.groupEditorReviewOnly = false;
    this.groupViewEl.style.display = 'none';
    this.tagViewEl.style.display = this.facetEditorOpen ? 'none' : 'block';
    this.updateGroupPresetButtons();
    if (this.editorVisible && !this.facetEditorOpen) this.inputEl.focus();
  }

  private groupEditorVisibleTags(): FeedTag[] {
    const group = this.positiveGroups[this.groupEditorIndex] ?? [];
    const issueIds = new Set(this.healthIssues().map((issue) => issue.id));
    const query = this.groupEditorSearchEl.value.trim().toLocaleLowerCase();
    return group.filter((tag) => {
      if (this.groupEditorReviewOnly && !issueIds.has(tag.id)) return false;
      if (!query) return true;
      const name = this.nameMap.get(tag.id) ?? tag.name;
      return name.toLocaleLowerCase().includes(query) || String(tag.id).includes(query);
    });
  }

  private healthIssues(): FeedTagHealthIssue[] {
    return findFeedTagHealthIssues(
      [...this.positiveGroups.flat(), ...this.excluded].map((tag) => ({
        id: tag.id,
        name: this.nameMap.get(tag.id) ?? tag.name,
      }))
    );
  }

  private renderGroupEditor() {
    const group = this.positiveGroups[this.groupEditorIndex];
    if (!this.groupEditorOpen || !group) {
      if (this.groupEditorOpen) this.closeGroupEditor();
      return;
    }
    const issues = this.healthIssues();
    const issuesByTag = new Map<number, FeedTagHealthIssue[]>();
    issues.forEach((issue) => issuesByTag.set(issue.id, [...(issuesByTag.get(issue.id) ?? []), issue]));
    const groupIssueCount = group.filter((tag) => issuesByTag.has(tag.id)).length;
    this.groupEditorTitleEl.textContent = this.groupEditorReviewOnly
      ? `Review ${groupIssueCount} tag${groupIssueCount === 1 ? '' : 's'}`
      : group.length === 1 ? 'Edit 1-tag group' : `Edit ${group.length}-tag group`;
    const visible = this.groupEditorVisibleTags();
    const originByTag = new Map<number, string>();
    this.activeBundlesForGroup(group).forEach((bundle) => {
      const seed = group.find((tag) => tag.id === bundle.seedId);
      if (!seed) return;
      const seedName = this.nameMap.get(seed.id) ?? seed.name;
      bundle.tagIds.forEach((id) => originByTag.set(id, `Similar to ${seedName}`));
    });
    this.groupEditorListEl.innerHTML = visible.length
      ? visible.map((tag) => {
          const name = escapeHtml(this.nameMap.get(tag.id) ?? tag.name);
          const source = escapeHtml(originByTag.get(tag.id) ?? `#${tag.id}`);
          const issueLabels = [...new Set((issuesByTag.get(tag.id) ?? []).map((issue) => issue.label))];
          const issueHtml = issueLabels.length
            ? `<span class="group-editor-issue">${escapeHtml(issueLabels.join(' · '))}</span>`
            : '';
          return `<label class="group-editor-row"><input type="checkbox" data-group-tag-id="${tag.id}"${this.groupEditorSelection.has(tag.id) ? ' checked' : ''} />` +
            `<span class="group-editor-name" title="${name}">${name}${issueHtml}</span><span class="group-editor-id" title="#${tag.id}">${source}</span></label>`;
        }).join('')
      : '<div class="group-editor-empty">No tags match this search.</div>';

    const selectedTarget = this.groupEditorTargetEl.value;
    this.groupEditorTargetEl.replaceChildren();
    this.positiveGroups.forEach((candidate, index) => {
      if (index === this.groupEditorIndex) return;
      const option = document.createElement('option');
      option.value = String(index);
      const names = candidate.map((tag) => this.nameMap.get(tag.id) ?? tag.name).join(' or ');
      option.textContent = `Group ${index + 1}: ${truncate(names, 30)}`;
      this.groupEditorTargetEl.append(option);
    });
    if ([...this.groupEditorTargetEl.options].some((option) => option.value === selectedTarget)) {
      this.groupEditorTargetEl.value = selectedTarget;
    } else if (this.groupEditorTargetEl.options[0]) {
      this.groupEditorTargetEl.value = this.groupEditorTargetEl.options[0].value;
    }
    const reviewButton = this.groupViewEl.querySelector<HTMLButtonElement>('[data-group-editor-action="toggle-review"]')!;
    reviewButton.hidden = groupIssueCount === 0;
    reviewButton.textContent = this.groupEditorReviewOnly ? 'Show all tags' : `Review issues (${groupIssueCount})`;
    this.updateGroupEditorControls();
  }

  private updateGroupEditorControls() {
    const group = this.positiveGroups[this.groupEditorIndex];
    if (!group) return;
    const selected = this.groupEditorSelection.size;
    const visible = this.groupEditorVisibleTags().length;
    this.groupEditorCountEl.textContent = `${selected} selected · ${group.length} total`;
    const setDisabled = (action: string, disabled: boolean) => {
      const button = this.groupViewEl.querySelector<HTMLButtonElement>(
        `[data-group-editor-action="${action}"]`
      );
      if (button) button.disabled = disabled;
    };
    setDisabled('select-shown', visible === 0);
    setDisabled('clear-selection', selected === 0);
    setDisabled('move', selected === 0 || this.groupEditorTargetEl.options.length === 0);
    setDisabled('new-group', selected === 0 || selected === group.length);
    setDisabled('exclude', selected === 0);
    setDisabled('remove', selected === 0);
  }

  private onGroupEditorAction(action: string) {
    const group = this.positiveGroups[this.groupEditorIndex];
    if (!group) return;
    if (action === 'select-shown') {
      this.groupEditorVisibleTags().forEach((tag) => this.groupEditorSelection.add(tag.id));
      this.renderGroupEditor();
      return;
    }
    if (action === 'clear-selection') {
      this.groupEditorSelection.clear();
      this.renderGroupEditor();
      return;
    }
    if (action === 'toggle-review') {
      this.groupEditorReviewOnly = !this.groupEditorReviewOnly;
      this.groupEditorSelection.clear();
      this.renderGroupEditor();
      return;
    }
    if (action === 'sort-alpha') {
      this.recordHistory();
      group.sort((a, b) =>
        (this.nameMap.get(a.id) ?? a.name).localeCompare(this.nameMap.get(b.id) ?? b.name)
      );
      this.afterGroupReorder();
      return;
    }
    if (action === 'sort-origin') {
      const order = new Map(this.groupEditorOriginalOrder.map((id, index) => [id, index]));
      const sourceRank = new Map<number, number>();
      this.activeBundlesForGroup(group).forEach((bundle, index) =>
        bundle.tagIds.forEach((id) => sourceRank.set(id, index))
      );
      const unbundledRank = sourceRank.size + 1;
      this.recordHistory();
      group.sort((a, b) =>
        (sourceRank.get(a.id) ?? unbundledRank) - (sourceRank.get(b.id) ?? unbundledRank) ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
      );
      this.afterGroupReorder();
      return;
    }
    if (action === 'restore-order') {
      const order = new Map(this.groupEditorOriginalOrder.map((id, index) => [id, index]));
      this.recordHistory();
      group.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
      this.afterGroupReorder();
      return;
    }

    const selected = group.filter((tag) => this.groupEditorSelection.has(tag.id));
    if (!selected.length) return;
    const remaining = group.filter((tag) => !this.groupEditorSelection.has(tag.id));
    const moveTarget = action === 'move'
      ? this.positiveGroups[Number(this.groupEditorTargetEl.value)]
      : undefined;
    if (action === 'move' && (!moveTarget || moveTarget === group)) return;
    if (action === 'new-group' && !remaining.length) return;
    if (!['move', 'new-group', 'exclude', 'remove'].includes(action)) return;
    this.recordHistory();
    if (action === 'move') {
      moveTarget!.push(...selected);
    } else if (action === 'new-group') {
      this.positiveGroups.push(selected);
    } else if (action === 'exclude') {
      this.excluded.push(...selected);
    }

    if (remaining.length) this.positiveGroups[this.groupEditorIndex] = remaining;
    else this.positiveGroups.splice(this.groupEditorIndex, 1);
    this.groupEditorSelection.clear();
    this.renderChips();
    this.updateActionState();
    this.updateFeedSwitcher();
    if (!remaining.length) this.closeGroupEditor();
    else this.renderGroupEditor();
  }

  /** Reorders are draft edits too: they change the built URL, so refresh Apply/history state. */
  private afterGroupReorder() {
    this.renderChips();
    this.renderGroupEditor();
    this.updateActionState();
  }

  private currentTagExpression() {
    return {
      groups: this.positiveGroups.map((group) => group.map((tag) => ({
        id: tag.id,
        name: this.nameMap.get(tag.id) ?? tag.name,
      }))),
      negatives: this.excluded.map((tag) => ({
        id: tag.id,
        name: this.nameMap.get(tag.id) ?? tag.name,
      })),
      mode: this.mode,
    };
  }

  private setExpressionEditorOpen(open: boolean) {
    if (open) {
      if (this.groupEditorOpen) this.closeGroupEditor();
      if (this.facetEditorOpen) this.setFacetEditorOpen(false);
    }
    this.expressionEditorOpen = open;
    this.tagViewEl.style.display = open ? 'none' : 'block';
    this.groupViewEl.style.display = 'none';
    this.facetViewEl.style.display = 'none';
    this.expressionViewEl.style.display = open ? 'block' : 'none';
    if (open) {
      this.exportExpression();
      this.expressionInputEl.focus();
    } else if (this.editorVisible) {
      this.inputEl.focus();
    }
  }

  private exportExpression() {
    this.expressionInputEl.value = formatFeedTagExpression(this.currentTagExpression());
    this.previewExpression();
  }

  private previewExpression() {
    try {
      const parsed = parseFeedTagExpression(this.expressionInputEl.value);
      const count = parsed.groups.flat().length + parsed.negatives.length;
      this.expressionStatusEl.classList.remove('error');
      this.expressionStatusEl.textContent = `${parsed.groups.length} positive group${parsed.groups.length === 1 ? '' : 's'} · ${count} tag${count === 1 ? '' : 's'} · ${parsed.negatives.length} excluded`;
    } catch (error) {
      this.expressionStatusEl.classList.add('error');
      this.expressionStatusEl.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private async copyExpression() {
    try {
      await navigator.clipboard.writeText(this.expressionInputEl.value);
      this.expressionStatusEl.classList.remove('error');
      this.expressionStatusEl.textContent = 'Copied expression';
    } catch {
      this.expressionInputEl.select();
      this.expressionStatusEl.classList.add('error');
      this.expressionStatusEl.textContent = 'Clipboard unavailable — expression selected for manual copy';
    }
  }

  private importExpression() {
    let parsed;
    try {
      parsed = parseFeedTagExpression(this.expressionInputEl.value);
    } catch (error) {
      this.previewExpression();
      return;
    }
    this.recordHistory();
    this.positiveGroups = parsed.groups.map((group) => group.map((tag) => ({ ...tag })));
    this.excluded = parsed.negatives.map((tag) => ({ ...tag }));
    this.mode = parsed.mode;
    this.tagBundles = [];
    [...this.positiveGroups.flat(), ...this.excluded].forEach((tag) => this.nameMap.set(tag.id, tag.name));
    this.renderChips();
    this.updateModeButtons();
    this.updateActionState();
    this.updateFeedSwitcher();
    this.resolveSelectedNames([...this.positiveGroups.flat(), ...this.excluded].map((tag) => tag.id));
    this.setExpressionEditorOpen(false);
    this.hintEl.textContent = 'Filter loaded from text — press Apply to use it';
  }

  private setFacetEditorOpen(open: boolean) {
    if (open && this.expressionEditorOpen) this.setExpressionEditorOpen(false);
    if (open && this.groupEditorOpen) this.closeGroupEditor();
    this.facetEditorOpen = open;
    this.tagViewEl.style.display = open ? 'none' : 'block';
    this.groupViewEl.style.display = 'none';
    this.expressionViewEl.style.display = 'none';
    this.facetViewEl.style.display = open ? 'block' : 'none';
    if (open) {
      this.closeDropdown();
      this.renderFacetEditor();
      this.facetCreatorIncludeEl.focus();
    } else {
      if (this.resourceDebounce) clearTimeout(this.resourceDebounce);
      this.resourceAbort?.abort();
      this.resourceResultsEl.style.display = 'none';
      if (this.editorVisible) this.inputEl.focus();
    }
  }

  private renderFacetEditor() {
    this.facetCreatorIncludeEl.value = this.facets.creatorsInclude.join(', ');
    this.facetCreatorExcludeEl.value = this.facets.creatorsExclude.join(', ');
    this.orientationBtns.forEach((button) => {
      const active = this.facets.orientations.includes(button.dataset.orientation as FeedOrientation);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    this.facetNumberEls.forEach((input) => {
      const key = input.dataset.facetNumber as 'minReactions' | 'minViews' | 'minComments' | 'minCollections';
      input.value = this.facets[key] === undefined ? '' : String(this.facets[key]);
    });
    this.facetCheckEls.forEach((input) => {
      const key = input.dataset.facetCheck as 'hasMeta' | 'onSite';
      input.checked = this.facets[key] === true;
    });
    this.renderResourceSelections();
    this.updateFacetSummary();
  }

  private updateFacetsFromEditor() {
    this.recordHistory('facets');
    const values = (input: HTMLInputElement) => input.value.split(',');
    const next: Partial<FeedFacetFilter> = {
      creatorsInclude: values(this.facetCreatorIncludeEl),
      creatorsExclude: values(this.facetCreatorExcludeEl),
      orientations: [...this.orientationBtns]
        .filter((button) => button.classList.contains('active'))
        .map((button) => button.dataset.orientation as FeedOrientation),
      primaryModel: this.facets.primaryModel,
      resourcesInclude: this.facets.resourcesInclude,
      resourcesExclude: this.facets.resourcesExclude,
    };
    this.facetNumberEls.forEach((input) => {
      const key = input.dataset.facetNumber as 'minReactions' | 'minViews' | 'minComments' | 'minCollections';
      if (input.value !== '') next[key] = Number(input.value);
    });
    this.facetCheckEls.forEach((input) => {
      const key = input.dataset.facetCheck as 'hasMeta' | 'onSite';
      if (input.checked) next[key] = true;
    });
    this.facets = normalizeFeedFacetFilter(next);
    this.updateFacetSummary();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private updateFacetSummary() {
    const count = feedFacetCount(this.facets);
    this.facetSummaryEl.textContent = feedFacetSummary(this.facets) || 'None';
    this.facetSummaryEl.title = feedFacetSummary(this.facets);
    this.facetBadgeEl.textContent = String(count);
    this.facetBadgeEl.style.display = count ? 'inline-flex' : 'none';
  }

  private renderResourceSelections() {
    const chip = (resource: FeedResourceRef, kind: 'primary' | 'include' | 'exclude') =>
      `<span class="resource-chip ${kind === 'exclude' ? 'negative' : kind}" title="${escapeHtml(resource.label)}">` +
      `<span>${escapeHtml(resource.label)}</span>` +
      `<button type="button" data-remove-resource="${kind}" data-version-id="${resource.versionId}" aria-label="Remove ${escapeHtml(resource.label)}">×</button></span>`;
    const row = (label: string, content: string) =>
      `<div class="resource-row"><span class="resource-kind">${label}</span><div class="resource-chips">${content || '<span class="empty">None</span>'}</div></div>`;
    this.resourceSelectionsEl.innerHTML =
      row('Model', this.facets.primaryModel ? chip(this.facets.primaryModel, 'primary') : '') +
      row('Any', this.facets.resourcesInclude.map((resource) => chip(resource, 'include')).join('')) +
      row('Exclude', this.facets.resourcesExclude.map((resource) => chip(resource, 'exclude')).join(''));
  }

  private searchResources(query: string) {
    if (this.resourceDebounce) clearTimeout(this.resourceDebounce);
    this.resourceAbort?.abort();
    const normalized = query.trim();
    if (normalized.length < 2) {
      this.resourceOptions = [];
      this.resourceResultsEl.style.display = 'none';
      this.resourceResultsEl.innerHTML = '';
      return;
    }
    const seq = ++this.resourceSearchSeq;
    this.resourceResultsEl.style.display = 'block';
    this.resourceResultsEl.innerHTML = '<div class="resource-status">Searching CivitAI…</div>';
    this.resourceDebounce = this.ctx.setTimeout(async () => {
      const controller = new AbortController();
      this.resourceAbort = controller;
      try {
        const options = await searchFeedResources(normalized, controller.signal);
        if (seq !== this.resourceSearchSeq) return;
        this.resourceOptions = options;
        this.resourceResultsEl.innerHTML = options.length
          ? options.map((resource) =>
              `<div class="resource-result"><span class="resource-result-name" title="${escapeHtml(resource.label)}">${escapeHtml(resource.label)}</span>` +
              `<button type="button" data-resource-action="primary" data-version-id="${resource.versionId}" title="Require as primary model">Model</button>` +
              `<button type="button" data-resource-action="include" data-version-id="${resource.versionId}" title="Require any selected resource">+</button>` +
              `<button type="button" data-resource-action="exclude" data-version-id="${resource.versionId}" title="Exclude this resource">−</button></div>`
            ).join('')
          : '<div class="resource-status">No matching model versions</div>';
      } catch (error) {
        if (controller.signal.aborted || seq !== this.resourceSearchSeq) return;
        this.resourceOptions = [];
        this.resourceResultsEl.innerHTML = '<div class="resource-status">CivitAI search unavailable</div>';
      }
    }, 250);
  }

  private assignResource(resource: FeedResourceRef, kind: 'primary' | 'include' | 'exclude') {
    this.recordHistory();
    const id = resource.versionId;
    const next: FeedFacetFilter = normalizeFeedFacetFilter({
      ...this.facets,
      primaryModel: this.facets.primaryModel?.versionId === id ? undefined : this.facets.primaryModel,
      resourcesInclude: this.facets.resourcesInclude.filter((candidate) => candidate.versionId !== id),
      resourcesExclude: this.facets.resourcesExclude.filter((candidate) => candidate.versionId !== id),
    });
    if (kind === 'primary') next.primaryModel = resource;
    else if (kind === 'include') next.resourcesInclude.push(resource);
    else next.resourcesExclude.push(resource);
    this.facets = normalizeFeedFacetFilter(next);
    this.renderResourceSelections();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private removeResource(kind: string, versionId: number) {
    this.recordHistory();
    if (kind === 'primary' && this.facets.primaryModel?.versionId === versionId) {
      this.facets = normalizeFeedFacetFilter({ ...this.facets, primaryModel: undefined });
    } else if (kind === 'include') {
      this.facets = normalizeFeedFacetFilter({
        ...this.facets,
        resourcesInclude: this.facets.resourcesInclude.filter((resource) => resource.versionId !== versionId),
      });
    } else if (kind === 'exclude') {
      this.facets = normalizeFeedFacetFilter({
        ...this.facets,
        resourcesExclude: this.facets.resourcesExclude.filter((resource) => resource.versionId !== versionId),
      });
    } else return;
    this.renderResourceSelections();
    this.updateActionState();
    this.updateFeedSwitcher();
  }

  private activeBundlesForGroup(group: FeedTag[]): FeedTagBundle[] {
    const ids = new Set(group.map((tag) => tag.id));
    const claimed = new Set<number>();
    const bundles: FeedTagBundle[] = [];
    for (const bundle of this.tagBundles) {
      const tagIds = [...new Set(bundle.tagIds)].filter((id) => ids.has(id));
      if (
        tagIds.length < 2 ||
        !tagIds.includes(bundle.seedId) ||
        tagIds.some((id) => claimed.has(id))
      ) continue;
      tagIds.forEach((id) => claimed.add(id));
      bundles.push({ seedId: bundle.seedId, tagIds });
    }
    return bundles;
  }

  private groupRenderTokens(
    group: FeedTag[],
    groupIndex: number
  ): Array<{ html: string; tagCount: number }> {
    const bundles = this.activeBundlesForGroup(group);
    const bundleByTag = new Map<number, FeedTagBundle>();
    bundles.forEach((bundle) => bundle.tagIds.forEach((id) => bundleByTag.set(id, bundle)));
    const renderedSeeds = new Set<number>();
    const byId = new Map(group.map((tag) => [tag.id, tag]));
    const tokens: Array<{ html: string; tagCount: number }> = [];
    for (const tag of group) {
      const bundle = bundleByTag.get(tag.id);
      if (!bundle) {
        tokens.push({ html: this.chipHtml(tag, 'pos', groupIndex), tagCount: 1 });
        continue;
      }
      if (renderedSeeds.has(bundle.seedId)) continue;
      renderedSeeds.add(bundle.seedId);
      const seed = byId.get(bundle.seedId)!;
      const seedName = escapeHtml(this.nameMap.get(seed.id) ?? seed.name);
      const expanded = this.expandedBundleSeeds.has(bundle.seedId);
      const members = bundle.tagIds
        .map((id) => byId.get(id))
        .filter((candidate): candidate is FeedTag => candidate !== undefined);
      const memberHtml = expanded
        ? `<span class="bundle-members">${members.map((member) => this.chipHtml(member, 'pos', groupIndex)).join('')}</span>`
        : '';
      tokens.push({
        html: `<span class="tag-bundle" data-bundle-seed="${bundle.seedId}">` +
          `<button class="bundle-summary" type="button" data-toggle-bundle="${bundle.seedId}" aria-expanded="${expanded}" title="${expanded ? 'Hide' : 'Show'} similarity variants">` +
          `${seedName}<span class="bundle-count">${bundle.tagIds.length - 1} variants</span></button>${memberHtml}</span>`,
        tagCount: bundle.tagIds.length,
      });
    }
    return tokens;
  }

  private renderChips() {
    const connector = this.mode === 'all' ? 'AND' : 'OR';
    const issueIds = new Set(this.healthIssues().map((issue) => issue.id));
    const positiveGroups = this.positiveGroups
      .map((group, groupIndex) => {
        const tokens = this.groupRenderTokens(group, groupIndex);
        const canCollapse = group.length > LARGE_GROUP_THRESHOLD && tokens.length > COLLAPSED_GROUP_PREVIEW;
        const expanded = !canCollapse || this.expandedGroupKeys.has(this.groupKey(group));
        const shown = expanded ? tokens : tokens.slice(0, COLLAPSED_GROUP_PREVIEW);
        const chips = shown.map((token) => token.html).join('');
        const groupHandle = this.positiveGroups.length > 1
          ? `<button class="group-grip" type="button" data-group="${groupIndex}" draggable="true" aria-label="Move ${group.length}-tag OR group" title="Drag to merge this OR group; click for merge options"></button>`
          : '';
        const hiddenTagCount = tokens.slice(shown.length).reduce((sum, token) => sum + token.tagCount, 0);
        const groupToggle = canCollapse
          ? `<button class="group-toggle" type="button" data-toggle-group="${groupIndex}" aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse' : 'Show all'} ${group.length} tags">${expanded ? 'Show less' : `+${hiddenTagCount} more`}</button>`
          : '';
        const rule = group.length === 1 ? '1 tag' : `Any of ${group.length} tags`;
        const issueCount = group.filter((tag) => issueIds.has(tag.id)).length;
        const health = issueCount
          ? `<button class="group-health" type="button" data-review-group="${groupIndex}" aria-label="Review ${issueCount} tag issues">${issueCount} need review</button>`
          : '';
        const classes = ['group'];
        if (!expanded) classes.push('collapsed');
        if (group.length === 1) classes.push('single');
        if (issueCount) classes.push('has-issues');
        return `<span class="${classes.join(' ')}" data-group="${groupIndex}" aria-label="${rule}">` +
          `<span class="group-head">${groupHandle}<span class="group-rule">${rule}</span>${health}${groupToggle}` +
          `<button class="group-edit" type="button" data-edit-group="${groupIndex}" aria-label="Edit group ${groupIndex + 1}">Edit</button></span>` +
          `<span class="group-tags">${chips}</span></span>`;
      })
      .join(`<span class="group-connector" aria-label="${connector}">${connector}</span>`);
    const positive = positiveGroups
      ? `<span class="positive-groups">${positiveGroups}</span>`
      : '';
    const negative = this.excluded.map((t) => this.chipHtml(t, 'neg')).join('');
    this.chipsEl.innerHTML = positive || negative
      ? positive +
        '<span class="and-dropzone" aria-hidden="true">Drop here as a separate AND tag</span>' +
        (negative ? `<span class="negative-tags" aria-label="Excluded tags"><span class="neg-label">Hide images tagged</span>${negative}</span>` : '')
      : `<span class="empty">${
          this.tray.length
            ? 'Nothing in the filter yet — use + on a set-aside tag to require it, or ⊖ to exclude it.'
            : 'No tags yet. Search above and pick one — add more to narrow the feed down, or use “exclude” to hide things.'
        }</span>`;
    refreshPickupButtons();
  }

  private chipHtml(t: FeedTag, kind: ChipKind, groupIndex?: number): string {
    const name = escapeHtml(this.nameMap.get(t.id) ?? t.name);
    const cls = kind === 'neg' ? 'chip neg' : kind === 'tray' ? 'chip tray-chip' : 'chip';
    const groupAttr = groupIndex === undefined ? '' : ` data-group="${groupIndex}"`;
    const dragAttrs = kind === 'pos' ? ' draggable="true"' : '';
    const grip =
      kind === 'pos'
        ? '<span class="drag-grip" aria-hidden="true" title="Drag to move between groups"></span>'
        : '';
    return `<span class="${cls}" data-id="${t.id}" data-kind="${kind}"${groupAttr}${dragAttrs}>` +
      grip +
      `<button class="name" type="button" data-id="${t.id}" data-kind="${kind}"${groupAttr} title="More options for this tag">${name}</button>` +
      `<button class="rm" type="button" data-id="${t.id}" data-kind="${kind}"${groupAttr} title="Remove">×</button>` +
      `</span>`;
  }

  private renderTray() {
    if (!this.tray.length) {
      this.trayEl.innerHTML = '';
      this.trayEl.style.display = 'none';
      refreshPickupButtons();
      return;
    }
    this.trayEl.style.display = 'block';
    this.trayEl.innerHTML =
      `<div class="tray-head">Set aside from image pages<span class="line"></span></div>` +
      `<div class="tray-chips">${this.tray.map((t) => this.trayItemHtml(t)).join('')}</div>`;
    refreshPickupButtons();
  }

  private trayItemHtml(t: FeedTag): string {
    const name = escapeHtml(this.nameMap.get(t.id) ?? t.name);
    const action = (kind: 'and' | 'exclude' | 'more', label: string, title: string, svg: string) =>
      `<button class="tray-action ${kind}" type="button" data-id="${t.id}" data-kind="tray" ` +
      `data-tray-action="${kind}" aria-label="${label}" title="${title}">${svg}</button>`;
    const plus = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const minus = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg>';
    const more = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
    return `<div class="tray-item" data-id="${t.id}"><span class="tray-name" title="${name}">${name}</span>` +
      `<span class="tray-actions">${action('and', 'Add as AND filter', 'Add as a required tag', plus)}` +
      `${action('exclude', 'Exclude this tag', 'Exclude this tag', minus)}${action('more', 'OR into a group or discard', 'Add to a group, or discard', more)}</span></div>`;
  }

  private renderPresets(selectedId = this.presetSelectEl.value) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = this.presets.length ? 'Saved filters…' : 'No saved filters';
    this.presetSelectEl.replaceChildren(placeholder);
    for (const preset of this.presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      this.presetSelectEl.append(option);
    }
    this.presetSelectEl.value = this.presets.some((preset) => preset.id === selectedId)
      ? selectedId
      : '';
    this.presetRowEl.classList.toggle('empty-library', this.presets.length === 0);
    this.presetSaveBtn.textContent = this.presets.length ? 'Save current…' : 'Save this filter…';
    this.updatePresetButtons();
  }

  private updatePresetButtons() {
    const selected = this.presets.some((preset) => preset.id === this.presetSelectEl.value);
    this.presetLoadBtn.disabled = !selected;
    this.presetDeleteBtn.disabled = !selected;
    this.presetSaveBtn.disabled =
      !this.positiveGroups.length && !this.excluded.length && !hasFeedFacets(this.facets);
  }

  private renderGroupPresets(selectedId = this.groupPresetSelectEl.value) {
    for (const select of [this.groupPresetSelectEl, this.groupPresetEditorSelectEl]) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = this.groupPresets.length ? 'Reusable groups…' : 'No reusable groups';
      select.replaceChildren(placeholder);
      for (const preset of this.groupPresets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = `${preset.name} · ${preset.tags.length}`;
        select.append(option);
      }
      select.value = this.groupPresets.some((preset) => preset.id === selectedId) ? selectedId : '';
    }
    this.groupLibraryEl.classList.toggle('no-presets', this.groupPresets.length === 0);
    this.updateGroupPresetButtons();
  }

  private updateGroupPresetButtons() {
    const selected = Boolean(this.selectedGroupPreset());
    this.root.querySelectorAll<HTMLButtonElement>('.group-preset-insert, .group-preset-editor-insert')
      .forEach((button) => { button.disabled = !selected; });
    this.root.querySelectorAll<HTMLButtonElement>('.group-preset-delete')
      .forEach((button) => { button.disabled = !selected; });
    const replace = this.root.querySelector<HTMLButtonElement>('.group-preset-replace');
    if (replace) replace.disabled = !selected || !this.groupEditorOpen;
  }

  private get editorVisible() {
    return this.placement === 'docked';
  }

  private updateExpanded() {
    this.panelEl.style.display = this.editorVisible ? 'flex' : 'none';
    this.closeDropdown();
  }

  private updateModeButtons() {
    this.modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === this.mode));
  }

  private updateActionState() {
    const count = this.positiveGroups.flat().length + this.excluded.length + feedFacetCount(this.facets);
    this.applyBtn.disabled = !this.dirty;
    this.applyBtn.textContent = this.pageMode === 'detail' ? 'Apply on feed' : this.placement === 'docked' ? 'Apply tag filters' : 'Apply';
    this.updatePresetButtons();
    this.updateFacetSummary();
    this.updateHistoryControls();
    // The all/any switch only changes anything with two or more groups — hide it otherwise.
    this.modeEl.classList.toggle('visible', this.positiveGroups.length >= 2);
    this.explainerEl.textContent =
      this.pageMode === 'detail'
        ? 'Use + next to this image’s tags to set them aside, then add them to your filter here.'
        : '';
    this.hintEl.textContent = this.dirty
      ? count
        ? this.pageMode === 'detail'
          ? 'Apply jumps to the feed with this filter'
          : ''
        : 'Apply to show the feed without these filters'
      : this.cacheStatusText();
  }

  private cacheStatusText(): string {
    const s = this.cacheStatus;
    if (!s || (!s.syncing && !s.count)) return '';
    if (s.complete) return '';
    return `Loading tag suggestions… ${formatCount(s.count)} of ${formatCount(s.target)}`;
  }

  private updateFeedSwitcher() {
    if (this.dead) return; // a scheduled refresh outliving destroy() must not re-insert the button
    const kind = getFeedKind(location.pathname);
    const tagIds = this.positiveGroups.flat().map((t) => t.id);
    const negativeIds = this.excluded.map((t) => t.id);
    if (!kind || (!tagIds.length && !negativeIds.length && !hasFeedFacets(this.facets))) {
      this.removeFeedSwitcher();
      return;
    }

    const imagesLink = findFeedNavLink('images');
    const videosLink = findFeedNavLink('videos');
    if (!imagesLink || !videosLink) return;

    ensureFeedSwitcherStyle();
    const targetKind = kind === 'images' ? 'videos' : 'images';
    const targetLabel = targetKind === 'images' ? 'Images' : 'Videos';
    const text = `${targetLabel} with these filters`;
    const href = this.buildFeedSwitchHref(targetKind);

    if (!this.switchEl) {
      this.switchEl = document.createElement('button');
      this.switchEl.id = FEED_SWITCH_ID;
      this.switchEl.type = 'button';
      this.switchEl.addEventListener('click', () => {
        if (!this.switchEl) return;
        location.assign(this.switchEl.dataset.href || href);
      });
    }

    this.switchEl.textContent = text;
    this.switchEl.dataset.href = href;
    this.switchEl.title = `Open the ${targetLabel.toLowerCase()} feed with the same tags and filters`;
    this.switchEl.setAttribute('aria-label', this.switchEl.title);

    if (this.switchEl.parentElement !== videosLink.parentElement) {
      videosLink.before(this.switchEl);
    } else if (this.switchEl.nextElementSibling !== videosLink) {
      videosLink.before(this.switchEl);
    }
  }

  private scheduleFeedSwitcherRefreshes() {
    for (const ms of [150, 500, 1500, 3000]) {
      this.ctx.setTimeout(() => this.updateFeedSwitcher(), ms);
    }
  }

  private buildFeedSwitchHref(kind: 'images' | 'videos'): string {
    const url = new URL(location.href);
    // Stay in context: /user/x/images → /user/x/videos, global /images → /videos.
    const p = url.pathname.replace(/\/+$/, '') || '/';
    url.pathname = p.replace(/\/(images|videos)$/, `/${kind}`);
    return this.buildCurrentFilterHref(url.toString());
  }

  private buildCurrentFilterHref(href: string): string {
    return buildHrefWithTagFilter(
      href,
      this.positiveGroups.map((group) => group.map((t) => t.id)),
      this.excluded.map((t) => t.id),
      this.mode,
      this.facets,
      this.effectiveBundles()
    );
  }

  private removeFeedSwitcher() {
    this.switchEl?.remove();
    this.switchEl = undefined;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

function formatCount(n: number): string {
  return n >= 1000 ? `${Math.floor(n / 1000)}k` : String(n);
}

function compareNumberArrays(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function sameNumberGroups(a: number[][], b: number[][]): boolean {
  return (
    a.length === b.length &&
    a.every((group, i) => group.length === b[i]?.length && group.every((id, j) => id === b[i][j]))
  );
}

function ensureFeedSwitcherStyle() {
  if (document.getElementById(FEED_SWITCH_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FEED_SWITCH_STYLE_ID;
  style.textContent = `
    #${FEED_SWITCH_ID} {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 34px;
      margin: 0 6px;
      padding: 0 14px;
      border: 1px solid var(--mantine-primary-color-filled, #1971c2);
      border-radius: 999px;
      background: color-mix(in srgb, var(--mantine-primary-color-filled, #1971c2) 14%, transparent);
      color: var(--mantine-primary-color-light-color, #74c0fc);
      font: 600 13px/1 var(--mantine-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      white-space: nowrap;
      cursor: pointer;
    }
    #${FEED_SWITCH_ID}::before {
      content: "";
      width: 8px;
      height: 8px;
      border-right: 2px solid currentColor;
      border-top: 2px solid currentColor;
      transform: rotate(45deg);
      opacity: .8;
    }
    #${FEED_SWITCH_ID}:hover {
      background: color-mix(in srgb, var(--mantine-primary-color-filled, #1971c2) 28%, transparent);
      color: #fff;
    }
  `;
  document.head.appendChild(style);
}

function findFeedNavLink(kind: 'images' | 'videos'): HTMLElement | null {
  // On a profile page, prefer that profile's own media tab link over the global feed nav.
  const profilePrefix = /^\/user\/[^/]+/.exec(location.pathname)?.[0] ?? '';
  const wanted = [`${profilePrefix}/${kind}`, `/${kind}`];
  const label = kind === 'images' ? 'Images' : 'Videos';
  const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
  for (const path of wanted) {
    for (const anchor of anchors) {
      const url = new URL(anchor.href, location.origin);
      const normalized = url.pathname.replace(/\/+$/, '') || '/';
      if (normalized === path && anchor.getClientRects().length) return anchor;
    }
  }

  const candidates = [...document.querySelectorAll<HTMLElement>('a, button, [role="tab"], [role="link"]')];
  return (
    candidates.find(
      (el) => el.textContent?.trim() === label && el.getClientRects().length > 0
    ) ?? null
  );
}

// --- image-detail tag pickup: a "+" button on every tag pill, feeding the tray ---

const PICKUP_STYLE_ID = 'cllp-tag-pickup-style';
const PICKUP_BTN_CLASS = 'cllp-tag-pickup';
let pickupWidget: TagFilterWidget | null = null;
let pickupObserver: MutationObserver | null = null;
let pickupTimer: number | undefined;
let pickupClickHandler: ((e: Event) => void) | null = null;

function startDetailTagPickup(widget: TagFilterWidget) {
  pickupWidget = widget;
  if (pickupObserver) return;
  ensurePickupStyle();
  pickupClickHandler = (e: Event) => {
    const btn = (e.target as HTMLElement).closest?.(`.${PICKUP_BTN_CLASS}`) as HTMLElement | null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = Number(btn.dataset.tagId);
    if (!Number.isInteger(id) || id <= 0) return;
    pickupWidget?.toggleDetailTag({ id, name: btn.dataset.tagName || `#${id}` });
  };
  document.addEventListener('click', pickupClickHandler, true);
  pickupObserver = new MutationObserver(() => schedulePickupScan());
  pickupObserver.observe(document.body, { childList: true, subtree: true });
  schedulePickupScan();
}

function stopDetailTagPickup() {
  pickupObserver?.disconnect();
  pickupObserver = null;
  if (pickupClickHandler) {
    document.removeEventListener('click', pickupClickHandler, true);
    pickupClickHandler = null;
  }
  if (pickupTimer) {
    clearTimeout(pickupTimer);
    pickupTimer = undefined;
  }
  document.querySelectorAll(`.${PICKUP_BTN_CLASS}`).forEach((b) => b.remove());
  document
    .querySelectorAll<HTMLElement>('[data-cllp-pickup]')
    .forEach((a) => delete a.dataset.cllpPickup);
  pickupWidget = null;
}

function schedulePickupScan() {
  if (pickupTimer) return;
  pickupTimer = window.setTimeout(() => {
    pickupTimer = undefined;
    injectPickupButtons();
  }, 300);
}

/**
 * CivitAI renders an image's tags as pills linking to `/images?tags=<id>` — a stable,
 * markup-independent hook. Each unprocessed pill gets a small "+" button appended that
 * stages {id, name} into the tray.
 */
function injectPickupButtons() {
  if (!pickupWidget) return;
  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    'a[href*="tags="]:not([data-cllp-pickup])'
  );
  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const url = new URL(href, location.origin);
    if (!/^\/(images|videos)$/.test(url.pathname)) continue;
    const id = Number(url.searchParams.get('tags'));
    const name = a.textContent?.trim() ?? '';
    if (!Number.isInteger(id) || id <= 0 || !name) continue;
    a.dataset.cllpPickup = '1';
    const btn = document.createElement('button');
    btn.className = PICKUP_BTN_CLASS;
    btn.type = 'button';
    btn.dataset.tagId = String(id);
    btn.dataset.tagName = name;
    a.insertAdjacentElement('afterend', btn);
    updatePickupButton(btn);
  }
}

function refreshPickupButtons() {
  if (!pickupWidget) return;
  document.querySelectorAll<HTMLElement>(`.${PICKUP_BTN_CLASS}`).forEach(updatePickupButton);
}

function updatePickupButton(btn: HTMLElement) {
  if (!pickupWidget) return;
  const id = Number(btn.dataset.tagId);
  const name = btn.dataset.tagName || `#${id}`;
  const state = pickupWidget.detailTagState(id);
  btn.classList.toggle('added', state !== null);
  btn.classList.toggle('excluded', state === 'negative');
  const text = state === 'negative' ? '−' : state ? '✓' : '+';
  const title =
    state === 'tray'
      ? `Remove "${name}" from the tag-filter tray`
      : state === 'positive'
        ? `Remove "${name}" from the current filter`
        : state === 'negative'
          ? `Remove "${name}" exclusion from the current filter`
          : `Add "${name}" to the tag-filter tray`;
  if (btn.textContent !== text) btn.textContent = text;
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

function ensurePickupStyle() {
  if (document.getElementById(PICKUP_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PICKUP_STYLE_ID;
  style.textContent = `
    .${PICKUP_BTN_CLASS} {
      display:inline-flex; align-items:center; justify-content:center;
      /* Voteable-tag badges are nowrap flex Groups whose own controls sit at z-10;
         match that (position for non-flex contexts) and forbid shrinking so
         variable-width siblings can neither cover nor crush the button. */
      position:relative; z-index:10; flex:0 0 auto;
      width:18px; height:18px; margin:0 4px 0 2px; vertical-align:middle;
      border:1px solid color-mix(in srgb, var(--mantine-primary-color-filled, #1971c2) 70%, transparent); border-radius:50%;
      background:color-mix(in srgb, var(--mantine-primary-color-filled, #1971c2) 22%, transparent);
      color:var(--mantine-primary-color-light-color, #74c0fc);
      font:700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor:pointer; padding:0;
    }
    .${PICKUP_BTN_CLASS}:hover { background:color-mix(in srgb, var(--mantine-primary-color-filled, #1971c2) 50%, transparent); color:#fff; }
    .${PICKUP_BTN_CLASS}.added {
      border-color:rgba(105,219,124,.7); color:#69db7c;
      background:rgba(43,138,62,.25);
    }
    .${PICKUP_BTN_CLASS}.added:hover { border-color:#fa5252; color:#ffa8a8; background:rgba(160,48,48,.3); }
    .${PICKUP_BTN_CLASS}.excluded { border-color:#c04a4a; color:#ffa8a8; background:rgba(160,48,48,.22); }
  `;
  document.head.appendChild(style);
}

let widget: TagFilterWidget | null = null;

/** Mount/unmount the tag-filter widget based on the current route, and keep it in sync. */
export function initFeedTagFilter(ctx: FeedCtx) {
  tagFilterLog('content script tag-filter init', { href: location.href, path: location.pathname });
  migrateLegacyCaches().catch(() => {});

  const sync = () => {
    const onFeed = getFeedKind(location.pathname) !== null;
    const onDetail = !onFeed && isMediaDetailPage(location.pathname);
    tagFilterLog('route sync', {
      href: location.href,
      path: location.pathname,
      onFeed,
      onDetail,
      widgetMounted: !!widget,
    });
    if (onFeed || onDetail) {
      if (!widget) widget = new TagFilterWidget(ctx);
      widget.setPageMode(onDetail ? 'detail' : 'feed');
      widget.refreshFromUrl();
    } else if (widget) {
      widget.destroy();
      widget = null;
    }
  };

  // CivitAI is a Next.js SPA: most route changes are history.pushState calls that emit
  // neither `popstate` nor (reliably) a locationWatcher tick — detect every way.
  let lastHref = location.href;
  const check = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    sync();
  };

  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: unknown[]) {
      const r = orig.apply(this, args as Parameters<History[typeof m]>);
      check();
      return r;
    } as History[typeof m];
  }
  window.addEventListener('popstate', check);
  ctx.setInterval(check, 600); // backstop for any nav path the above miss

  sync();
}
