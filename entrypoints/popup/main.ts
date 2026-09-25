import { settingsStorage } from '@/lib/storage';
import { PROVIDER_DEFAULTS } from '@/lib/constants';
import { setActiveModel } from '@/lib/model-choice';
import { wireModelSelect } from '@/lib/model-select-ui';
import { installDiagnosticCapture } from '@/lib/diagnostic-log';

installDiagnosticCapture('popup');

const pageStatus = document.getElementById('pageStatus')!;
const pageStatusText = document.getElementById('pageStatusText')!;
const providerName = document.getElementById('providerName')!;
const keyStatus = document.getElementById('keyStatus')!;
const keyStatusText = document.getElementById('keyStatusText')!;
const providerSelect = document.getElementById('providerSelect') as HTMLSelectElement;
const modelSelect = document.getElementById('modelSelect') as HTMLSelectElement;
const togglePanelBtn = document.getElementById('togglePanelBtn')!;
const settingsBtn = document.getElementById('settingsBtn')!;

const PROVIDER_DISPLAY: Record<string, string> = { xai: 'xAI', openrouter: 'OpenRouter', custom: 'Custom' };
const displayName = (id: string) => PROVIDER_DISPLAY[id] ?? id;

// Cached at init so the Open Chat click can call sidePanel.open() SYNCHRONOUSLY —
// a tabs.query hop inside the click handler can lose the user gesture and get rejected.
let currentWindowId: number | undefined;

// The model select mirrors the chat header picker: live catalog, favorites,
// search, custom entry. (window.prompt is a no-op in extension popups, so the
// old prompt()-based custom entry never worked here.)
const modelPicker = wireModelSelect(
  modelSelect,
  () => providerSelect.value,
  (model) => setActiveModel(model),
  'model-inline'
);

async function init() {
  // Check if we're on a CivitAI page
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentWindowId = tab?.windowId;
  const url = tab?.url ?? '';
  const isCivitai = url.includes('civitai.com') || url.includes('civitai.red');

  pageStatus.className = `status-dot ${isCivitai ? 'active' : 'inactive'}`;
  pageStatusText.textContent = isCivitai ? 'Connected' : 'Not on CivitAI';

  // Load settings
  const settings = await settingsStorage.getValue();

  // Populate provider select
  providerSelect.innerHTML = '';
  for (const id of Object.keys(PROVIDER_DEFAULTS)) {
    if (id === 'custom') continue;
    const option = document.createElement('option');
    option.value = id;
    option.textContent = displayName(id);
    option.selected = id === settings.activeProviderId;
    providerSelect.appendChild(option);
  }

  // Update provider status
  const activeProvider = settings.providers[settings.activeProviderId];
  providerName.textContent = displayName(settings.activeProviderId);

  const hasKey = !!activeProvider?.apiKey;
  keyStatus.className = `status-dot ${hasKey ? 'active' : 'inactive'}`;
  keyStatusText.textContent = hasKey ? 'Configured' : 'Missing';

  await modelPicker.refresh();
}

// Event listeners
providerSelect.addEventListener('change', async () => {
  const providerId = providerSelect.value;
  const settings = await settingsStorage.getValue();
  settings.activeProviderId = providerId;

  if (!settings.providers[providerId]) {
    const defaults = PROVIDER_DEFAULTS[providerId];
    settings.providers[providerId] = {
      type: providerId as 'xai' | 'openrouter',
      apiKey: '',
      baseURL: defaults.baseURL,
      defaultModel: defaults.defaultModel,
    };
  }

  await settingsStorage.setValue(settings);
  await modelPicker.refresh();

  // Refresh display
  providerName.textContent = displayName(providerId);
  const hasKey = !!settings.providers[providerId]?.apiKey;
  keyStatus.className = `status-dot ${hasKey ? 'active' : 'inactive'}`;
  keyStatusText.textContent = hasKey ? 'Configured' : 'Missing';
});

// Open the chat in Chrome's side panel (the primary surface; the in-page overlay is legacy).
// MUST call open() synchronously in the click handler — any promise hop can drop the user
// gesture and Chrome rejects the call. windowId (cached at init) scopes the global panel.
togglePanelBtn.addEventListener('click', () => {
  const sidePanel = (browser as any).sidePanel ?? (globalThis as any).chrome?.sidePanel;
  if (!sidePanel?.open || currentWindowId === undefined) {
    pageStatusText.textContent = 'Side panel unavailable (needs Chrome 116+).';
    return;
  }
  Promise.resolve(sidePanel.open({ windowId: currentWindowId })).then(
    () => window.close(),
    (err: unknown) => {
      pageStatusText.textContent = `Could not open side panel: ${err instanceof Error ? err.message : err}`;
    }
  );
});

settingsBtn.addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init();
