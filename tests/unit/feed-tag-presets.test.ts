import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { TagFilterWidget } from '@/entrypoints/civitai.content/feed-tag-filter';
import { feedFilterPresetsStorage, feedGroupPresetsStorage, feedTagTrayStorage } from '@/lib/storage';
import type { FeedTag } from '@/lib/civitai-feed-tags';

const tag = (id: number, name = `tag-${id}`): FeedTag => ({ id, name });

function makeWidget() {
  return new TagFilterWidget({
    setTimeout: () => 1,
    setInterval: () => 1,
    signal: new AbortController().signal,
    onInvalidated: () => {},
  });
}

async function settleStorage() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fakeBrowser.reset();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as any).prompt;
  delete (window as any).confirm;
  vi.restoreAllMocks();
});

describe('detail-page tag pickup', () => {
  it('toggles tray, positive, and excluded tags back out again', async () => {
    const widget = makeWidget();
    await settleStorage();

    widget.addToTray(tag(1, 'portrait'));
    expect(widget.detailTagState(1)).toBe('tray');
    widget.toggleDetailTag(tag(1, 'portrait'));
    expect(widget.detailTagState(1)).toBeNull();
    expect((await feedTagTrayStorage.getValue()).tags).toEqual([]);

    (widget as any).positiveGroups = [[tag(2, 'woman')]];
    (widget as any).renderChips();
    expect(widget.detailTagState(2)).toBe('positive');
    widget.toggleDetailTag(tag(2, 'woman'));
    expect(widget.detailTagState(2)).toBeNull();

    (widget as any).excluded = [tag(3, 'watermark')];
    (widget as any).renderChips();
    expect(widget.detailTagState(3)).toBe('negative');
    widget.toggleDetailTag(tag(3, 'watermark'));
    expect(widget.detailTagState(3)).toBeNull();
    widget.destroy();
  });
});

describe('tag tray actions', () => {
  it('keeps primary assignment one-click and reserves the menu for OR targets and discard', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[tag(10, 'portrait')]];
    (widget as any).tray = [tag(20, 'snowing')];
    (widget as any).renderChips();
    (widget as any).renderTray();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    const actions = root.querySelectorAll<HTMLButtonElement>('.tray-action');
    expect(actions).toHaveLength(3);
    expect([...actions].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Add as AND filter',
      'Exclude this tag',
      'OR into a group or discard',
    ]);

    root.querySelector<HTMLButtonElement>('[data-tray-action="more"]')!.click();
    const menuText = root.querySelector('.menu')!.textContent!;
    expect(menuText).toContain('OR into: portrait');
    expect(menuText).toContain('Discard from tray');
    expect(menuText).not.toContain('Add as AND filter');
    expect(menuText).not.toContain('Exclude this tag');

    root.querySelector<HTMLButtonElement>('[data-menu-action="or"]')!.click();
    expect((widget as any).positiveGroups).toEqual([[tag(10, 'portrait'), tag(20, 'snowing')]]);
    expect((widget as any).tray).toEqual([]);
    widget.destroy();
  });

  it('assigns direct AND and exclude actions without opening a menu', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).tray = [tag(30, 'black fur'), tag(31, 'no humans')];
    (widget as any).renderTray();
    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;

    root.querySelector<HTMLButtonElement>('[data-id="30"][data-tray-action="and"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-id="31"][data-tray-action="exclude"]')!.click();

    expect((widget as any).positiveGroups).toEqual([[tag(30, 'black fur')]]);
    expect((widget as any).excluded).toEqual([tag(31, 'no humans')]);
    expect((widget as any).tray).toEqual([]);
    expect((root.querySelector('.menu') as HTMLElement).style.display).not.toBe('block');
    widget.destroy();
  });
});

describe('saved tag-filter presets', () => {
  it('saves, loads, replaces by name, and deletes a complete filter', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[tag(10, 'woman'), tag(11, 'girl')], [tag(12, 'portrait')]];
    (widget as any).excluded = [tag(13, 'watermark')];
    (widget as any).tagBundles = [{ seedId: 10, tagIds: [10, 11] }];
    (widget as any).mode = 'all';
    (widget as any).facets = {
      creatorsInclude: ['weby2'],
      creatorsExclude: [],
      orientations: ['portrait'],
      primaryModel: { versionId: 501, label: 'Dream Model — v3' },
      resourcesInclude: [{ versionId: 601, label: 'Rain LoRA — v2' }],
      resourcesExclude: [{ versionId: 701, label: 'Artifact Helper — old' }],
      minReactions: 100,
    };
    (widget as any).renderChips();
    (widget as any).updateActionState();

    Object.defineProperty(window, 'prompt', {
      configurable: true,
      value: vi.fn(() => 'Portrait cleanup'),
    });
    await (widget as any).savePreset();

    let stored = await feedFilterPresetsStorage.getValue();
    expect(stored.presets).toHaveLength(1);
    expect(stored.presets[0]).toMatchObject({
      name: 'Portrait cleanup',
      groups: [[tag(10, 'woman'), tag(11, 'girl')], [tag(12, 'portrait')]],
      negatives: [tag(13, 'watermark')],
      mode: 'all',
      bundles: [{ seedId: 10, tagIds: [10, 11] }],
      facets: {
        creatorsInclude: ['weby2'],
        creatorsExclude: [],
        orientations: ['portrait'],
        primaryModel: { versionId: 501, label: 'Dream Model — v3' },
        resourcesInclude: [{ versionId: 601, label: 'Rain LoRA — v2' }],
        resourcesExclude: [{ versionId: 701, label: 'Artifact Helper — old' }],
        minReactions: 100,
      },
    });

    // Saving the same name updates that preset instead of creating an ambiguous duplicate.
    (widget as any).excluded = [];
    await (widget as any).savePreset();
    stored = await feedFilterPresetsStorage.getValue();
    expect(stored.presets).toHaveLength(1);
    expect(stored.presets[0].negatives).toEqual([]);

    (widget as any).clearSelection();
    (widget as any).presetSelectEl.value = stored.presets[0].id;
    (widget as any).loadSelectedPreset();
    expect((widget as any).positiveGroups).toEqual(stored.presets[0].groups);
    expect((widget as any).excluded).toEqual([]);
    expect((widget as any).mode).toBe('all');
    expect((widget as any).tagBundles).toEqual([{ seedId: 10, tagIds: [10, 11] }]);
    expect((widget as any).facets).toEqual(stored.presets[0].facets);

    Object.defineProperty(window, 'confirm', {
      configurable: true,
      value: vi.fn(() => true),
    });
    await (widget as any).deleteSelectedPreset();
    expect((await feedFilterPresetsStorage.getValue()).presets).toEqual([]);
    widget.destroy();
  });

  it('loads a v1 tag-only preset with empty facets', async () => {
    const widget = makeWidget();
    await settleStorage();
    const legacy = {
      id: 'legacy',
      name: 'Legacy tags',
      groups: [[tag(40, 'portrait')]],
      negatives: [],
      mode: 'all' as const,
    };
    (widget as any).presets = [legacy];
    (widget as any).renderPresets('legacy');
    (widget as any).loadSelectedPreset();

    expect((widget as any).positiveGroups).toEqual(legacy.groups);
    expect((widget as any).facets).toEqual({
      creatorsInclude: [], creatorsExclude: [], orientations: [],
      resourcesInclude: [], resourcesExclude: [],
    });
    widget.destroy();
  });

  it('edits compact metadata facets without obscuring the tag-first panel', async () => {
    const widget = makeWidget();
    await settleStorage();
    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;

    root.querySelector<HTMLButtonElement>('.more-filters')!.click();
    expect((root.querySelector('.tag-view') as HTMLElement).style.display).toBe('none');
    expect((root.querySelector('.facet-view') as HTMLElement).style.display).toBe('block');

    const creators = root.querySelector<HTMLInputElement>('[data-facet="creatorsInclude"]')!;
    creators.value = 'Alice, @Bob';
    creators.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-orientation="portrait"]')!.click();
    const reactions = root.querySelector<HTMLInputElement>('[data-facet-number="minReactions"]')!;
    reactions.value = '100';
    reactions.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('.back')!.click();

    expect((widget as any).facets).toMatchObject({
      creatorsInclude: ['alice', 'bob'],
      orientations: ['portrait'],
      minReactions: 100,
    });
    expect(root.querySelector('.facet-summary')!.textContent).toContain('≥100 reactions');
    expect((root.querySelector('.tag-view') as HTMLElement).style.display).toBe('block');
    widget.destroy();
  });

  it('assigns resolved model versions without looking up feed cards', async () => {
    const widget = makeWidget();
    await settleStorage();
    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    (widget as any).resourceOptions = [
      { versionId: 501, label: 'Dream Model — v3' },
      { versionId: 601, label: 'Rain LoRA — v2' },
      { versionId: 701, label: 'Artifact Helper — old' },
    ];
    (widget as any).resourceResultsEl.innerHTML = [
      '<button data-resource-action="primary" data-version-id="501">Model</button>',
      '<button data-resource-action="include" data-version-id="601">+</button>',
      '<button data-resource-action="exclude" data-version-id="701">−</button>',
    ].join('');

    root.querySelector<HTMLButtonElement>('[data-version-id="501"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-version-id="601"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-version-id="701"]')!.click();

    expect((widget as any).facets).toMatchObject({
      primaryModel: { versionId: 501, label: 'Dream Model — v3' },
      resourcesInclude: [{ versionId: 601, label: 'Rain LoRA — v2' }],
      resourcesExclude: [{ versionId: 701, label: 'Artifact Helper — old' }],
    });
    expect(root.querySelector('.resource-selections')!.textContent).toContain('Dream Model');
    root.querySelector<HTMLButtonElement>('[data-remove-resource="include"]')!.click();
    expect((widget as any).facets.resourcesInclude).toEqual([]);
    widget.destroy();
  });
});

describe('reusable tag-group presets', () => {
  it('saves, inserts, replaces, and deletes one OR group with bundle provenance', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[tag(10, 'woman'), tag(11, 'girl')], [tag(90, 'portrait')]];
    (widget as any).tagBundles = [{ seedId: 10, tagIds: [10, 11] }];
    (widget as any).renderChips();
    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-edit-group="0"]')!.click();
    Object.defineProperty(window, 'prompt', {
      configurable: true,
      value: vi.fn(() => 'People'),
    });
    await (widget as any).saveFocusedGroupPreset();

    const stored = await feedGroupPresetsStorage.getValue();
    expect(stored.presets).toHaveLength(1);
    expect(stored.presets[0]).toMatchObject({
      name: 'People',
      tags: [tag(10, 'woman'), tag(11, 'girl')],
      bundles: [{ seedId: 10, tagIds: [10, 11] }],
    });

    (widget as any).closeGroupEditor();
    (widget as any).positiveGroups = [[tag(20, 'landscape')]];
    (widget as any).tagBundles = [];
    (widget as any).renderChips();
    (widget as any).groupPresetSelectEl.value = stored.presets[0].id;
    (widget as any).groupPresetEditorSelectEl.value = stored.presets[0].id;
    (widget as any).insertSelectedGroupPreset();
    expect((widget as any).positiveGroups).toEqual([
      [tag(20, 'landscape')],
      [tag(10, 'woman'), tag(11, 'girl')],
    ]);
    expect((widget as any).tagBundles).toContainEqual({ seedId: 10, tagIds: [10, 11] });

    (widget as any).positiveGroups = [[tag(30, 'old')]];
    (widget as any).tagBundles = [];
    (widget as any).renderChips();
    root.querySelector<HTMLButtonElement>('[data-edit-group="0"]')!.click();
    (widget as any).replaceWithSelectedGroupPreset();
    expect((widget as any).positiveGroups).toEqual([[tag(10, 'woman'), tag(11, 'girl')]]);

    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
    await (widget as any).deleteSelectedGroupPreset();
    expect((await feedGroupPresetsStorage.getValue()).presets).toEqual([]);
    widget.destroy();
  });
});
