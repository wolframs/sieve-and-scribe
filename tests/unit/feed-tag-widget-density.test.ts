import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { TagFilterWidget } from '@/entrypoints/civitai.content/feed-tag-filter';
import { feedFilterUiStorage } from '@/lib/storage';
import type { FeedTag } from '@/lib/civitai-feed-tags';

const tag = (id: number): FeedTag => ({ id, name: `tag-${id}` });
const namedTag = (id: number, name: string): FeedTag => ({ id, name });

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
});

describe('dense tag-group summaries', () => {
  it('keeps composition controls ahead of potentially long selected groups', async () => {
    const widget = makeWidget();
    await settleStorage();
    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    const tagView = root.querySelector('.tag-view')!;
    const children = [...tagView.children];

    expect(children.indexOf(root.querySelector('.composer')!)).toBeLessThan(
      children.indexOf(root.querySelector('.chips')!)
    );
    expect(children.indexOf(root.querySelector('.chips')!)).toBeLessThan(
      children.indexOf(root.querySelector('.presets')!)
    );
    widget.destroy();
  });

  it('collapses large groups to a three-chip preview and persists manual expansion', async () => {
    const group = Array.from({ length: 10 }, (_, index) => tag(index + 1));
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [group];
    (widget as any).renderChips();

    let root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    expect(root.querySelectorAll('.group .chip')).toHaveLength(3);
    const toggle = root.querySelector<HTMLButtonElement>('.group-toggle')!;
    expect(toggle.textContent).toBe('+7 more');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(root.querySelectorAll('.group .chip')).toHaveLength(10);
    expect(root.querySelector('.group-toggle')?.textContent).toBe('Show less');
    await settleStorage();
    expect((await feedFilterUiStorage.getValue()).expandedGroupKeys).toEqual([
      '1,2,3,4,5,6,7,8,9,10',
    ]);
    widget.destroy();

    const restored = makeWidget();
    await settleStorage();
    (restored as any).positiveGroups = [group];
    (restored as any).renderChips();
    root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    expect(root.querySelectorAll('.group .chip')).toHaveLength(10);
    expect(root.querySelector('.group-toggle')?.getAttribute('aria-expanded')).toBe('true');
    restored.destroy();
  });

  it('keeps ordinary groups fully visible without a summary toggle', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [Array.from({ length: 8 }, (_, index) => tag(index + 1))];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    expect(root.querySelectorAll('.group .chip')).toHaveLength(8);
    expect(root.querySelector('.group-toggle')).toBeNull();
    widget.destroy();
  });

  it('renders preserved similarity provenance as one expandable bundle', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[
      namedTag(1, 'clothing'),
      namedTag(2, 'clothes'),
      namedTag(3, 'clothing.'),
      namedTag(4, 'outfit'),
    ]];
    (widget as any).tagBundles = [{ seedId: 1, tagIds: [1, 2, 3] }];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    const summary = root.querySelector<HTMLButtonElement>('[data-toggle-bundle="1"]')!;
    expect(summary.textContent).toContain('clothing');
    expect(summary.textContent).toContain('2 variants');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelectorAll('.group-tags .chip')).toHaveLength(1);

    summary.click();
    expect(root.querySelector('[data-toggle-bundle="1"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelectorAll('.group-tags .chip')).toHaveLength(4);
    const href = (widget as any).buildCurrentFilterHref('https://civitai.com/images');
    expect(new URL(href).searchParams.get('tagbundles')).toBe('1:1,2,3');
    widget.destroy();
  });

  it('labels every group consistently and renders the active Boolean connector', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[tag(1), tag(2)], [tag(3)]];
    (widget as any).mode = 'all';
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    expect([...root.querySelectorAll('.group-rule')].map((node) => node.textContent)).toEqual([
      'Any of 2 tags',
      '1 tag',
    ]);
    expect(root.querySelector('.group-connector')?.textContent).toBe('AND');
    expect(root.querySelectorAll('.group')).toHaveLength(2);
    expect(root.querySelectorAll('.group-tags em')).toHaveLength(0);

    (widget as any).setMode('any');
    expect(root.querySelector('.group-connector')?.textContent).toBe('OR');
    widget.destroy();
  });

  it('searches, multi-selects, and moves tags from the focused group editor', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [
      [namedTag(1, 'alpha'), namedTag(2, 'beta'), namedTag(3, 'gamma')],
      [namedTag(4, 'delta')],
    ];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-edit-group="0"]')!.click();
    expect((root.querySelector('.tag-view') as HTMLElement).style.display).toBe('none');
    expect((root.querySelector('.group-view') as HTMLElement).style.display).toBe('block');
    expect(root.querySelectorAll('.group-editor-row')).toHaveLength(3);

    const search = root.querySelector<HTMLInputElement>('.group-editor-search')!;
    search.value = 'beta';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelectorAll('.group-editor-row')).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="select-shown"]')!.click();
    expect(root.querySelector('.group-editor-count')?.textContent).toBe('1 selected · 3 total');
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="move"]')!.click();

    expect((widget as any).positiveGroups).toEqual([
      [namedTag(1, 'alpha'), namedTag(3, 'gamma')],
      [namedTag(4, 'delta'), namedTag(2, 'beta')],
    ]);
    widget.destroy();
  });

  it('surfaces unhealthy tags and opens a focused cleanup view', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[
      namedTag(1, 'clothing'),
      namedTag(2, 'Clothing'),
      namedTag(3, 'lingerie,'),
      namedTag(4, '#4'),
      namedTag(5, 'healthy'),
    ]];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    const health = root.querySelector<HTMLButtonElement>('[data-review-group="0"]')!;
    expect(health.textContent).toBe('4 need review');
    health.click();

    expect(root.querySelector('.group-editor-title')?.textContent).toBe('Review 4 tags');
    expect(root.querySelectorAll('.group-editor-row')).toHaveLength(4);
    expect(root.querySelector('.group-editor-list')?.textContent).toContain('Name unresolved');
    expect(root.querySelector('.group-editor-list')?.textContent).toContain('Duplicate visible name');
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="toggle-review"]')!.click();
    expect(root.querySelectorAll('.group-editor-row')).toHaveLength(5);
    widget.destroy();
  });

  it('exports and imports a readable grouped tag expression', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[namedTag(1, 'clothing'), namedTag(2, 'clothes')]];
    (widget as any).excluded = [namedTag(3, 'watermark')];
    (widget as any).renderChips();
    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;

    root.querySelector<HTMLButtonElement>('.expression-open')!.click();
    const input = root.querySelector<HTMLTextAreaElement>('.expression-input')!;
    expect(input.value).toBe(
      '("clothing" [#1] OR "clothes" [#2]) AND NOT ("watermark" [#3])'
    );
    expect(root.querySelector('.expression-status')?.textContent).toContain('1 positive group');

    input.value = '(new #10 OR next #11) OR (solo #12) AND NOT (bad #13)';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('.expression-import')!.click();
    expect((widget as any).positiveGroups).toEqual([
      [namedTag(10, 'new'), namedTag(11, 'next')],
      [namedTag(12, 'solo')],
    ]);
    expect((widget as any).excluded).toEqual([namedTag(13, 'bad')]);
    expect((widget as any).mode).toBe('any');
    expect((root.querySelector('.expression-view') as HTMLElement).style.display).toBe('none');
    widget.destroy();
  });

  it('sorts, restores, splits, excludes, and removes selected group tags', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [
      [namedTag(1, 'charlie'), namedTag(2, 'alpha'), namedTag(3, 'bravo'), namedTag(4, 'delta')],
      [namedTag(5, 'echo')],
    ];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[data-edit-group="0"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="sort-alpha"]')!.click();
    expect((widget as any).positiveGroups[0].map((item: FeedTag) => item.name)).toEqual([
      'alpha', 'bravo', 'charlie', 'delta',
    ]);
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="restore-order"]')!.click();
    expect((widget as any).positiveGroups[0].map((item: FeedTag) => item.name)).toEqual([
      'charlie', 'alpha', 'bravo', 'delta',
    ]);

    for (const id of [2, 3]) {
      const checkbox = root.querySelector<HTMLInputElement>(`[data-group-tag-id="${id}"]`)!;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="new-group"]')!.click();
    expect((widget as any).positiveGroups).toEqual([
      [namedTag(1, 'charlie'), namedTag(4, 'delta')],
      [namedTag(5, 'echo')],
      [namedTag(2, 'alpha'), namedTag(3, 'bravo')],
    ]);

    let checkbox = root.querySelector<HTMLInputElement>('[data-group-tag-id="1"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="exclude"]')!.click();
    expect((widget as any).excluded).toEqual([namedTag(1, 'charlie')]);

    checkbox = root.querySelector<HTMLInputElement>('[data-group-tag-id="4"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="remove"]')!.click();
    expect((widget as any).positiveGroups).toEqual([
      [namedTag(5, 'echo')],
      [namedTag(2, 'alpha'), namedTag(3, 'bravo')],
    ]);
    expect((root.querySelector('.group-view') as HTMLElement).style.display).toBe('none');
    expect((root.querySelector('.tag-view') as HTMLElement).style.display).toBe('block');
    widget.destroy();
  });

  it('undoes, redoes, and reverts complete filter drafts', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [[namedTag(1, 'alpha')]];
    (widget as any).excluded = [namedTag(9, 'watermark')];
    (widget as any).renderChips();
    (widget as any).resetDraftHistory();
    (widget as any).updateActionState();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    expect(root.querySelector('.history-summary')?.textContent).toBe(
      'Applied · 1 group · 1 tag · 1 excluded'
    );
    expect(root.querySelector<HTMLButtonElement>('.history-btn.undo')!.disabled).toBe(true);

    (widget as any).add(namedTag(2, 'beta'));
    (widget as any).setMode('any');
    expect(root.querySelector('.history-summary')?.textContent).toBe(
      'Draft · 2 groups · 2 tags · 1 excluded'
    );

    root.querySelector<HTMLButtonElement>('.history-btn.undo')!.click();
    expect((widget as any).mode).toBe('all');
    expect((widget as any).positiveGroups).toEqual([
      [namedTag(1, 'alpha')],
      [namedTag(2, 'beta')],
    ]);
    root.querySelector<HTMLButtonElement>('.history-btn.undo')!.click();
    expect((widget as any).positiveGroups).toEqual([[namedTag(1, 'alpha')]]);
    expect(root.querySelector('.history-summary')?.textContent).toContain('Applied');

    root.querySelector<HTMLButtonElement>('.history-btn.redo')!.click();
    root.querySelector<HTMLButtonElement>('.history-btn.redo')!.click();
    expect((widget as any).mode).toBe('any');
    expect((widget as any).positiveGroups).toHaveLength(2);

    root.querySelector<HTMLButtonElement>('.history-btn.revert')!.click();
    expect((widget as any).positiveGroups).toEqual([[namedTag(1, 'alpha')]]);
    expect((widget as any).mode).toBe('all');
    expect(root.querySelector<HTMLButtonElement>('.history-btn.revert')!.disabled).toBe(true);

    root.querySelector<HTMLButtonElement>('.history-btn.undo')!.click();
    expect((widget as any).mode).toBe('any');
    expect((widget as any).positiveGroups).toHaveLength(2);
    widget.destroy();
  });

  it('restores bulk group edits and secondary facets as atomic history entries', async () => {
    const widget = makeWidget();
    await settleStorage();
    (widget as any).positiveGroups = [
      [namedTag(1, 'alpha'), namedTag(2, 'beta')],
      [namedTag(3, 'gamma')],
    ];
    (widget as any).renderChips();
    (widget as any).resetDraftHistory();
    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;

    root.querySelector<HTMLButtonElement>('[data-edit-group="0"]')!.click();
    const checkbox = root.querySelector<HTMLInputElement>('[data-group-tag-id="2"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('.group-editor-count')?.textContent).toBe('1 selected · 2 total');
    expect(root.querySelector<HTMLSelectElement>('.group-editor-target')?.options).toHaveLength(1);
    expect(root.querySelector<HTMLSelectElement>('.group-editor-target')?.value).toBe('1');
    expect(root.querySelector<HTMLButtonElement>('[data-group-editor-action="move"]')?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-group-editor-action="move"]')!.click();
    expect((widget as any).positiveGroups).toEqual([
      [namedTag(1, 'alpha')],
      [namedTag(3, 'gamma'), namedTag(2, 'beta')],
    ]);

    root.querySelector<HTMLButtonElement>('.history-btn.undo')!.click();
    expect((widget as any).positiveGroups).toEqual([
      [namedTag(1, 'alpha'), namedTag(2, 'beta')],
      [namedTag(3, 'gamma')],
    ]);

    root.querySelector<HTMLButtonElement>('.more-filters')!.click();
    const reactions = root.querySelector<HTMLInputElement>('[data-facet-number="minReactions"]')!;
    reactions.value = '25';
    reactions.dispatchEvent(new Event('input', { bubbles: true }));
    expect((widget as any).facets.minReactions).toBe(25);
    root.querySelector<HTMLButtonElement>('.history-btn.undo')!.click();
    expect((widget as any).facets.minReactions).toBeUndefined();
    widget.destroy();
  });
});
