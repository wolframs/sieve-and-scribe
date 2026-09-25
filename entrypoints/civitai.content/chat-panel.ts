import { EXTENSION_PREFIX } from '@/lib/constants';
import { settingsStorage, conversationsStorage, activeConversationIdStorage } from '@/lib/storage';
import { getModelChoices, getFullModelList, setActiveModel } from '@/lib/model-choice';
import {
  modelCatalogStorage,
  favoriteModelsStorage,
  refreshModelCatalog,
  toggleFavoriteModel,
} from '@/lib/model-catalog';
import type { ChatMessage, ContentPart, ImagePart, ToolActivity } from '@/lib/types';
import { nextChatImageNumber } from '@/lib/chat-images';
import { installChatPaste } from '@/lib/chat-paste';
import { hasPromptPayload, parseAssistantMessage } from './prompt-parser';
import type { ProposedAction } from '@/lib/page-tools';
import { feedFacetSummary } from '@/lib/feed-facets';
import type { AssistantActionRecord, PageActionResult } from '@/lib/action-state';
import './style.css';

export interface ChatPanelOptions {
  /** Cancel the active response, including its remaining tool calls. */
  onStopMessage: () => void;
  onSendMessage: (
    content: string,
    attachments: ImagePart[],
    appendToPanel: (msg: ChatMessage) => void,
    updateLastAssistant: (content: string, messageId?: string, toolStatus?: string | null, toolActivity?: ToolActivity[]) => void,
    setStreaming: (streaming: boolean) => void,
    setError: (error: string | null) => void,
    appendActionCard: (action: AssistantActionRecord) => void,
    notify?: (text: string) => void,
  ) => Promise<void>;
  onApplyToForm: (
    sourceMessageId: string,
    mode: 'replace' | 'append',
    updateLastAssistant: (content: string, messageId?: string, toolStatus?: string | null, toolActivity?: ToolActivity[]) => void,
    setStreaming: (streaming: boolean) => void,
    setError: (error: string | null) => void,
    appendActionCard: (action: AssistantActionRecord) => void,
    notify: (text: string) => void
  ) => Promise<PageActionResult>;
  onNewConversation: () => Promise<void>;
  onDeleteConversation: (id: string) => Promise<void>;
  /** Make `id` the active conversation and render it (host owns restore semantics). */
  onSelectConversation: (id: string) => Promise<void>;
  onTogglePanel: () => Promise<void>;
  /** Return the URL of the image currently open on the page (or null if none). */
  onGrabPageImage: () => string | null | Promise<string | null>;
  /** Resolve a persisted LLM-proposed action through the controller. */
  onResolveAction: (
    actionId: string,
    decision: 'apply' | 'dismiss',
    updateLastAssistant: (content: string, messageId?: string, toolStatus?: string | null, toolActivity?: ToolActivity[]) => void,
    setStreaming: (streaming: boolean) => void,
    setError: (error: string | null) => void,
    appendActionCard: (action: AssistantActionRecord) => void,
    notify: (text: string) => void
  ) => Promise<PageActionResult>;
  /** Persist a visible ask_user choice and resume the assistant. */
  onAnswerQuestion: (
    actionId: string,
    optionIndex: number,
    updateLastAssistant: (content: string, messageId?: string, toolStatus?: string | null, toolActivity?: ToolActivity[]) => void,
    setStreaming: (streaming: boolean) => void,
    setError: (error: string | null) => void,
    appendActionCard: (action: AssistantActionRecord) => void,
    notify: (text: string) => void
  ) => Promise<PageActionResult>;
  /**
   * Docked mode: the panel fills its host (Chrome side panel) instead of floating
   * bottom-right over the page; minimize/close are hidden (the browser owns them).
   */
  docked?: boolean;
}

interface PendingAttachment {
  url: string; // remote URL or data: URL
  name: string;
  number: number;
}

export class ChatPanel {
  private shadow: ShadowRoot | HTMLElement;
  private container: HTMLDivElement;
  private messagesContainer: HTMLDivElement;
  private inputArea: HTMLTextAreaElement;
  private attachmentsEl: HTMLDivElement;
  private fileInput: HTMLInputElement;
  private emptyEl!: HTMLElement;
  private modelSelect!: HTMLSelectElement;
  private favBtn!: HTMLButtonElement;
  private historyEl: HTMLDivElement | null = null;
  private unwatchModel: Array<() => void> = [];
  private themeObserver?: MutationObserver;
  private options: ChatPanelOptions;
  private streaming = false;
  private onGeneratePage = false;
  private pending: PendingAttachment[] = [];
  private nextImageNumber = 1;
  private removePasteListener?: () => void;

  constructor(shadow: ShadowRoot | HTMLElement, options: ChatPanelOptions) {
    this.shadow = shadow;
    this.options = options;
    this.container = document.createElement('div');
    this.container.className = `${EXTENSION_PREFIX}-container`;
    if (options.docked) this.container.setAttribute('data-docked', '');

    // Detect theme
    const colorScheme = document.documentElement.getAttribute('data-mantine-color-scheme') ?? 'dark';
    this.container.setAttribute('data-theme', colorScheme);

    this.container.innerHTML = this.renderHTML();
    shadow.appendChild(this.container);

    this.messagesContainer = this.container.querySelector(`.${EXTENSION_PREFIX}-messages`)!;
    this.inputArea = this.container.querySelector(`.${EXTENSION_PREFIX}-input`)!;
    this.attachmentsEl = this.container.querySelector(`.${EXTENSION_PREFIX}-attachments`)!;
    this.fileInput = this.container.querySelector(`.${EXTENSION_PREFIX}-file-input`)!;

    // Empty-state placeholder shown when the transcript has no messages yet.
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = `${EXTENSION_PREFIX}-empty`;
    this.emptyEl.innerHTML = `
      <span class="${EXTENSION_PREFIX}-empty-mark"></span>
      <div class="${EXTENSION_PREFIX}-empty-title">How can I help?</div>
      <div class="${EXTENSION_PREFIX}-empty-hint">Craft a prompt, look at an image on the page, or filter the feed — just ask.</div>
    `;
    this.messagesContainer.appendChild(this.emptyEl);

    this.attachEventListeners();
    void this.initModelPicker();

    // Watch for theme changes (disconnected in destroy() to avoid leaking across panel mounts)
    this.themeObserver = new MutationObserver(() => {
      const scheme = document.documentElement.getAttribute('data-mantine-color-scheme') ?? 'dark';
      this.container.setAttribute('data-theme', scheme);
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mantine-color-scheme'],
    });
  }

  private renderHTML(): string {
    const p = EXTENSION_PREFIX;
    return `
      <div class="${p}-panel">
        <div class="${p}-header">
          <div class="${p}-header-left">
            <span class="${p}-brand-dot"></span>
            <div class="${p}-brand-text">
              <span class="${p}-title">Sieve &amp; Scribe</span>
              <span class="${p}-model-row">
                <select class="${p}-model-select" title="Model — click to switch" aria-label="Model"></select>
                <button class="${p}-fav-btn" title="Favorite this model" aria-label="Favorite this model">☆</button>
              </span>
            </div>
          </div>
          <div class="${p}-header-right">
            <button class="${p}-btn ${p}-btn-icon ${p}-history-btn" title="Conversation history" aria-label="Conversation history">🕘</button>
            <button class="${p}-btn ${p}-btn-icon ${p}-new-chat-btn" title="New conversation" aria-label="New conversation">+</button>
            <button class="${p}-btn ${p}-btn-icon ${p}-minimize-btn" title="Minimize" aria-label="Minimize">&#8722;</button>
            <button class="${p}-btn ${p}-btn-icon ${p}-close-btn" title="Close" aria-label="Close">&times;</button>
          </div>
        </div>
        <div class="${p}-messages"></div>
        <div class="${p}-error-bar" role="alert" style="display:none"></div>
        <div class="${p}-input-area">
          <div class="${p}-attachments" style="display:none"></div>
          <div class="${p}-composer">
            <textarea class="${p}-input" placeholder="Ask, paste, or drop an image…" rows="1"></textarea>
            <div class="${p}-input-actions">
              <button class="${p}-btn ${p}-btn-icon ${p}-attach-btn" title="Attach image file" aria-label="Attach image file">📎</button>
              <button class="${p}-btn ${p}-btn-icon ${p}-grab-btn" title="Attach the image open on this page" aria-label="Attach the image open on this page">🖼️</button>
              <span class="${p}-spacer" style="flex:1"></span>
              <button class="${p}-btn ${p}-send-btn" title="Send (Enter)" aria-label="Send message">
                <svg class="${p}-send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13"/>
                </svg>
                <span class="${p}-stop-label" hidden>■ Stop</span>
              </button>
            </div>
          </div>
          <input type="file" accept="image/*" multiple class="${p}-file-input" style="display:none" />
        </div>
      </div>
    `;
  }

  /**
   * The header model picker: favorites + live curated catalog (grouped), plus
   * All-models search, catalog refresh, and free-form custom entry.
   */
  private async initModelPicker(): Promise<void> {
    const p = EXTENSION_PREFIX;
    this.modelSelect = this.container.querySelector(`.${p}-model-select`)!;
    this.favBtn = this.container.querySelector(`.${p}-fav-btn`)!;
    let providerId = '';
    const rebuild = async () => {
      const { provider, current, groups, favorites, hasCatalog } = await getModelChoices();
      if (provider !== providerId) {
        providerId = provider;
        // Opportunistic staleness check per provider (TTL-guarded — a no-op refresh
        // writes nothing, so the storage watch can't loop this).
        void refreshModelCatalog(provider);
      }
      this.modelSelect.innerHTML = '';
      for (const g of groups) {
        const og = document.createElement('optgroup');
        og.label = g.label;
        for (const m of g.models) {
          const option = document.createElement('option');
          option.value = m;
          option.textContent = m;
          option.selected = m === current;
          og.appendChild(option);
        }
        this.modelSelect.appendChild(og);
      }
      const special = (value: string, text: string) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        this.modelSelect.appendChild(option);
      };
      if (hasCatalog) {
        special('__all__', 'All models… (search)');
        special('__refresh__', '↻ Refresh model list');
      }
      special('__custom__', 'Custom model…');
      const isFav = favorites.includes(current);
      this.favBtn.textContent = isFav ? '★' : '☆';
      this.favBtn.classList.toggle(`${p}-fav-on`, isFav);
      this.favBtn.title = isFav ? 'Unfavorite this model' : 'Favorite this model';
    };
    await rebuild();
    this.modelSelect.addEventListener('change', () => {
      const v = this.modelSelect.value;
      if (v === '__custom__') this.editCustomModel(rebuild);
      else if (v === '__all__') this.editCustomModel(rebuild, () => getFullModelList());
      else if (v === '__refresh__') {
        void rebuild() // snap the select back to the current model while fetching
          .then(() => refreshModelCatalog(providerId, true))
          .then((changed) => (changed ? rebuild() : undefined));
      } else void setActiveModel(v);
    });
    this.favBtn.addEventListener('click', () => {
      const v = this.modelSelect.value;
      if (v && !v.startsWith('__')) void toggleFavoriteModel(v);
    });
    // Stay in sync when the model/provider/catalog/favorites change elsewhere
    // (popup, options, another panel, a background refresh).
    this.unwatchModel = [
      settingsStorage.watch(() => void rebuild()),
      modelCatalogStorage.watch(() => void rebuild()),
      favoriteModelsStorage.watch(() => void rebuild()),
    ];
  }

  /**
   * Swap the select for an inline input (no window.prompt — unreliable in side
   * panels). With `suggestions` it becomes a searchable model list: a filtered
   * dropdown under the input (native <datalist> doesn't work in shadow DOM).
   */
  private editCustomModel(rebuild: () => Promise<void>, suggestions?: () => Promise<string[]>): void {
    const p = EXTENSION_PREFIX;
    const wrap = document.createElement('span');
    wrap.className = `${p}-model-edit`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = `${p}-model-input`;
    input.placeholder = suggestions ? 'loading models…' : 'model id — Enter to set';
    wrap.appendChild(input);
    this.modelSelect.replaceWith(wrap);
    input.focus();

    let items: string[] = [];
    let filtered: string[] = [];
    let hi = -1; // highlighted suggestion index
    let list: HTMLDivElement | null = null;
    const renderList = () => {
      if (!list) return;
      const q = input.value.trim().toLowerCase();
      const matches = q ? items.filter((i) => i.toLowerCase().includes(q)) : items;
      // starts-with matches first, then the rest — both keep alphabetical order
      filtered = [
        ...matches.filter((i) => i.toLowerCase().startsWith(q)),
        ...matches.filter((i) => !i.toLowerCase().startsWith(q)),
      ].slice(0, 40);
      hi = filtered.length ? 0 : -1;
      list.innerHTML = '';
      filtered.forEach((id, idx) => {
        const item = document.createElement('div');
        item.className = `${p}-model-suggest-item${idx === hi ? ' active' : ''}`;
        item.textContent = id;
        // mousedown (not click): fires before blur, and preventDefault keeps focus
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          done(true, id);
        });
        list!.appendChild(item);
      });
      list.style.display = filtered.length ? '' : 'none';
    };
    if (suggestions) {
      list = document.createElement('div');
      list.className = `${p}-model-suggest`;
      wrap.appendChild(list);
      void suggestions().then((s) => {
        items = s;
        input.placeholder = `search ${s.length} models…`;
        renderList();
      });
      input.addEventListener('input', renderList);
    }

    let finished = false;
    const done = (commit: boolean, value?: string) => {
      if (finished) return;
      finished = true;
      const model = (value ?? input.value).trim();
      wrap.replaceWith(this.modelSelect);
      const save = commit && model ? setActiveModel(model) : Promise.resolve();
      void save.then(() => rebuild());
    };
    const moveHighlight = (delta: number) => {
      if (!list || !filtered.length) return;
      hi = (hi + delta + filtered.length) % filtered.length;
      list.querySelectorAll(`.${p}-model-suggest-item`).forEach((el, idx) => {
        el.classList.toggle('active', idx === hi);
        if (idx === hi) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
      });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't trigger panel shortcuts (Escape closes the overlay)
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true, suggestions && hi >= 0 ? filtered[hi] : undefined);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveHighlight(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveHighlight(-1);
      }
    });
    // Search mode cancels on blur (clicking a suggestion commits via mousedown);
    // plain custom entry keeps its commit-what-you-typed-on-blur behavior.
    input.addEventListener('blur', () => done(suggestions ? false : !!input.value.trim()));
  }

  private attachEventListeners(): void {
    const p = EXTENSION_PREFIX;

    this.container.querySelector(`.${p}-close-btn`)!.addEventListener('click', () => {
      this.options.onTogglePanel();
    });

    this.container.querySelector(`.${p}-minimize-btn`)!.addEventListener('click', () => {
      this.container.classList.toggle(`${p}-minimized`);
    });

    if (this.options.docked) {
      // The browser chrome owns closing/minimizing the side panel.
      (this.container.querySelector(`.${p}-close-btn`) as HTMLElement).style.display = 'none';
      (this.container.querySelector(`.${p}-minimize-btn`) as HTMLElement).style.display = 'none';
    }

    this.container.querySelector(`.${p}-new-chat-btn`)!.addEventListener('click', () => {
      this.closeHistory();
      this.messagesContainer.innerHTML = '';
      this.messagesContainer.appendChild(this.emptyEl);
      this.refreshEmptyState();
      this.clearAttachments();
      this.nextImageNumber = 1;
      this.options.onNewConversation();
    });

    this.container.querySelector(`.${p}-history-btn`)!.addEventListener('click', () => {
      if (this.historyEl) this.closeHistory();
      else void this.openHistory();
    });
    // Any interaction outside the history dropdown closes it.
    this.container.addEventListener('mousedown', (e) => {
      if (!this.historyEl) return;
      const path = e.composedPath();
      if (
        !path.includes(this.historyEl) &&
        !path.includes(this.container.querySelector(`.${p}-history-btn`)!)
      ) {
        this.closeHistory();
      }
    });

    // Send on Enter (Shift+Enter for newline)
    this.inputArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Auto-grow the textarea with content (up to the CSS max-height).
    this.inputArea.addEventListener('input', () => this.autoGrow());

    this.container.querySelector(`.${p}-send-btn`)!.addEventListener('click', () => {
      if (this.streaming) this.handleStop();
      else void this.handleSend();
    });

    // Escape to close
    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.options.onTogglePanel();
    });

    // --- image attachment affordances ---

    this.container.querySelector(`.${p}-attach-btn`)!.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files) this.addFiles(this.fileInput.files);
      this.fileInput.value = '';
    });

    this.container.querySelector(`.${p}-grab-btn`)!.addEventListener('click', async () => {
      const url = await Promise.resolve(this.options.onGrabPageImage()).catch(() => null);
      if (url) {
        this.addAttachment({ url, name: 'page image' });
      } else {
        this.showError('No image found on this page to attach.');
      }
    });

    // The docked panel owns its document; the overlay must never capture pastes
    // intended for CivitAI's own fields outside the extension.
    this.removePasteListener = installChatPaste(
      this.options.docked ? this.container.ownerDocument : this.container,
      this.inputArea,
      (files) => this.addFiles(files)
    );

    // Drag-and-drop images onto the panel
    this.container.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        this.container.classList.add(`${p}-dragover`);
      }
    });
    this.container.addEventListener('dragleave', () => this.container.classList.remove(`${p}-dragover`));
    this.container.addEventListener('drop', (e) => {
      this.container.classList.remove(`${p}-dragover`);
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });
  }

  // --- attachments ---

  private addFiles(files: FileList | File[]): void {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          this.addAttachment({
            url: reader.result,
            name: file.name,
          });
        }
      };
      reader.readAsDataURL(file);
    }
  }

  private addAttachment(att: Omit<PendingAttachment, 'number'>): void {
    if (this.pending.some((a) => a.url === att.url)) return; // dedupe
    this.pending.push({ ...att, number: this.nextImageNumber++ });
    this.renderAttachments();
  }

  private removeAttachment(url: string): void {
    this.pending = this.pending.filter((a) => a.url !== url);
    this.renderAttachments();
  }

  private clearAttachments(): void {
    this.pending = [];
    this.renderAttachments();
  }

  private renderAttachments(): void {
    const p = EXTENSION_PREFIX;
    this.attachmentsEl.innerHTML = '';
    this.attachmentsEl.style.display = this.pending.length ? 'flex' : 'none';
    for (const att of this.pending) {
      const chip = document.createElement('div');
      chip.className = `${p}-attachment`;
      const img = document.createElement('img');
      img.src = att.url;
      img.alt = att.name;
      img.title = att.name;
      const badge = document.createElement('span');
      badge.className = `${p}-image-number`;
      badge.textContent = `Image ${att.number}`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.addEventListener('click', () => this.removeAttachment(att.url));
      chip.appendChild(img);
      chip.appendChild(badge);
      chip.appendChild(rm);
      this.attachmentsEl.appendChild(chip);
    }
  }

  private handleStop(): void {
    if (!this.streaming) return;
    const button = this.container.querySelector<HTMLButtonElement>(`.${EXTENSION_PREFIX}-send-btn`)!;
    if (button.disabled) return;
    button.disabled = true;
    button.title = 'Stopping response…';
    button.setAttribute('aria-label', 'Stopping response');
    this.container.querySelector(`.${EXTENSION_PREFIX}-stop-label`)!.textContent = 'Stopping…';
    this.options.onStopMessage();
  }

  private async handleSend(): Promise<void> {
    const content = this.inputArea.value.trim();
    if ((!content && this.pending.length === 0) || this.streaming) return;

    const attachments: ImagePart[] = this.pending.map((a) => ({
      type: 'image_url',
      image_url: { url: a.url },
      imageId: a.number,
      imageName: a.name,
    }));

    this.inputArea.value = '';
    this.autoGrow();
    this.clearAttachments();
    this.clearError();

    await this.options.onSendMessage(
      content,
      attachments,
      (msg) => this.appendMessage(msg),
      (text, messageId, status, activity) => this.updateLastAssistantMessage(text, messageId, status, activity),
      (streaming) => this.setStreaming(streaming),
      (error) => this.showError(error),
      (action) => this.appendActionCard(action),
      (text) => this.showNotification(text),
    );
  }

  /** Render an LLM-proposed page action as a confirm card (Apply / Dismiss). */
  private appendActionCard(record: AssistantActionRecord): void {
    if (record.status === 'dismissed' || record.presentation === 'inline') return;
    const action = record.action;
    const p = EXTENSION_PREFIX;
    const card = document.createElement('div');
    card.className = `${p}-action-card`;

    const title = document.createElement('div');
    title.className = `${p}-card-title`;
    title.textContent = this.actionTitle(action);

    const summary = document.createElement('div');
    summary.className = `${p}-card-summary`;
    summary.textContent = this.actionSummary(action);

    const row = document.createElement('div');
    row.className = `${p}-card-actions`;

    if (action.kind === 'question') {
      if (record.status === 'pending') {
        const optionButtons = action.options.map((option, optionIndex) => {
          const button = this.makeButton(`${p}-question-option`, option, `Answer: ${option}`);
          button.addEventListener('click', async () => {
            optionButtons.forEach((candidate) => { candidate.disabled = true; });
            dismissBtn.disabled = true;
            const result = await this.options.onAnswerQuestion(
              record.id,
              optionIndex,
              (text, messageId, status, activity) => this.updateLastAssistantMessage(text, messageId, status, activity),
              (streaming) => this.setStreaming(streaming),
              (error) => this.showError(error),
              (nextAction) => this.appendActionCard(nextAction),
              (text) => this.showNotification(text)
            );
            if (result.actionStatus === 'applied') {
              title.textContent = '✓ Answered';
              summary.textContent = `${action.question}\n\nAnswer: ${option}`;
              row.remove();
            } else {
              optionButtons.forEach((candidate) => { candidate.disabled = false; });
              dismissBtn.disabled = false;
              if (result.error) this.showError(result.error);
            }
          });
          row.appendChild(button);
          return button;
        });
        const dismissBtn = this.makeButton(`${p}-card-dismiss`, 'Dismiss', 'Dismiss question');
        dismissBtn.addEventListener('click', async () => {
          dismissBtn.disabled = true;
          const result = await this.options.onResolveAction(
            record.id,
            'dismiss',
            (text, messageId, status, activity) => this.updateLastAssistantMessage(text, messageId, status, activity),
            (streaming) => this.setStreaming(streaming),
            (error) => this.showError(error),
            (nextAction) => this.appendActionCard(nextAction),
            (text) => this.showNotification(text)
          );
          if (result.actionStatus === 'dismissed') card.remove();
          else {
            dismissBtn.disabled = false;
            if (result.error) this.showError(result.error);
          }
        });
        row.appendChild(dismissBtn);
      } else if (record.status === 'applied' && record.answer) {
        title.textContent = '✓ Answered';
        summary.textContent = `${action.question}\n\nAnswer: ${record.answer.text}`;
      }
      card.appendChild(title);
      card.appendChild(summary);
      card.appendChild(row);
      this.messagesContainer.appendChild(card);
      this.refreshEmptyState();
      this.scrollToBottom();
      return;
    }

    const applyBtn = this.makeButton(`${p}-card-apply`, 'Apply', 'Apply this action');
    const dismissBtn = this.makeButton(`${p}-card-dismiss`, 'Dismiss', 'Dismiss');
    if (record.status === 'pending') {
      row.appendChild(applyBtn);
      row.appendChild(dismissBtn);
    }

    card.appendChild(title);
    card.appendChild(summary);
    if (action.kind === 'sourceImage' && isSafeImageUrl(action.url)) {
      const preview = document.createElement('img');
      preview.className = `${p}-card-image`;
      preview.src = action.url;
      preview.alt = `Image ${action.imageNumber}`;
      card.appendChild(preview);
    }
    card.appendChild(row);

    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      const res = await this.options.onResolveAction(
        record.id,
        'apply',
        (text, messageId, status, activity) => this.updateLastAssistantMessage(text, messageId, status, activity),
        (streaming) => this.setStreaming(streaming),
        (error) => this.showError(error),
        (action) => this.appendActionCard(action),
        (text) => this.showNotification(text)
      );
      if (res.actionStatus) {
        this.renderActionStatus(title, row, action, res.actionStatus, res.error);
      } else if (res.success) {
        title.textContent = `✓ ${this.actionTitle(action)}`;
        row.remove();
      } else {
        applyBtn.disabled = false;
        if (res.error) this.showError(res.error);
      }
    });
    dismissBtn.addEventListener('click', async () => {
      dismissBtn.disabled = true;
      const res = await this.options.onResolveAction(
        record.id,
        'dismiss',
        (text, messageId, status, activity) => this.updateLastAssistantMessage(text, messageId, status, activity),
        (streaming) => this.setStreaming(streaming),
        (error) => this.showError(error),
        (action) => this.appendActionCard(action),
        (text) => this.showNotification(text)
      );
      if (res.actionStatus === 'dismissed') card.remove();
      else {
        dismissBtn.disabled = false;
        if (res.error) this.showError(res.error);
      }
    });

    if (record.status !== 'pending') {
      this.renderActionStatus(title, row, action, record.status, record.result?.error ?? null);
    }

    this.messagesContainer.appendChild(card);
    this.refreshEmptyState();
    this.scrollToBottom();
  }

  /** Restore persisted cards after a side-panel remount or conversation switch. */
  renderActions(records: AssistantActionRecord[]): void {
    for (const record of records) this.appendActionCard(record);
  }

  private renderActionStatus(
    title: HTMLElement,
    row: HTMLElement,
    action: ProposedAction,
    status: AssistantActionRecord['status'],
    error: string | null
  ): void {
    const prefix =
      status === 'applied'
        ? '✓'
        : status === 'failed'
          ? '✕'
          : status === 'unknown'
            ? '?'
            : status === 'applying'
              ? '…'
              : '';
    title.textContent = `${prefix ? `${prefix} ` : ''}${this.actionTitle(action)}`;
    if (status !== 'pending') row.remove();
    const card = title.parentElement;
    card?.querySelector(`.${EXTENSION_PREFIX}-card-error`)?.remove();
    if (error && status !== 'applied') {
      const detail = document.createElement('div');
      detail.className = `${EXTENSION_PREFIX}-card-error`;
      detail.textContent = error;
      detail.setAttribute('role', 'alert');
      card?.appendChild(detail);
    }
  }

  private actionTitle(action: ProposedAction): string {
    switch (action.kind) {
      case 'prompt':
        return 'Apply prompt to the Generate form';
      case 'feedFilter':
        return action.tags.length
          ? `Filter feed — ${action.mode === 'all' ? 'ALL' : 'ANY'} of these tags`
          : 'Filter feed by metadata';
      case 'navigate':
        return 'Go to page';
      case 'resource':
        return 'Add LoRA to the Generate form';
      case 'generate':
        return 'Run generation';
      case 'sourceImage':
        return `Use Image ${action.imageNumber} in the video workflow`;
      case 'mcpTool':
        return action.destructive
          ? `Confirm destructive CivitAI action: ${action.title ?? action.toolName}`
          : `Confirm CivitAI action: ${action.title ?? action.toolName}`;
      case 'question':
        return 'Your input is needed';
    }
  }

  private actionSummary(action: ProposedAction): string {
    switch (action.kind) {
      case 'prompt': {
        const lines = [action.positive];
        if (action.negative) lines.push(`Negative: ${action.negative}`);
        if (action.params) lines.push(Object.entries(action.params).map(([k, v]) => `${k}: ${v}`).join('  '));
        return lines.join('\n');
      }
      case 'feedFilter':
        return [action.tags.map((t) => t.name).join(', '), feedFacetSummary(action.facets)]
          .filter(Boolean)
          .join('\n');
      case 'navigate':
        return action.reason ? `${action.url}\n${action.reason}` : action.url;
      case 'resource':
        return action.weight !== undefined
          ? `${action.name}  ·  weight ${action.weight}`
          : action.name;
      case 'generate':
        return 'Click the Generate button to run with the current settings.';
      case 'sourceImage':
        return `${sourceImageSlotLabel(action.slot)} · Image ${action.imageNumber}${
          action.name ? ` (${action.name})` : ''
        }`;
      case 'mcpTool':
        return `${action.destructive ? 'Warning: CivitAI marks this action as destructive.\n' : ''}${action.toolName}\n${JSON.stringify(action.args, null, 2)}`;
      case 'question':
        return action.question;
    }
  }

  /** Tell the panel whether the Generate form is present (controls Apply/Append visibility). */
  setOnGeneratePage(on: boolean): void {
    this.onGeneratePage = on;
    this.updateApplyButtons();
  }

  /** Replay a saved conversation into the transcript (used to restore state after a remount). */
  renderConversation(messages: ChatMessage[]): void {
    this.nextImageNumber = nextChatImageNumber(messages);
    // A very fast paste can land while the saved conversation is still loading. Rebase
    // those pending badges after the restored transcript so they remain unique on screen.
    if (this.pending.length) {
      for (const attachment of this.pending) attachment.number = this.nextImageNumber++;
      this.renderAttachments();
    }
    for (const msg of messages) {
      if (msg.role === 'system' || msg.internal) continue;
      this.appendMessage(msg);
    }
    this.updateApplyButtons();
  }

  /** Conversation-history dropdown: saved conversations, switch on click, per-row delete. */
  private async openHistory(): Promise<void> {
    const p = EXTENSION_PREFIX;
    this.closeHistory();
    const panel = this.container.querySelector(`.${p}-panel`) as HTMLElement;
    const list = document.createElement('div');
    list.className = `${p}-history`;
    this.historyEl = list;
    panel.appendChild(list);

    const conversations = [...(await conversationsStorage.getValue())]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30);
    const activeId = await activeConversationIdStorage.getValue();

    if (!conversations.length) {
      const empty = document.createElement('div');
      empty.className = `${p}-history-empty`;
      empty.textContent = 'No saved conversations yet.';
      list.appendChild(empty);
      return;
    }

    for (const conv of conversations) {
      const row = document.createElement('div');
      row.className = `${p}-history-row${conv.id === activeId ? ' active' : ''}`;

      const main = document.createElement('button');
      main.className = `${p}-history-main`;
      const title = document.createElement('div');
      title.className = `${p}-history-title`;
      title.textContent = conv.title || 'Untitled chat';
      const meta = document.createElement('div');
      meta.className = `${p}-history-meta`;
      meta.textContent = `${conv.messages.length} messages · ${formatWhen(conv.updatedAt)}`;
      main.appendChild(title);
      main.appendChild(meta);
      main.addEventListener('click', () => {
        this.closeHistory();
        if (conv.id === activeId) return;
        this.clearAttachments();
        void this.options.onSelectConversation(conv.id);
      });

      const del = document.createElement('button');
      del.className = `${p}-history-del`;
      del.title = 'Delete conversation';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.options.onDeleteConversation(conv.id);
        // Deleting the ACTIVE conversation clears the transcript (storage-side the
        // active id is nulled; hosts without a storage watch won't re-render).
        if (conv.id === activeId) this.clearTranscript();
        void this.openHistory(); // re-render the list
      });

      row.appendChild(main);
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  private closeHistory(): void {
    this.historyEl?.remove();
    this.historyEl = null;
  }

  /** Empty the transcript (external conversation switch — e.g. another window's panel). */
  clearTranscript(): void {
    this.messagesContainer.innerHTML = '';
    this.messagesContainer.appendChild(this.emptyEl);
    this.clearAttachments();
    this.nextImageNumber = 1;
    this.refreshEmptyState();
  }

  private appendMessage(msg: ChatMessage): void {
    const p = EXTENSION_PREFIX;
    const div = document.createElement('div');
    div.className = `${p}-message ${p}-message-${msg.role}`;
    if (msg.id) div.dataset.messageId = msg.id;

    const contentEl = document.createElement('div');
    contentEl.className = `${p}-message-content`;
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      this.renderAssistantRich(contentEl, msg.content);
    } else {
      this.renderContentInto(contentEl, msg.content);
    }
    div.appendChild(contentEl);
    // Replayed checkpoints have no live request attached to this panel. Do not
    // resurrect an indefinite Running indicator or imply the operation failed.
    if (msg.toolActivity?.length) this.renderToolActivity(div, msg.toolActivity.map((tool) => tool.status === 'running'
      ? { ...tool, status: 'interrupted', error: 'No completion was saved for this call. Check the page before retrying an action.' }
      : tool));

    if (msg.role === 'assistant' && typeof msg.content === 'string' && hasPromptPayload(msg.content)) {
      const actions = document.createElement('div');
      actions.className = `${p}-message-actions`;
      actions.style.display = 'none';
      const applyBtn = this.makeButton(`${p}-apply-btn`, 'Apply', 'Apply to form');
      const appendBtn = this.makeButton(`${p}-apply-append-btn`, 'Append', 'Append to form');
      applyBtn.addEventListener('click', () => this.applyToForm(div.dataset.messageId, 'replace'));
      appendBtn.addEventListener('click', () => this.applyToForm(div.dataset.messageId, 'append'));
      actions.appendChild(applyBtn);
      actions.appendChild(appendBtn);
      div.appendChild(actions);
    }

    this.messagesContainer.appendChild(div);
    this.refreshEmptyState();
    this.scrollToBottom();
  }

  private async applyToForm(messageId: string | undefined, mode: 'replace' | 'append'): Promise<void> {
    if (!messageId) {
      this.showError('This prompt has not finished saving yet. Try again in a moment.');
      return;
    }
    const result = await this.options.onApplyToForm(
      messageId,
      mode,
      (content, messageId, status, activity) => this.updateLastAssistantMessage(content, messageId, status, activity),
      (streaming) => this.setStreaming(streaming),
      (error) => this.showError(error),
      (action) => this.appendActionCard(action),
      (content) => this.showNotification(content)
    );
    if (result.success) this.showNotification(`Prompt ${mode === 'append' ? 'appended' : 'applied'} to form!`);
    else if (result.error) this.showError(result.error);
  }

  /** Render plain text or multimodal parts (text + image thumbnails) into a container. */
  private renderContentInto(el: HTMLElement, content: string | ContentPart[]): void {
    const p = EXTENSION_PREFIX;
    el.textContent = '';
    if (typeof content === 'string') {
      el.textContent = content;
      return;
    }
    for (const part of content) {
      if (part.type === 'text') {
        if (!part.text) continue;
        const span = document.createElement('span');
        span.textContent = part.text;
        el.appendChild(span);
      } else {
        const url = part.image_url.url;
        if (!isSafeImageUrl(url)) continue; // ignore unexpected schemes (javascript:, data:text/html, …)
        const wrap = document.createElement('span');
        wrap.className = `${p}-msg-image`;
        const img = document.createElement('img');
        img.src = url;
        img.alt = Number.isInteger(part.imageId)
          ? `Image ${part.imageId}`
          : 'attached image';
        img.className = `${p}-msg-img`;
        img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
        wrap.appendChild(img);
        if (Number.isInteger(part.imageId)) {
          const badge = document.createElement('span');
          badge.className = `${p}-image-number`;
          badge.textContent = `Image ${part.imageId}`;
          wrap.appendChild(badge);
        }
        el.appendChild(wrap);
      }
    }
  }

  /**
   * Render a FINISHED assistant message: output-contract tags become a styled
   * prompt card (raw tag soup invites exactly the copy-paste workflow the
   * extension exists to remove); surrounding commentary stays plain text.
   * The raw text (with tags) remains the Apply payload — only rendering changes.
   */
  private renderAssistantRich(el: HTMLElement, text: string): void {
    const p = EXTENSION_PREFIX;
    el.textContent = '';
    const openIdx = text.search(/<(prompt|negative|params)>/);
    const closeMatch = [...text.matchAll(/<\/(prompt|negative|params)>/g)].at(-1);
    if (openIdx === -1 || !closeMatch) {
      this.renderAssistantText(el, text);
      return;
    }
    const parsed = parseAssistantMessage(text);
    const addText = (t: string) => {
      const trimmed = t.trim();
      if (!trimmed) return;
      const span = document.createElement('span');
      this.renderAssistantText(span, trimmed);
      el.appendChild(span);
    };
    addText(text.slice(0, openIdx));

    const card = document.createElement('div');
    card.className = `${p}-prompt-card`;
    const section = (label: string, value: string, cls = '') => {
      const sec = document.createElement('div');
      sec.className = `${p}-prompt-section ${cls}`.trim();
      const lab = document.createElement('div');
      lab.className = `${p}-prompt-label`;
      lab.textContent = label;
      const val = document.createElement('div');
      val.className = `${p}-prompt-text`;
      val.textContent = value;
      sec.appendChild(lab);
      sec.appendChild(val);
      card.appendChild(sec);
    };
    if (parsed.positivePrompt) section('Prompt', parsed.positivePrompt);
    if (parsed.negativePrompt) section('Negative', parsed.negativePrompt, `${p}-prompt-neg`);
    if (parsed.params && Object.keys(parsed.params).length) {
      const chips = document.createElement('div');
      chips.className = `${p}-prompt-params`;
      for (const [key, value] of Object.entries(parsed.params)) {
        const chip = document.createElement('span');
        chip.className = `${p}-prompt-param`;
        chip.textContent = `${key} ${value}`;
        chips.appendChild(chip);
      }
      card.appendChild(chips);
    }
    el.appendChild(card);

    addText(text.slice(closeMatch.index! + closeMatch[0].length));
  }

  /** Small safe emphasis renderer; model text is never interpreted as HTML. */
  private renderAssistantText(el: HTMLElement, text: string): void {
    el.textContent = '';
    let offset = 0;
    for (const match of text.matchAll(/\*\*([^\n]+?)\*\*|`([^`\n]+)`/g)) {
      el.appendChild(document.createTextNode(text.slice(offset, match.index)));
      const fragment = document.createElement(match[1] !== undefined ? 'strong' : 'code');
      fragment.textContent = match[1] ?? match[2];
      el.appendChild(fragment);
      offset = match.index! + match[0].length;
    }
    el.appendChild(document.createTextNode(text.slice(offset)));
  }

  private textOf(content: ContentPart[]): string {
    return content
      .filter((c): c is Extract<ContentPart, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  private makeButton(cls: string, label: string, title: string): HTMLButtonElement {
    const p = EXTENSION_PREFIX;
    const btn = document.createElement('button');
    btn.className = `${p}-btn ${cls}`;
    btn.textContent = label;
    btn.title = title;
    return btn;
  }

  private updateLastAssistantMessage(content: string, messageId?: string, toolStatus?: string | null, toolActivity?: ToolActivity[]): void {
    const p = EXTENSION_PREFIX;
    const messages = this.messagesContainer.querySelectorAll(`.${p}-message-assistant`);
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      if (messageId) (lastMsg as HTMLElement).dataset.messageId = messageId;
      const contentEl = lastMsg.querySelector(`.${p}-message-content`)!;
      contentEl.textContent = content;
      if (toolActivity) this.renderToolActivity(lastMsg as HTMLElement, toolActivity);
      let status = lastMsg.querySelector<HTMLElement>(`.${p}-tool-status`);
      if (toolStatus) {
        if (!status) {
          status = document.createElement('div');
          status.className = `${p}-tool-status`;
          status.setAttribute('role', 'status');
          status.setAttribute('aria-live', 'polite');
          lastMsg.appendChild(status);
        }
        status.textContent = toolStatus;
      } else {
        status?.remove();
      }
      this.scrollToBottom();
    }
  }

  private renderToolActivity(message: HTMLElement, tools: ToolActivity[]): void {
    const p = EXTENSION_PREFIX;
    let history = message.querySelector<HTMLDetailsElement>(`.${p}-tool-history`);
    if (!tools.length) { history?.remove(); return; }
    if (!history) {
      history = document.createElement('details');
      history.className = `${p}-tool-history`;
      history.open = true;
      message.appendChild(history);
    }
    history.replaceChildren();
    const summary = document.createElement('summary');
    const failed = tools.filter((tool) => tool.status === 'failed').length;
    summary.textContent = `Tool activity · ${tools.length}${failed ? ` · ${failed} failed` : ''}`;
    history.appendChild(summary);
    for (const tool of tools) {
      const row = document.createElement('div');
      row.className = `${p}-tool-row`;
      row.dataset.status = tool.status;
      const label = document.createElement('div');
      label.className = `${p}-tool-label`;
      label.textContent = tool.label;
      const status = document.createElement('span');
      status.className = `${p}-tool-state`;
      status.textContent = { running: 'Running', completed: 'Done', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' }[tool.status];
      row.append(label, status);
      if (tool.error) {
        const error = document.createElement('div');
        error.className = `${p}-tool-error`;
        error.textContent = tool.error;
        row.appendChild(error);
      }
      history.appendChild(row);
    }
  }

  private setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    const p = EXTENSION_PREFIX;
    const button = this.container.querySelector<HTMLButtonElement>(`.${p}-send-btn`)!;
    button.disabled = false;
    button.title = streaming ? 'Stop response' : 'Send (Enter)';
    button.setAttribute('aria-label', streaming ? 'Stop response' : 'Send message');
    button.classList.toggle(`${p}-stop-btn`, streaming);
    this.container.querySelector<SVGElement>(`.${p}-send-icon`)!.style.display = streaming ? 'none' : '';
    const stopLabel = this.container.querySelector<HTMLElement>(`.${p}-stop-label`)!;
    stopLabel.hidden = !streaming;
    stopLabel.textContent = '■ Stop';

    if (streaming) {
      const div = document.createElement('div');
      div.className = `${p}-message ${p}-message-assistant ${p}-streaming`;
      div.innerHTML = `<div class="${p}-message-content"><span class="${p}-typing-dots"><span></span><span></span><span></span></span></div>`;
      this.messagesContainer.appendChild(div);
      this.refreshEmptyState();
      this.scrollToBottom();
    } else {
      const streamingMsg = this.messagesContainer.querySelector(`.${p}-streaming`);
      if (streamingMsg) {
        streamingMsg.querySelector(`.${p}-tool-status`)?.remove();
        streamingMsg.classList.remove(`${p}-streaming`);
        const contentEl = streamingMsg.querySelector(`.${p}-message-content`);
        if (!streamingMsg.querySelector(`.${p}-tool-history`) && (contentEl?.querySelector(`.${p}-typing-dots`) || !contentEl?.textContent?.trim())) {
          // The stream ended before any content arrived (error/abort) — drop the
          // placeholder bubble instead of leaving frozen typing dots in the transcript.
          streamingMsg.remove();
          this.refreshEmptyState();
        } else if (contentEl && !streamingMsg.querySelector(`.${p}-message-actions`)) {
          // Stream finished: capture the raw text FIRST (it's the Apply payload —
          // the pretty card rendering strips the tags from the DOM), then prettify.
          const rawText = contentEl.textContent ?? '';
          this.renderAssistantRich(contentEl as HTMLElement, rawText);
          if (!hasPromptPayload(rawText)) {
            this.updateApplyButtons();
            return;
          }
          const actions = document.createElement('div');
          actions.className = `${p}-message-actions`;
          actions.style.display = this.onGeneratePage ? 'flex' : 'none';
          const applyBtn = this.makeButton(`${p}-apply-btn`, 'Apply', 'Apply to form');
          const appendBtn = this.makeButton(`${p}-apply-append-btn`, 'Append', 'Append to form');
          applyBtn.addEventListener('click', () =>
            this.applyToForm((streamingMsg as HTMLElement).dataset.messageId, 'replace')
          );
          appendBtn.addEventListener('click', () =>
            this.applyToForm((streamingMsg as HTMLElement).dataset.messageId, 'append')
          );
          actions.appendChild(applyBtn);
          actions.appendChild(appendBtn);
          streamingMsg.appendChild(actions);
        }
      }
      this.updateApplyButtons();
    }
  }

  private updateApplyButtons(): void {
    const p = EXTENSION_PREFIX;
    const actions = this.messagesContainer.querySelectorAll(`.${p}-message-actions`);
    actions.forEach((el) => {
      (el as HTMLElement).style.display = this.onGeneratePage ? 'flex' : 'none';
    });
  }

  private showError(error: string | null): void {
    const p = EXTENSION_PREFIX;
    const errorBar = this.container.querySelector(`.${p}-error-bar`) as HTMLElement;
    if (error) {
      errorBar.textContent = error;
      errorBar.style.display = 'block';
    } else {
      errorBar.style.display = 'none';
    }
  }

  private clearError(): void {
    this.showError(null);
  }

  private showNotification(text: string): void {
    const p = EXTENSION_PREFIX;
    const notif = document.createElement('div');
    notif.className = `${p}-notification`;
    notif.textContent = text;
    this.container.appendChild(notif);
    setTimeout(() => {
      notif.classList.add(`${p}-notification-fade`);
      setTimeout(() => notif.remove(), 500);
    }, 2000);
  }

  private autoGrow(): void {
    const ta = this.inputArea;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  private refreshEmptyState(): void {
    const p = EXTENSION_PREFIX;
    const hasContent = this.messagesContainer.querySelector(`.${p}-message, .${p}-action-card`);
    this.emptyEl.style.display = hasContent ? 'none' : 'flex';
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    });
  }

  destroy(): void {
    this.removePasteListener?.();
    this.closeHistory();
    this.themeObserver?.disconnect();
    for (const unwatch of this.unwatchModel) unwatch();
    this.container.remove();
  }
}

/** Only allow image sources we trust to render/open: data:image, blob:, and https URLs. */
function isSafeImageUrl(url: string): boolean {
  return /^(data:image\/|blob:|https:\/\/)/i.test(url);
}

function sourceImageSlotLabel(
  slot: Extract<ProposedAction, { kind: 'sourceImage' }>['slot']
): string {
  switch (slot) {
    case 'source':
      return 'Image-to-video source';
    case 'firstFrame':
      return 'First frame';
    case 'lastFrame':
      return 'Last frame';
    case 'reference':
      return 'Reference image';
  }
}

/** "14:32" for today, "Jul 18" style otherwise. */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
