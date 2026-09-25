/**
 * Side-panel chat — the primary chat surface (browser-docked, like the ChatGPT/Claude
 * extensions), replacing the in-page overlay as the default UX.
 *
 * Same ChatPanel UI and chat-controller flow as the overlay; the difference is page
 * access: this document has no DOM access to CivitAI, so every page operation
 * (read form, apply prompt, page context/images, action cards) is an RPC to the
 * active tab's content script via the page bridge. When the active tab isn't
 * CivitAI, chat still works — page-dependent features degrade with clear errors.
 */
import { createChatController } from '@/lib/chat-controller';
import { activeCivitaiTab, pageRequest } from '@/lib/page-bridge';
import { activeConversationIdStorage } from '@/lib/storage';
import type { ProposedAction } from '@/lib/page-tools';
import type { FormState, GeneratorImage } from '@/lib/types';
import { ChatPanel } from '@/entrypoints/civitai.content/chat-panel';
import { installDiagnosticCapture } from '@/lib/diagnostic-log';

installDiagnosticCapture('sidepanel');

type PageResult = { success: boolean; error: string | null };
const NOT_ON_CIVITAI: PageResult = {
  success: false,
  error: 'Open a CivitAI tab first — the chat can only act on civitai.com/civitai.red pages.',
};

// This panel belongs to ONE window. Every tab lookup is scoped to it — querying the
// globally last-focused window would make a panel in window B act on window A's tab.
const ownWindowId: Promise<number | undefined> = browser.windows
  .getCurrent()
  .then((w) => w.id)
  .catch(() => undefined);

async function boundCivitaiTab() {
  return activeCivitaiTab(await ownWindowId);
}

/** Run a page-bridge op against this window's active CivitAI tab, with a graceful fallback. */
async function withTab<T>(op: Parameters<typeof pageRequest>[1], args: Record<string, unknown>, fallback: T): Promise<T> {
  const tab = await boundCivitaiTab();
  if (!tab) return fallback;
  try {
    return await pageRequest<T>(tab.id, op, args);
  } catch {
    // No content script in the tab (e.g. opened before install) or the page is mid-navigation.
    return fallback;
  }
}

const controller = createChatController({
  catalogTool: async (name, args, token, signal) => {
    signal?.throwIfAborted();
    const tab = await boundCivitaiTab();
    if (!tab) return JSON.stringify({ error: 'Open a CivitAI tab to search its catalog using that site and session.' });
    try {
      return await pageRequest<string>(tab.id, 'catalogTool', { name, args, token }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return JSON.stringify({ error: `CivitAI catalog lookup failed on ${new URL(tab.url).origin}: ${error instanceof Error ? error.message : String(error)}. Refresh the CivitAI tab after reloading the extension.` });
    }
  },
  onGeneratePage: async () => {
    const route = await withTab<{ onGeneratePage: boolean } | null>('route', {}, null);
    return route?.onGeneratePage ?? false;
  },
  formState: async () => withTab<FormState | null>('formState', {}, null),
  pageContext: async () =>
    withTab<Record<string, unknown>>('pageContext', {}, {
      error: 'No CivitAI tab is active — page context unavailable.',
    }),
  pageImages: async (limit) => withTab<string[]>('pageImages', { limit }, []),
  generatorImages: async () => withTab<GeneratorImage[]>('generatorImages', {}, []),
  applyAction: async (action) => {
    const tab = await boundCivitaiTab();
    if (!tab) return NOT_ON_CIVITAI;
    try {
      return await pageRequest<PageResult>(tab.id, 'applyAction', { action });
    } catch {
      return {
        success: false,
        unknown: true,
        error:
          'Lost contact with the CivitAI tab — check the page, the change may or may not have applied.',
      };
    }
  },
});

const panel = new ChatPanel(document.getElementById('app')!, {
  docked: true,
  onSendMessage: controller.handleSendMessage,
  onStopMessage: controller.stop,
  onApplyToForm: controller.handleApplyAssistantMessage,
  onResolveAction: controller.handleResolveAction,
  onAnswerQuestion: controller.handleAnswerQuestion,
  onNewConversation: controller.handleNewConversation,
  onDeleteConversation: controller.handleDeleteConversation,
  onSelectConversation: async (id) => {
    // Setting the id is enough here: the activeConversationIdStorage watch below
    // clears and re-renders the transcript (abort first so isBusy doesn't gate it).
    controller.abort();
    await activeConversationIdStorage.setValue(id);
  },
  onTogglePanel: async () => {
    /* the browser owns the side panel's lifecycle */
  },
  onGrabPageImage: () => withTab<string | null>('openImageUrl', {}, null),
});

void controller.restoreConversation(panel);

// Cross-panel conversation sync: "New chat" or a conversation switch in another window's
// panel (shared storage) re-renders this one too — unless we're mid-stream here.
activeConversationIdStorage.watch(() => {
  if (controller.isBusy()) return;
  panel.clearTranscript();
  void controller.restoreConversation(panel);
});

/** Reflect the active tab's route in the panel (Apply buttons only make sense on /generate). */
async function syncRoute() {
  const route = await withTab<{ onGeneratePage: boolean } | null>('route', {}, null);
  panel.setOnGeneratePage(route?.onGeneratePage ?? false);
}
void syncRoute();
browser.tabs.onActivated.addListener((info) => {
  void ownWindowId.then((wid) => {
    if (wid === undefined || info.windowId === wid) void syncRoute();
  });
});
// CivitAI's Create drawer opens over any page without a URL change, so the content script
// pushes availability changes that no tab event would report.
browser.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'cllp:form-availability') void syncRoute();
});
browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!tab.active || !(changeInfo.url || changeInfo.status === 'complete')) return;
  void ownWindowId.then((wid) => {
    if (wid === undefined || tab.windowId === wid) void syncRoute();
  });
});
