import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagFilterWidget } from '@/entrypoints/civitai.content/feed-tag-filter';
import type { FeedTag } from '@/lib/civitai-feed-tags';

const tag = (id: number): FeedTag => ({ id, name: `tag-${id}` });

function makeWidget() {
  const widget = new TagFilterWidget({
    setTimeout: () => 1,
    setInterval: () => 1,
    signal: new AbortController().signal,
    onInvalidated: () => {},
  });
  return widget;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tag-filter chip drag and drop', () => {
  it('drags a complete OR group into another group', async () => {
    const widget = makeWidget();
    await Promise.resolve();
    (widget as any).positiveGroups = [[tag(1), tag(2)], [tag(3), tag(4)]];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    const handle = root.querySelector<HTMLElement>('.group-grip[data-group="0"]')!;
    const target = root.querySelector<HTMLElement>('.group[data-group="1"]')!;
    const transfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    };

    expect(handle.getAttribute('draggable')).toBe('true');
    expect(handle.getAttribute('aria-label')).toBe('Move 2-tag OR group');

    (widget as any).onChipDragStart({
      target: handle,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });
    (widget as any).onChipDragOver({
      target,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });

    expect(target.classList.contains('drop-target')).toBe(true);
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'group:0');

    (widget as any).onChipDrop({
      target,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });

    expect((widget as any).positiveGroups).toEqual([
      [tag(3), tag(4), tag(1), tag(2)],
    ]);
    expect(root.querySelector('.drag-status')?.textContent).toContain(
      'Merged the 2-tag OR group'
    );
    widget.destroy();
  });

  it('offers group merge targets from the group handle menu', async () => {
    const widget = makeWidget();
    await Promise.resolve();
    (widget as any).positiveGroups = [[tag(1), tag(2)], [tag(3), tag(4)]];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.group-grip[data-group="0"]')!.click();
    const merge = root.querySelector<HTMLButtonElement>(
      '[data-menu-group-action="merge"][data-source-group="0"][data-target-group="1"]'
    )!;

    expect(merge.textContent).toContain('Merge into: tag-3 or tag-4');
    merge.click();
    expect((widget as any).positiveGroups).toEqual([
      [tag(3), tag(4), tag(1), tag(2)],
    ]);
    widget.destroy();
  });

  it('renders positive chips as draggable and moves a standalone chip into an OR well', async () => {
    const widget = makeWidget();
    await Promise.resolve();
    (widget as any).positiveGroups = [[tag(1), tag(2)], [tag(3)], [tag(4)]];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    const dragged = root.querySelector<HTMLElement>('.chip[data-id="4"]')!;
    const target = root.querySelector<HTMLElement>('.group[data-group="0"]')!;
    const transfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    };

    expect(dragged.getAttribute('draggable')).toBe('true');
    expect(dragged.querySelector('.drag-grip')).not.toBeNull();

    (widget as any).onChipDragStart({
      target: dragged,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });
    (widget as any).onChipDragOver({
      target,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });

    expect(target.classList.contains('drop-target')).toBe(true);
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', '4');

    (widget as any).onChipDrop({
      target,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });

    expect((widget as any).positiveGroups).toEqual([
      [tag(1), tag(2), tag(4)],
      [tag(3)],
    ]);
    expect(root.querySelector('.drag-status')?.textContent).toContain(
      'tag-4 moved into the OR group'
    );
    widget.destroy();
  });

  it('reveals the separate-AND target only while dragging a tag out of a multi-tag group', async () => {
    const widget = makeWidget();
    await Promise.resolve();
    (widget as any).positiveGroups = [[tag(1), tag(2)], [tag(3)]];
    (widget as any).renderChips();

    const root = document.getElementById('cllp-tagfilter-host')!.shadowRoot!;
    const dragged = root.querySelector<HTMLElement>('.chip[data-id="2"]')!;
    const splitTarget = root.querySelector<HTMLElement>('.and-dropzone')!;
    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };

    (widget as any).onChipDragStart({
      target: dragged,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });
    expect(root.querySelector('.chips')?.classList.contains('can-split')).toBe(true);

    (widget as any).onChipDrop({
      target: splitTarget,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    });

    expect((widget as any).positiveGroups).toEqual([[tag(1)], [tag(3)], [tag(2)]]);
    expect(root.querySelector('.drag-status')?.textContent).toBe(
      'tag-2 is now a separate AND tag.'
    );
    widget.destroy();
  });
});
