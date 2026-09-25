import { registerFeedTagDbHost } from '@/lib/feed-tag-db-host';
import { registerLlmProxyHost } from '@/lib/llm-proxy';
import { registerConversationHost } from '@/lib/conversation-rpc';
import { migrateSettings } from '@/lib/settings-migrate';
import { registerCivitaiMcpHost } from '@/lib/civitai-mcp-rpc';
import {
  appendDiagnosticDirect,
  installDiagnosticCapture,
  registerDiagnosticLogHost,
} from '@/lib/diagnostic-log';

export default defineBackground(() => {
  // Day-to-day warnings/errors survive service-worker restarts in a bounded local journal.
  registerDiagnosticLogHost();
  installDiagnosticCapture('background', appendDiagnosticDirect);
  // One-shot storage migrations (e.g. roll un-customized system prompts forward).
  void migrateSettings();
  // Shared tag-corpus store + sync coordination (see lib/feed-tag-db-host.ts).
  registerFeedTagDbHost();
  // CORS-exempt LLM traffic for the chat panel (see lib/llm-proxy.ts).
  registerLlmProxyHost();
  // Serialized conversation writes so concurrent tabs can't clobber each other.
  registerConversationHost();
  // Fixed-endpoint CivitAI Site MCP traffic; reads/writes are classified in the controller.
  registerCivitaiMcpHost();

  // Icon clicks open the popup (manifest `default_popup`), which handles both the
  // panel toggle and the not-on-civitai state — no action listeners needed here.
  // NOTE: never `browser.action.disable()` — a disabled action can't open the popup,
  // which is the only path to Settings from a non-civitai tab.
});
