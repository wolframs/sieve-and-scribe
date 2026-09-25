import { settingsStorage, activeConversationIdStorage, getConversation } from '@/lib/storage';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from '@/lib/constants';
import { sendTestMessage } from '@/lib/api-client';
import { wireModelSelect } from '@/lib/model-select-ui';
import { refreshModelCatalog } from '@/lib/model-catalog';
import type { ExtensionSettings } from '@/lib/types';
import {
  buildDiagnosticExport,
  buildChatDebugExport,
  diagnosticLogStorage,
  installDiagnosticCapture,
  lastDiagnosticExportStorage,
} from '@/lib/diagnostic-log';

installDiagnosticCapture('options');

// Elements
const xaiApiKey = document.getElementById('xaiApiKey') as HTMLInputElement;
const openrouterApiKey = document.getElementById('openrouterApiKey') as HTMLInputElement;
const xaiModel = document.getElementById('xaiModel') as HTMLSelectElement;
const openrouterModel = document.getElementById('openrouterModel') as HTMLSelectElement;
const xaiTestBtn = document.getElementById('xaiTestBtn') as HTMLButtonElement;
const openrouterTestBtn = document.getElementById('openrouterTestBtn') as HTMLButtonElement;
const xaiTestResult = document.getElementById('xaiTestResult') as HTMLDivElement;
const openrouterTestResult = document.getElementById('openrouterTestResult') as HTMLDivElement;
const activeRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="activeProvider"]')
);
const xaiCard = document.getElementById('xaiCard')!;
const openrouterCard = document.getElementById('openrouterCard')!;
const temperature = document.getElementById('temperature') as HTMLInputElement;
const tempValue = document.getElementById('tempValue')!;
const maxTokens = document.getElementById('maxTokens') as HTMLInputElement;
const rollingContext = document.getElementById('rollingContext') as HTMLInputElement;
const contextTurns = document.getElementById('contextTurns') as HTMLInputElement;
const systemPrompt = document.getElementById('systemPrompt') as HTMLTextAreaElement;
const promptCharCount = document.getElementById('promptCharCount')!;
const restorePromptBtn = document.getElementById('restorePromptBtn') as HTMLButtonElement;
const civitaiApiToken = document.getElementById('civitaiApiToken') as HTMLInputElement;
const civitaiMcpMode = document.getElementById('civitaiMcpMode') as HTMLSelectElement;
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const savedIndicator = document.getElementById('savedIndicator')!;
const diagnosticCount = document.getElementById('diagnosticCount')!;
const diagnosticResult = document.getElementById('diagnosticResult')!;
const openLogDirectoryBtn = document.getElementById('openLogDirectoryBtn') as HTMLButtonElement;
const exportLogsBtn = document.getElementById('exportLogsBtn') as HTMLButtonElement;
const exportChatDebugBtn = document.getElementById('exportChatDebugBtn') as HTMLButtonElement;
const debugMode = document.getElementById('debugMode') as HTMLInputElement;

function getActiveProviderId(): string {
  return activeRadios.find((r) => r.checked)?.value ?? 'xai';
}
function setActiveProvider(id: string) {
  activeRadios.forEach((r) => (r.checked = r.value === id));
  updateActiveCards();
}
function updateActiveCards() {
  const id = getActiveProviderId();
  xaiCard.classList.toggle('active', id === 'xai');
  openrouterCard.classList.toggle('active', id === 'openrouter');
}
function updateCharCount() {
  promptCharCount.textContent = `${systemPrompt.value.length.toLocaleString()} chars`;
}

function showDiagnosticResult(message: string, state: 'neutral' | 'success' | 'error' = 'neutral') {
  diagnosticResult.textContent = message;
  diagnosticResult.className = `diagnostic-result${state === 'neutral' ? '' : ` ${state}`}`;
}

function updateDiagnosticCount(count: number) {
  diagnosticCount.textContent = `${count.toLocaleString()} / 250 entries`;
}

async function requestDownloadsPermission(): Promise<boolean> {
  // Called directly from the click handler so Chrome still sees the user gesture.
  return browser.permissions.request({ permissions: ['downloads'] });
}

async function exportDiagnostics(includeChat = false) {
  exportLogsBtn.disabled = true;
  exportChatDebugBtn.disabled = true;
  try {
    if (!(await requestDownloadsPermission())) {
      showDiagnosticResult('Downloads permission was not granted, so no log file was created.', 'error');
      return;
    }
    const journal = await diagnosticLogStorage.getValue();
    const metadata = {
      extensionVersion: browser.runtime.getManifest().version,
      userAgent: navigator.userAgent,
    };
    const activeId = includeChat ? await activeConversationIdStorage.getValue() : null;
    const conversation = activeId ? await getConversation(activeId) : null;
    if (includeChat && !conversation) {
      showDiagnosticResult('Select a saved chat in the chat panel before exporting it.', 'error');
      return;
    }
    const payload = conversation
      ? buildChatDebugExport(conversation, journal, metadata)
      : buildDiagnosticExport(journal, metadata);
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const blobUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const downloadId = await browser.downloads.download({
        url: blobUrl,
        filename: `Sieve & Scribe Logs/cllp-${includeChat ? 'chat-debug' : 'diagnostics'}-${stamp}.json`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      await lastDiagnosticExportStorage.setValue(downloadId);
      showDiagnosticResult(
        `Exported ${includeChat ? 'active chat and ' : ''}${journal.entries.length.toLocaleString()} log entries to Downloads/Sieve & Scribe Logs.`,
        'success'
      );
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (error) {
    showDiagnosticResult(
      `Could not export logs: ${error instanceof Error ? error.message : String(error)}`,
      'error'
    );
  } finally {
    exportLogsBtn.disabled = false;
    exportChatDebugBtn.disabled = false;
  }
}

async function openLogDirectory() {
  openLogDirectoryBtn.disabled = true;
  try {
    if (!(await requestDownloadsPermission())) {
      showDiagnosticResult('Downloads permission was not granted, so the folder cannot be opened.', 'error');
      return;
    }
    const downloadsApi = browser.downloads as typeof browser.downloads & {
      show?: (downloadId: number) => boolean | void | Promise<boolean | void>;
      showDefaultFolder?: () => void | Promise<void>;
    };
    const lastDownloadId = await lastDiagnosticExportStorage.getValue();
    const hasLastDownload = lastDownloadId !== null &&
      (await browser.downloads.search({ id: lastDownloadId })).length > 0;
    if (hasLastDownload && lastDownloadId !== null && downloadsApi.show) {
      const shown = await Promise.resolve(
        (downloadsApi.show as (downloadId: number) => boolean | void | Promise<boolean | void>)(lastDownloadId)
      );
      if (shown !== false) {
        showDiagnosticResult('Opened the folder containing the most recent diagnostic export.', 'success');
        return;
      }
    }
    if (!downloadsApi.showDefaultFolder) throw new Error('this browser cannot open the Downloads folder');
    await Promise.resolve(downloadsApi.showDefaultFolder());
    showDiagnosticResult(
      'Opened Downloads. Export once to create the Sieve & Scribe Logs subfolder.',
      'success'
    );
  } catch (error) {
    showDiagnosticResult(
      `Could not open the log directory: ${error instanceof Error ? error.message : String(error)}`,
      'error'
    );
  } finally {
    openLogDirectoryBtn.disabled = false;
  }
}

// Model selects share the chat picker's live-catalog wiring (favorites, search,
// custom entry, refresh). Commits arrive with select.value already set, so
// saveSettings can read the selects directly.
const xaiModelPicker = wireModelSelect(xaiModel, () => 'xai', saveSettings);
const openrouterModelPicker = wireModelSelect(openrouterModel, () => 'openrouter', saveSettings);

// Previous key values, to force a catalog refetch when a key is added/changed
// (the xAI model list needs a key to fetch at all).
const prevKeys: Record<string, string> = { xai: '', openrouter: '' };

// Load settings
async function loadSettings() {
  const settings = await settingsStorage.getValue();

  xaiApiKey.value = settings.providers.xai?.apiKey ?? '';
  openrouterApiKey.value = settings.providers.openrouter?.apiKey ?? '';
  prevKeys.xai = xaiApiKey.value;
  prevKeys.openrouter = openrouterApiKey.value;

  await Promise.all([xaiModelPicker.refresh(), openrouterModelPicker.refresh()]);

  setActiveProvider(settings.activeProviderId);
  temperature.value = String(settings.temperature);
  tempValue.textContent = String(settings.temperature);
  maxTokens.value = String(settings.maxTokens);
  rollingContext.checked = settings.rollingContext ?? true;
  contextTurns.value = String(settings.contextTurns ?? 20);
  debugMode.checked = settings.debugMode ?? false;
  systemPrompt.value = settings.systemPrompt;
  updateCharCount();
  civitaiApiToken.value = settings.civitaiApiToken ?? '';
  civitaiMcpMode.value = settings.civitaiMcpMode
    ?? (settings.civitaiToolsEnabled === false ? 'off' : 'read');
}

// Save settings
async function saveSettings() {
  const settings: ExtensionSettings = {
    providers: {
      xai: {
        type: 'xai',
        apiKey: xaiApiKey.value.trim(),
        baseURL: PROVIDER_DEFAULTS.xai.baseURL,
        defaultModel: xaiModel.value === '__custom__' ? '' : xaiModel.value,
      },
      openrouter: {
        type: 'openrouter',
        apiKey: openrouterApiKey.value.trim(),
        baseURL: PROVIDER_DEFAULTS.openrouter.baseURL,
        defaultModel: openrouterModel.value === '__custom__' ? '' : openrouterModel.value,
      },
    },
    activeProviderId: getActiveProviderId(),
    systemPrompt: systemPrompt.value,
    temperature: parseFloat(temperature.value),
    // A cleared/invalid number input yields NaN, which would serialize to null in
    // storage and in request bodies — fall back to the default instead.
    maxTokens: Number.parseInt(maxTokens.value, 10) > 0
      ? Number.parseInt(maxTokens.value, 10)
      : DEFAULT_SETTINGS.maxTokens,
    civitaiApiToken: civitaiApiToken.value.trim(),
    civitaiMcpMode: civitaiMcpMode.value as ExtensionSettings['civitaiMcpMode'],
    rollingContext: rollingContext.checked,
    debugMode: debugMode.checked,
    contextTurns: Number.parseInt(contextTurns.value, 10) >= 2
      ? Math.min(100, Number.parseInt(contextTurns.value, 10))
      : 20,
  };

  await settingsStorage.setValue(settings);

  // A new/changed key can unlock a catalog fetch (xAI's list is authed) — refetch.
  for (const id of ['xai', 'openrouter'] as const) {
    const key = settings.providers[id].apiKey;
    if (key !== prevKeys[id]) {
      prevKeys[id] = key;
      if (key) void refreshModelCatalog(id, true); // catalog watch repopulates the selects
    }
  }

  savedIndicator.classList.add('show');
  setTimeout(() => savedIndicator.classList.remove('show'), 2000);
}

// Test connection
async function testConnection(
  providerId: string,
  apiKey: string,
  model: string,
  resultEl: HTMLDivElement,
  btn: HTMLButtonElement,
) {
  if (!apiKey.trim()) {
    showResult(resultEl, false, 'Please enter an API key first.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Testing...';
  resultEl.style.display = 'none';

  const result = await sendTestMessage({
    type: providerId as 'xai' | 'openrouter',
    apiKey: apiKey.trim(),
    baseURL: PROVIDER_DEFAULTS[providerId]?.baseURL ?? '',
    defaultModel: model,
  }, model);

  btn.disabled = false;
  btn.textContent = 'Test connection';
  showResult(resultEl, result.success, result.message);
}

function showResult(el: HTMLDivElement, success: boolean, message: string) {
  el.textContent = message;
  el.className = `status-msg ${success ? 'status-success' : 'status-error'}`;
  el.style.display = 'block';
}

// Event listeners
temperature.addEventListener('input', () => {
  tempValue.textContent = temperature.value;
});

systemPrompt.addEventListener('input', updateCharCount);

// Active-provider radio cards
activeRadios.forEach((r) =>
  r.addEventListener('change', () => {
    updateActiveCards();
    saveSettings();
  })
);

// Restore the default system prompt (gets the latest knowledge + tool capabilities back)
restorePromptBtn.addEventListener('click', () => {
  systemPrompt.value = DEFAULT_SETTINGS.systemPrompt;
  updateCharCount();
  saveSettings();
});

// Password toggles
document.querySelectorAll('.password-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = (btn as HTMLElement).getAttribute('data-target')!;
    const input = document.getElementById(targetId) as HTMLInputElement;
    if (input.type === 'password') {
      input.type = 'text';
      (btn as HTMLElement).textContent = 'Hide';
    } else {
      input.type = 'password';
      (btn as HTMLElement).textContent = 'Show';
    }
  });
});

xaiTestBtn.addEventListener('click', () => {
  testConnection('xai', xaiApiKey.value, xaiModel.value, xaiTestResult, xaiTestBtn);
});

openrouterTestBtn.addEventListener('click', () => {
  testConnection('openrouter', openrouterApiKey.value, openrouterModel.value, openrouterTestResult, openrouterTestBtn);
});

saveBtn.addEventListener('click', saveSettings);
exportLogsBtn.addEventListener('click', () => void exportDiagnostics());
exportChatDebugBtn.addEventListener('click', () => void exportDiagnostics(true));
openLogDirectoryBtn.addEventListener('click', () => void openLogDirectory());

resetBtn.addEventListener('click', async () => {
  if (confirm('Reset all settings to defaults?')) {
    await settingsStorage.setValue(DEFAULT_SETTINGS);
    await loadSettings();
  }
});

// Auto-save on change. Model selects are NOT here — their wireModelSelect handles
// commit via saveSettings themselves (and specials like "Custom…" must never save).
[xaiApiKey, openrouterApiKey, temperature, maxTokens, rollingContext, contextTurns, systemPrompt, civitaiApiToken, civitaiMcpMode, debugMode].forEach((el) => {
  el.addEventListener('change', saveSettings);
});

// Initialize
loadSettings();
void diagnosticLogStorage.getValue().then((journal) => updateDiagnosticCount(journal.entries.length));
diagnosticLogStorage.watch((journal) => updateDiagnosticCount(journal?.entries.length ?? 0));
