import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChatPaste } from '@/lib/chat-paste';
import { ChatPanel } from '@/entrypoints/civitai.content/chat-panel';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = '';
});

function setup(docked = false) {
  const container = document.createElement('div');
  const composer = document.createElement('textarea');
  const transcript = document.createElement('div');
  container.append(composer, transcript);
  document.body.appendChild(container);
  const addFiles = vi.fn();
  cleanups.push(installChatPaste(docked ? document : container, composer, addFiles));
  return { container, composer, transcript, addFiles };
}

function paste(target: EventTarget, { text = '', images = [], filesOnly = false }: {
  text?: string; images?: File[]; filesOnly?: boolean;
} = {}) {
  const event = new Event('paste', { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, 'clipboardData', { value: {
    items: filesOnly ? [] : images.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files: images,
    getData: (type: string) => type === 'text/plain' ? text : '',
  } });
  target.dispatchEvent(event);
  return event;
}

describe('chat clipboard paste', () => {
  it('leaves ordinary composer text paste to the browser', () => {
    const { composer, addFiles } = setup();
    expect(paste(composer, { text: 'Hello\nworld' }).defaultPrevented).toBe(false);
    expect(addFiles).not.toHaveBeenCalled();
  });

  it.each([false, true])('attaches images from the transcript without duplicates (filesOnly=%s)', (filesOnly) => {
    const { transcript, composer, addFiles } = setup();
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    expect(paste(transcript, { images: [image], filesOnly }).defaultPrevented).toBe(true);
    expect(addFiles).toHaveBeenCalledExactlyOnceWith([image]);
    expect(document.activeElement).toBe(composer);
  });

  it('preserves both image and text content, replacing the composer selection', () => {
    const { composer, addFiles } = setup();
    composer.value = 'before OLD after';
    composer.setSelectionRange(7, 10);
    const onInput = vi.fn();
    composer.addEventListener('input', onInput);
    const image = new File(['image'], 'image.png', { type: 'image/png' });
    paste(composer, { text: 'NEW\nTEXT', images: [image] });
    expect(composer.value).toBe('before NEW\nTEXT after');
    expect(onInput).toHaveBeenCalledOnce();
    expect(addFiles).toHaveBeenCalledExactlyOnceWith([image]);
  });

  it('routes a docked document paste into the composer and removes its listener on teardown', () => {
    const { composer } = setup(true);
    expect(paste(document.body, { text: 'A pasted message' }).defaultPrevented).toBe(true);
    expect(composer.value).toBe('A pasted message');
    cleanups.pop()!();
    expect(paste(document.body, { text: 'No longer attached' }).defaultPrevented).toBe(false);
    expect(composer.value).toBe('A pasted message');
  });

  it('does not intercept model-search input or CivitAI fields outside the overlay', () => {
    const { container, composer, addFiles } = setup();
    const search = document.createElement('input');
    container.appendChild(search);
    const siteInput = document.createElement('textarea');
    document.body.appendChild(siteInput);
    const image = new File(['image'], 'image.png', { type: 'image/png' });
    for (const target of [search, siteInput]) {
      expect(paste(target, { text: 'Search', images: [image] }).defaultPrevented).toBe(false);
    }
    expect(composer.value).toBe('');
    expect(addFiles).not.toHaveBeenCalled();
  });

  it('turns a pasted image into the numbered attachment sent to the controller', async () => {
    const { container, composer } = setup();
    cleanups.pop()!();
    // Use the real attachment reader, preview builder, and send path without the model picker.
    const panel = Object.create(ChatPanel.prototype) as any;
    panel.inputArea = composer;
    panel.attachmentsEl = document.createElement('div');
    panel.pending = [];
    panel.nextImageNumber = 1;
    panel.autoGrow = vi.fn();
    panel.clearError = vi.fn();
    panel.options = { onSendMessage: vi.fn(async () => {}) };
    cleanups.push(installChatPaste(container, composer, (files) => panel.addFiles(files)));
    paste(composer, { images: [new File(['pixel'], 'clipboard.png', { type: 'image/png' })] });
    await vi.waitFor(() => expect(panel.pending).toHaveLength(1));
    expect(panel.attachmentsEl.textContent).toContain('Image 1');
    await panel.handleSend();
    expect(panel.options.onSendMessage.mock.calls[0][1]).toEqual([{
      type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWw=' },
      imageId: 1, imageName: 'clipboard.png',
    }]);
  });
});
