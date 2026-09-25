import { describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '@/entrypoints/civitai.content/chat-panel';

// Exercise transcript rendering without starting the unrelated provider catalog.
function panelHarness() {
  const panel = Object.create(ChatPanel.prototype) as any;
  panel.container = document.createElement('div');
  panel.container.innerHTML = panel.renderHTML();
  panel.messagesContainer = document.createElement('div');
  panel.options = { onApplyToForm: vi.fn(async () => ({ success: true, error: null })) };
  panel.onGeneratePage = true;
  panel.refreshEmptyState = vi.fn();
  panel.scrollToBottom = vi.fn();
  panel.showNotification = vi.fn();
  panel.showError = vi.fn();
  return panel;
}

describe('assistant output controls', () => {
  it('removes the legacy transient status when the turn ends', () => {
    const panel = panelHarness();
    panel.setStreaming(true);
    panel.updateLastAssistantMessage('Let me check.', 'reply', 'Searching for <img src=x>…');
    const status = panel.messagesContainer.querySelector('[role="status"]');
    expect(status.textContent).toBe('Searching for <img src=x>…');
    expect(status.querySelector('img')).toBeNull();
    expect(panel.messagesContainer.querySelector('.cllp-message-content').textContent).toBe('Let me check.');
    panel.setStreaming(false);
    expect(panel.messagesContainer.querySelector('[role="status"]')).toBeNull();
    expect(panel.messagesContainer.textContent).toBe('Let me check.');
  });

  it('keeps tool-only replies and their failures visible after completion and restoration', () => {
    const panel = panelHarness();
    const activity = [{ id: 'call', name: 'search', label: 'Search <img src=x>', status: 'failed', error: '<script>bad()</script>' }];
    panel.setStreaming(true);
    panel.updateLastAssistantMessage('', 'reply', null, activity);
    panel.setStreaming(false);
    const history = panel.messagesContainer.querySelector('.cllp-tool-history');
    expect(history.open).toBe(true);
    expect(history.textContent).toContain('1 failed');
    expect(history.querySelector('.cllp-tool-error').textContent).toBe(activity[0].error);
    expect(history.querySelector('img, script')).toBeNull();
    history.open = false;
    panel.updateLastAssistantMessage('Finished.', 'reply', null, activity);
    expect(history.open).toBe(false);
    panel.messagesContainer.replaceChildren();
    panel.appendMessage({ id: 'reply', role: 'assistant', content: '', toolActivity: activity, timestamp: 1 });
    expect(panel.messagesContainer.querySelector('.cllp-tool-row').dataset.status).toBe('failed');
    expect(panel.messagesContainer.querySelector('.cllp-tool-error').textContent).toBe(activity[0].error);
  });

  it('keeps errors visible until they are explicitly cleared', () => {
    vi.useFakeTimers();
    try {
      const panel = panelHarness();
      const showError = (ChatPanel.prototype as any).showError.bind(panel);
      showError('Provider returned an error.');
      vi.advanceTimersByTime(60_000);
      const alert = panel.container.querySelector('[role="alert"]');
      expect(alert.style.display).toBe('block');
      showError(null);
      expect(alert.style.display).toBe('none');
    } finally { vi.useRealTimers(); }
  });
  it('switches Send to Stop while streaming, preserves the draft, and restores Send after cleanup', () => {
    const panel = panelHarness();
    panel.inputArea = panel.container.querySelector('.cllp-input');
    panel.fileInput = panel.container.querySelector('.cllp-file-input');
    panel.options.onStopMessage = vi.fn();
    panel.attachEventListeners();
    try {
      const button = panel.container.querySelector('.cllp-send-btn');
      panel.setStreaming(true);
      panel.inputArea.value = 'My next message';
      expect(button.getAttribute('aria-label')).toBe('Stop response');
      expect(panel.container.querySelector('.cllp-stop-label').hidden).toBe(false);
      // Enter while drafting must not cancel the active response.
      panel.inputArea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(panel.options.onStopMessage).not.toHaveBeenCalled();
      button.click();
      button.click();
      expect(panel.options.onStopMessage).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-label')).toBe('Stopping response');
      expect(panel.inputArea.value).toBe('My next message');
      panel.updateLastAssistantMessage('Partial reply.\n\nResponse stopped.', 'stopped');
      panel.setStreaming(false);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-label')).toBe('Send message');
      expect(panel.container.querySelector('.cllp-stop-label').hidden).toBe(true);
      expect(panel.messagesContainer.textContent).toContain('Partial reply.');
    } finally {
      panel.removePasteListener();
    }
  });
  it.each(['restored', 'streamed'])('only offers Apply on a prompt payload in %s output', (mode) => {
    const panel = panelHarness();
    for (const [id, content] of [
      ['prose', '**What failed:** the `prompt` did not match. <img src=x onerror=alert(1)>'],
      ['payload', '<prompt>subject: glass\nsetting: grass</prompt>'],
    ]) {
      if (mode === 'restored') panel.appendMessage({ id, role: 'assistant', content, timestamp: 1 });
      else {
        panel.setStreaming(true);
        panel.updateLastAssistantMessage(content, id);
        panel.setStreaming(false);
      }
    }
    const prose = panel.messagesContainer.querySelector('[data-message-id="prose"]');
    const payload = panel.messagesContainer.querySelector('[data-message-id="payload"]');
    expect(prose.querySelector('button')).toBeNull();
    expect(prose.querySelector('strong')?.textContent).toBe('What failed:');
    expect(prose.querySelector('code')?.textContent).toBe('prompt');
    expect(prose.querySelector('img')).toBeNull();
    expect(payload.querySelectorAll('button')).toHaveLength(2);
    payload.querySelector('.cllp-apply-btn').click();
    expect(panel.options.onApplyToForm).toHaveBeenCalledWith('payload', 'replace',
      expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function));
  });
});
