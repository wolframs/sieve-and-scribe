import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Sieve & Scribe for Civitai',
    // Chrome truncates the toolbar/launcher label; short_name carries the product name alone.
    short_name: 'Sieve & Scribe',
    description: 'Chat with LLMs on CivitAI to craft image/video generation prompts',
    // WXT reads the extension version from package.json. Keep one source of truth so a
    // package version bump cannot silently produce an older manifest.
    // sidePanel.open() exists since Chrome 116; without a floor the popup button dies silently.
    minimum_chrome_version: '116',
    // `unlimitedStorage`: attached image data URLs can be large; keep saved conversations off the
    // default chrome.storage.local quota.
    permissions: ['storage', 'activeTab', 'unlimitedStorage', 'sidePanel'],
    // Requested only when the user exports/opens diagnostics, avoiding a broad install warning.
    optional_permissions: ['downloads'],
    host_permissions: [
      'https://civitai.com/*',
      'https://civitai.red/*',
      'https://mcp.civitai.com/*',
      'https://api.x.ai/*',
      'https://openrouter.ai/*',
    ],
  },
  hooks: {
    // Open settings in a full browser tab — it's an operator console, not a cramped popup.
    // (WXT generates options_ui itself, so set open_in_tab after generation.)
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.options_ui) manifest.options_ui.open_in_tab = true;
    },
  },
});
