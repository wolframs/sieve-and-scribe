import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeFilterDock } from '@/entrypoints/civitai.content/native-filter-dock';
import { TagFilterWidget } from '@/entrypoints/civitai.content/feed-tag-filter';
import { fakeBrowser } from 'wxt/testing';
import { feedFilterUiStorage } from '@/lib/storage';

let dock: NativeFilterDock | undefined;
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

function fixture() {
  document.body.innerHTML = `
    <div id="filters-target" aria-controls="filters-dropdown" aria-expanded="false">
      <button><svg class="tabler-icon-filter"></svg><span>Filters</span></button>
    </div><div id="cllp-tagfilter-host"></div>`;
  const target = document.getElementById('filters-target')!;
  const host = document.getElementById('cllp-tagfilter-host')!;
  const input = document.createElement('input');
  host.attachShadow({ mode: 'open' }).append(input);
  const change = vi.fn();
  dock = new NativeFilterDock(host, change);
  function open() {
    const popup = document.createElement('div');
    popup.id = 'filters-dropdown';
    popup.className = 'mantine-Popover-dropdown';
    popup.setAttribute('role', 'dialog');
    popup.style.cssText = 'width:100%;max-width:468px;left:700px;padding:0px';
    popup.innerHTML = '<div>Time period</div><footer><button>Apply filters</button><button>Clear all filters</button></footer>';
    target.setAttribute('aria-expanded', 'true');
    document.body.append(popup);
    return popup;
  }
  return { host, input, change, open, target };
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.stubGlobal('innerWidth', 1280);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.matches('.mantine-Popover-dropdown')
      ? parseFloat(this.style.getPropertyValue('--cllp-dock-width')) || 468
      : this.tagName === 'BUTTON' ? 100 : 0;
    return { width, height:600, x:0, y:0, top:0, left:0, right:width, bottom:600, toJSON: () => ({}) };
  });
});
afterEach(() => {
  dock?.destroy();
  dock = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('native feed filter integration', () => {
  it.each(['feed', 'detail'] as const)('uses only native Filters in %s mode, including when generation replaces the controls', async (mode) => {
    const { host, target, open } = fixture();
    dock!.destroy();
    dock = undefined;
    host.remove();
    const widget = new TagFilterWidget({
      setTimeout: () => 1, setInterval: () => 1,
      signal: new AbortController().signal, onInvalidated: () => {},
    });
    try {
      widget.setPageMode(mode);
      await settle();
      const editorHost = document.getElementById('cllp-tagfilter-host')!;
      expect(editorHost.shadowRoot!.querySelector('.launcher')).toBeNull();
      expect(editorHost.style.display).toBe('none');
      const popup = open();
      await settle();
      expect(editorHost.parentElement).toBe(popup);
      expect(editorHost.style.display).toBe('');
      popup.remove();
      target.remove();
      await settle();
      expect(editorHost.dataset.placement).toBe('unavailable');
      expect(editorHost.style.display).toBe('none');
      document.body.append(target);
      target.setAttribute('aria-expanded', 'false');
      await settle();
      expect(editorHost.dataset.placement).toBe('native-closed');
      expect(editorHost.style.display).toBe('none');
      expect(open()).toBeTruthy();
      await settle();
      expect(editorHost.dataset.placement).toBe('docked');
    } finally {
      widget.destroy();
    }
  });

  it('starts hidden without native controls even with persisted expansion', async () => {
    await feedFilterUiStorage.setValue({ expanded: true, mode: 'all', expandedGroupKeys: [] });
    const widget = new TagFilterWidget({
      setTimeout: () => 1, setInterval: () => 1,
      signal: new AbortController().signal, onInvalidated: () => {},
    });
    try {
      await settle();
      const host = document.getElementById('cllp-tagfilter-host')!;
      expect(host.dataset.placement).toBe('unavailable');
      expect(host.style.display).toBe('none');
      expect(host.shadowRoot!.querySelector('.launcher')).toBeNull();
    } finally {
      widget.destroy();
    }
  });

  it('keeps persisted standalone expansion hidden until Filters opens, with layered Escape handling', async () => {
    const { host, target, open } = fixture();
    dock!.destroy();
    dock = undefined;
    host.remove();
    await feedFilterUiStorage.setValue({ expanded: true, mode: 'all', expandedGroupKeys: [] });
    target.querySelector('button')!.addEventListener('click', () => {
      const popup = document.getElementById('filters-dropdown');
      if (popup) {
        popup.remove();
        target.setAttribute('aria-expanded', 'false');
      } else open();
    });
    const widget = new TagFilterWidget({
      setTimeout: () => 1, setInterval: () => 1,
      signal: new AbortController().signal, onInvalidated: () => {},
    });
    try {
      await settle();
      const editorHost = document.getElementById('cllp-tagfilter-host')!;
      const root = editorHost.shadowRoot!;
      expect(editorHost.style.display).toBe('none');
      target.querySelector('button')!.click();
      await settle();
      expect(editorHost.dataset.placement).toBe('docked');
      expect((root.querySelector('.panel') as HTMLElement).style.display).toBe('flex');
      expect((root.querySelector('.dropdown') as HTMLElement).style.display).toBe('none');
      root.querySelector<HTMLButtonElement>('.more-filters')!.click();
      const escape = () => root.querySelector('.facet-input')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })
      );
      escape();
      expect((root.querySelector('.facet-view') as HTMLElement).style.display).toBe('none');
      expect(editorHost.dataset.placement).toBe('docked');
      // Returning to composition can focus the input and show local suggestions.
      (root.querySelector('.dropdown') as HTMLElement).style.display = 'none';
      escape();
      await settle();
      expect(editorHost.dataset.placement).toBe('native-closed');
      expect(editorHost.style.display).toBe('none');
      expect((await feedFilterUiStorage.getValue()).expanded).toBe(true);
    } finally {
      widget.destroy();
    }
  });

  it('adds width and retains the original native controls and their handlers', async () => {
    const { host, open, change } = fixture();
    expect(change).toHaveBeenLastCalledWith('native-closed');
    const popup = open();
    const footer = popup.lastElementChild!;
    const apply = footer.querySelector('button')!;
    const onApply = vi.fn();
    apply.addEventListener('click', onApply);
    await settle();
    expect(host.parentElement).toBe(popup);
    expect(popup.style.getPropertyValue('--cllp-dock-width')).toBe('868px');
    expect(popup.style.getPropertyValue('--cllp-dock-column')).toBe('400px');
    expect(popup.style.height).toBe('');
    expect(popup.lastElementChild).toBe(footer);
    apply.click();
    expect(onApply).toHaveBeenCalledOnce();
    expect(change).toHaveBeenLastCalledWith('docked');
  });

  it('keeps draft inputs alive across popup removal and remount', async () => {
    const { host, input, open, target, change } = fixture();
    let popup = open();
    await settle();
    input.value = 'draft tags';
    popup.remove();
    target.setAttribute('aria-expanded', 'false');
    await settle();
    expect(host.parentElement).toBe(document.body);
    expect(change).toHaveBeenLastCalledWith('native-closed');
    expect(popup.hasAttribute('data-cllp-filter-dock')).toBe(false);
    popup = open();
    await settle();
    expect(host.parentElement).toBe(popup);
    expect(host.shadowRoot?.querySelector('input')).toBe(input);
    expect(input.value).toBe('draft tags');
  });

  it('stacks inside native Filters on narrow screens and restores columns on widening', async () => {
    const { host, open, change } = fixture();
    const popup = open();
    await settle();
    vi.stubGlobal('innerWidth', 700);
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(change).toHaveBeenLastCalledWith('docked');
    expect(host.parentElement).toBe(popup);
    expect(popup.getAttribute('data-cllp-filter-dock')).toBe('stacked');
    expect(host.dataset.dockLayout).toBe('stacked');
    expect(popup.style.maxWidth).toBe('468px');
    expect(popup.style.padding).toBe('0px');
    expect(popup.style.getPropertyValue('--cllp-dock-width')).toBe('468px');
    vi.stubGlobal('innerWidth', 1280);
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(host.parentElement).toBe(popup);
    expect(change).toHaveBeenLastCalledWith('docked');
  });

  it('re-measures and redocks after React rewrites the popup style attribute', async () => {
    const { host, open, change } = fixture();
    const popup = open();
    await settle();
    expect(popup.style.getPropertyValue('--cllp-dock-width')).toBe('868px');

    // React re-renders the popover and replaces the inline style wholesale, dropping our
    // custom properties — the next measurement must not turn into NaN and stick.
    popup.setAttribute('style', 'position:absolute;left:700px');
    window.dispatchEvent(new Event('resize'));
    await settle();

    expect(popup.style.getPropertyValue('--cllp-dock-width')).toBe('868px');
    expect(popup.style.getPropertyValue('--cllp-dock-column')).toBe('400px');
    expect(host.parentElement).toBe(popup);
    expect(change).toHaveBeenLastCalledWith('docked');
  });

  it('leaves other popovers alone and parks the editor when the native trigger disappears', async () => {
    const { open, target, host, change } = fixture();
    const popup = open();
    popup.lastElementChild!.remove();
    await settle();
    expect(popup.contains(host)).toBe(false);
    popup.insertAdjacentHTML('beforeend', '<button>Clear all filters</button>');
    await settle();
    expect(popup.contains(host)).toBe(true);
    target.remove();
    await settle();
    expect(change).toHaveBeenLastCalledWith('unavailable');
    expect(popup.contains(host)).toBe(false);
    expect(target.getAttribute('aria-expanded')).toBe('true');
    expect(popup.hasAttribute('data-cllp-filter-dock')).toBe(false);
  });

  it('opens via the native trigger and cleans up without remounting after destruction', async () => {
    const { target, open, host } = fixture();
    target.querySelector('button')!.addEventListener('click', open);
    expect(dock!.open()).toBe(true);
    await settle();
    const popup = host.parentElement!;
    dock!.destroy();
    dock = undefined;
    expect(host.parentElement).toBe(document.body);
    expect(popup.hasAttribute('data-cllp-filter-dock')).toBe(false);
    popup.append(document.createElement('span'));
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(host.parentElement).toBe(document.body);
  });
});
