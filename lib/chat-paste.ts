/** Native paste covers Ctrl+V, Cmd+V, and the context menu without clipboard permissions. */
export function installChatPaste(
  root: HTMLElement | ShadowRoot | Document,
  composer: HTMLTextAreaElement,
  addFiles: (files: File[]) => void
): () => void {
  const onPaste = (event: Event) => {
    const paste = event as ClipboardEvent;
    if (paste.defaultPrevented || !paste.clipboardData) return;

    // composedPath exposes the real target when the overlay lives in a shadow root.
    const target = paste.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement);
    if (target !== composer && target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;

    const clipboard = paste.clipboardData;
    const itemFiles = Array.from(clipboard.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file?.type.startsWith('image/')));
    // Some clipboard implementations only populate files. Prefer items when present
    // because these two lists usually describe the same images.
    const files = itemFiles.length ? itemFiles : Array.from(clipboard.files ?? []).filter((file) => file.type.startsWith('image/'));
    const text = clipboard.getData('text/plain');

    if (!files.length && (!text || target === composer)) return; // Native textarea text paste.
    paste.preventDefault();
    composer.focus();
    if (text) {
      composer.setRangeText(text, composer.selectionStart, composer.selectionEnd, 'end');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (files.length) addFiles(files);
  };
  root.addEventListener('paste', onPaste);
  return () => root.removeEventListener('paste', onPaste);
}
