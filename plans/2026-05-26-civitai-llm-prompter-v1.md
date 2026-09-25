# CivitAI LLM Prompter - Chrome Extension

> **Status: historical initial design.** This first proposal predates the WXT extension now in
> the repository and is retained only as project history. Its unchecked tasks are not an active
> backlog. Use the [living LLM-assistant architecture and evaluation plan](./2026-07-31-llm-assistant-architecture-and-evaluation.md)
> and the current source tree as implementation authority.

## Objective

Build a Chrome-compatible browser extension (Manifest V3) that provides an in-browser LLM chat interface on CivitAI pages (`civitai.com` and `civitai.red`), allowing users to converse with LLMs via OpenAI-compatible endpoints (xAI and OpenRouter) and use the LLM's responses to fill out CivitAI's on-site image/video generation prompt fields. The extension acts as a bridge: you chat with an LLM about what you want to generate, and with one click, the LLM's output populates the CivitAI generation form.

## Research Findings Summary

### API Compatibility
- **xAI**: OpenAI-compatible endpoint at `https://api.x.ai/v1` (supports both Responses API and legacy Chat Completions). Models include `grok-4.3` (flagship), `grok-build-0.1` (coding).
- **OpenRouter**: OpenAI-compatible endpoint at `https://openrouter.ai/api/v1/chat/completions`. Supports hundreds of models. API key via `Authorization: Bearer <key>`. Optional headers: `HTTP-Referer`, `X-OpenRouter-Title`.
- Both use standard `Authorization: Bearer <API_KEY>` headers and the OpenAI chat completions format (`model`, `messages`, `temperature`, etc.).

### CivitAI Site Architecture
- Built with **Next.js** + **Mantine UI** framework (evidenced by `data-mantine-color-scheme` attributes, `__m__` CSS class prefixes).
- Uses **tRPC** for client-server communication (evidenced by `trpcState` in page props).
- The `/generate` page requires authentication (redirects to login).
- Two domains: `civitai.com` (green) and `civitai.red` (blue/red) - same app, different domains.
- Has a developer API at `developer.civitai.com` with Orchestration API for image/video generation.
- The on-site generation UI is a React SPA with Mantine components - form fields are React-controlled, requiring proper React state update techniques (not just DOM manipulation).

### CivitAI Generation UI Key Insight
- The generation form uses Mantine UI components (TextInput, Textarea, Select, Slider, etc.)
- Form fields are React-controlled via state management
- To reliably set values, we need to use `nativeInputValueSetter` or dispatch proper input/change events to trigger React's synthetic event system
- The prompt field is likely a `<textarea>` element within the generation panel
- CivitAI also supports "negative prompt", sampler selection, steps, CFG scale, dimensions, seed, and model/checkpoint selection

## Implementation Plan

### Phase 1: Project Scaffolding and Manifest

- [ ] **1.1** Create `manifest.json` (Manifest V3) with:
  - `name`: "CivitAI LLM Prompter"
  - `permissions`: `storage`, `activeTab`
  - `host_permissions`: `https://civitai.com/*`, `https://civitai.red/*`, `https://api.x.ai/*`, `https://openrouter.ai/*`
  - `content_scripts` targeting `civitai.com` and `civitai.red`
  - `action` pointing to popup HTML
  - `options_page` for settings
  - CSP allowing connections to LLM API endpoints

- [ ] **1.2** Create project directory structure:
  ```
  /
  ├── manifest.json
  ├── src/
  │   ├── background/          # Service worker
  │   │   └── service-worker.ts
  │   ├── content/             # Content script (injected into CivitAI)
  │   │   ├── index.ts
  │   │   ├── dom-bridge.ts    # DOM interaction with CivitAI generation form
  │   │   └── panel.ts         # Chat panel UI injection
  │   ├── popup/               # Extension popup
  │   │   ├── popup.html
  │   │   └── popup.ts
  │   ├── options/             # Settings page
  │   │   ├── options.html
  │   │   └── options.ts
  │   ├── lib/                 # Shared library code
  │   │   ├── api-client.ts    # OpenAI-compatible API client
  │   │   ├── storage.ts       # Chrome storage helpers
  │   │   ├── types.ts         # TypeScript type definitions
  │   │   └── constants.ts     # Shared constants
  │   └── styles/
  │       └── panel.css        # Chat panel styles
  ├── assets/
  │   └── icons/               # Extension icons (16, 32, 48, 128)
  ├── package.json
  ├── tsconfig.json
  └── webpack.config.js / vite.config.ts  # Build tooling
  ```

- [ ] **1.3** Set up build tooling (Vite or Webpack) with TypeScript support for Chrome extension development. Include hot-reload capability for development.

- [ ] **1.4** Create `package.json` with dev dependencies: TypeScript, build tool, and any UI library (consider vanilla CSS or a lightweight approach to avoid conflicts with CivitAI's Mantine styles).

### Phase 2: API Client and Storage Layer

- [ ] **2.1** Implement `src/lib/types.ts` with TypeScript interfaces for:
  - `ProviderConfig` (provider type, API key, base URL, default model)
  - `ChatMessage` (role, content, timestamp)
  - `Conversation` (id, messages, metadata)
  - `GenerationPrompt` (positive prompt, negative prompt, parameters)
  - `ExtensionSettings` (providers, active provider, system prompt, temperature, max tokens)

- [ ] **2.2** Implement `src/lib/storage.ts` using `chrome.storage.sync` for settings and `chrome.storage.local` for conversation history. Include:
  - `getSettings()` / `saveSettings()`
  - `getConversations()` / `saveConversation()`
  - `getActiveProvider()`

- [ ] **2.3** Implement `src/lib/api-client.ts` - a unified OpenAI-compatible chat completions client:
  - Support configurable `baseURL` (defaults per provider: xAI = `https://api.x.ai/v1`, OpenRouter = `https://openrouter.ai/api/v1`)
  - Standard `POST /chat/completions` with `Authorization: Bearer <key>`
  - Streaming support via SSE (`stream: true`) for real-time token display
  - OpenRouter-specific headers (`HTTP-Referer`, `X-OpenRouter-Title`)
  - Error handling with retry logic
  - Abort controller support for cancelling requests

- [ ] **2.4** Implement `src/lib/constants.ts` with:
  - Provider definitions (xAI, OpenRouter) with default base URLs
  - Default system prompt for image generation assistance
  - CSS selectors for CivitAI DOM elements (to be refined during implementation)
  - Default models list per provider

### Phase 3: Settings/Options Page

- [ ] **3.1** Build `src/options/options.html` and `src/options/options.ts` with:
  - API key input fields for xAI and OpenRouter (masked/password type)
  - Provider selector (xAI / OpenRouter / Custom)
  - Custom base URL field (for any OpenAI-compatible endpoint)
  - Model selection dropdown (with option to type custom model ID)
  - Temperature slider (0-2)
  - Max tokens input
  - System prompt textarea (default: expert Stable Diffusion / Flux prompt crafter)
  - Save/clear buttons with confirmation feedback

- [ ] **3.2** Add connection test button that sends a simple ping/completion to verify API key works.

### Phase 4: Content Script - Chat Panel UI

- [ ] **4.1** Implement `src/content/panel.ts` - inject a floating/dockable chat panel into CivitAI pages:
  - Panel should be a collapsible sidebar or floating window on the right side of the page
  - Toggle button injected into the CivitAI page (fixed position)
  - Chat UI with message bubbles (user messages right-aligned, assistant left-aligned)
  - Input textarea with send button (Enter to send, Shift+Enter for newline)
  - Streaming text display as tokens arrive
  - "Apply to Form" button on each assistant message
  - Dark/light theme matching CivitAI's current theme (read `data-mantine-color-scheme` attribute)
  - Minimize/close controls
  - Draggable/resizable panel

- [ ] **4.2** Implement `src/styles/panel.css` with scoped styles (use unique prefix like `cllp-` for all CSS classes to avoid conflicts with CivitAI's Mantine styles). Use Shadow DOM isolation if feasible.

- [ ] **4.3** Implement conversation management:
  - New conversation button
  - Conversation history dropdown
  - Clear conversation
  - Auto-save conversations to chrome.storage.local

### Phase 5: Content Script - DOM Bridge (CivitAI Form Interaction)

- [ ] **5.1** Implement `src/content/dom-bridge.ts` - the critical bridge between LLM output and CivitAI's generation form:
  - **DOM Discovery**: Use MutationObserver to detect when the generation form is present on the page. The generation UI is loaded dynamically (SPA), so we need to watch for it.
  - **Prompt Field Detection**: Locate the positive prompt textarea and negative prompt textarea in CivitAI's generation form. These will be Mantine `Textarea` components rendered as `<textarea>` elements.
  - **Value Injection**: Use the `nativeInputValueSetter` trick to set React-controlled input values:
    ```
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(element, newValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    ```
  - **Parameter Detection and Setting**: Attempt to detect and set generation parameters (steps, CFG scale, sampler, dimensions, seed) if the LLM output includes structured parameter suggestions.
  - **Form State Reading**: Read current prompt/parameter values from the form to provide context to the LLM about what's already configured.

- [ ] **5.2** Implement smart prompt parsing from LLM responses:
  - Parse the LLM's response to extract the positive prompt text
  - Optionally extract negative prompt (if the LLM provides one in a structured format)
  - Support markdown code blocks, structured output, or plain text formats
  - Handle cases where LLM output includes explanation text alongside the actual prompt
  - Provide a structured system prompt that instructs the LLM to output prompts in a parseable format (e.g., using XML tags like `<prompt>...</prompt>` and `<negative>...</negative>`)

- [ ] **5.3** Implement the "Apply to Form" action:
  - Parse the selected assistant message
  - Extract positive/negative prompts
  - Inject into the CivitAI generation form fields
  - Visual confirmation (brief highlight animation on the updated fields)
  - Option to append to existing prompt vs. replace

### Phase 6: Background Service Worker

- [ ] **6.1** Implement `src/background/service-worker.ts`:
  - Message routing between popup, content script, and options page
  - API request proxy (alternative approach: make API calls from the content script directly using the host_permissions)
  - Extension icon state management (active/inactive based on whether we're on a CivitAI page)
  - Context menu entries (optional: right-click to send selected text to chat)

### Phase 7: Extension Popup

- [ ] **7.1** Build `src/popup/popup.html` and `src/popup/popup.ts`:
  - Quick status display (connected to CivitAI? API key configured?)
  - Toggle chat panel visibility
  - Quick provider/model switcher
  - Link to settings page
  - Current conversation summary

### Phase 8: System Prompt Engineering

- [ ] **8.1** Design a default system prompt that instructs the LLM to:
  - Act as an expert AI image/video generation prompt crafter
  - Understand CivitAI's ecosystem (Stable Diffusion, SDXL, Flux, etc.)
  - Output prompts in a structured, parseable format
  - Include positive prompt, optional negative prompt, and suggested parameters
  - Be conversational and helpful, explaining prompt choices
  - Understand booru-style tagging, natural language prompts, and model-specific syntax

- [ ] **8.2** Create prompt templates for common workflows:
  - "Describe what you want" -> full prompt generation
  - "Refine this prompt" -> iterative improvement
  - "Style transfer" -> adapt a prompt to a different style
  - "Parameter suggestion" -> recommend generation settings

### Phase 9: Polish and Edge Cases

- [ ] **9.1** Handle CivitAI's SPA navigation (the page doesn't fully reload when navigating between routes). Use `chrome.tabs.onUpdated` or a MutationObserver to detect URL changes and re-inject/re-initialize the panel as needed.

- [ ] **9.2** Handle both `civitai.com` and `civitai.red` domains identically (same content script, same DOM structure expected).

- [ ] **9.3** Implement error handling and user feedback:
  - API key missing/invalid -> clear error message with link to settings
  - Rate limiting -> display retry countdown
  - Network errors -> graceful degradation
  - DOM element not found -> "Navigate to the Generate page first" message

- [ ] **9.4** Add keyboard shortcuts:
  - Toggle panel visibility (configurable)
  - Send message (Enter)
  - Apply last response to form (Ctrl+Shift+A or similar)

- [ ] **9.5** Performance optimization:
  - Lazy-load the chat panel
  - Debounce DOM observations
  - Limit conversation history stored in memory

## Verification Criteria

- [ ] Extension installs successfully in Chrome and shows up in the extensions list
- [ ] Chat panel appears on both `civitai.com` and `civitai.red` pages
- [ ] API keys can be configured in settings and are persisted across sessions
- [ ] Chat messages are sent to the selected LLM provider and streaming responses display correctly
- [ ] "Apply to Form" button successfully populates the positive prompt field on CivitAI's generation page
- [ ] Panel theme matches CivitAI's dark/light mode
- [ ] Panel persists across SPA navigation within CivitAI
- [ ] Conversations are saved and can be resumed

## Potential Risks and Mitigations

1. **CivitAI DOM Structure Changes**
   - Risk: CivitAI updates their UI, breaking CSS selectors and DOM interaction code
   - Mitigation: Use multiple fallback selector strategies; implement a selector configuration that can be updated without a full extension update; use semantic selectors over brittle structural ones; use MutationObserver with flexible matching

2. **React Controlled Input Value Setting**
   - Risk: React's synthetic event system may not pick up programmatic value changes, causing the form to not recognize the injected prompt
   - Mitigation: Use the `nativeInputValueSetter` technique with proper event dispatching; test thoroughly; fall back to simulating keyboard events if needed; consider using `execCommand('insertText')` as alternative

3. **CSP (Content Security Policy) Restrictions**
   - Risk: CivitAI's CSP may block the content script from making external API calls or injecting styles
   - Mitigation: Chrome extensions' content scripts are generally exempt from page CSP for API calls made via `chrome.runtime.sendMessage` -> background fetch; use Shadow DOM for style isolation; test on both domains

4. **API Key Security**
   - Risk: API keys stored in `chrome.storage.sync` could be accessed by other extensions or compromised
   - Mitigation: Use `chrome.storage.local` (not synced); never expose keys in the DOM; consider encrypting keys at rest; warn users about risks in the settings UI

5. **CivitAI Authentication Requirement**
   - Risk: The `/generate` page requires login; the extension can't interact with a form that isn't rendered
   - Mitigation: Detect login state and show appropriate messaging; the extension only works when the user is logged in and on the generation page

6. **Streaming SSE in Content Scripts**
   - Risk: Content scripts may have limitations with SSE/fetch streaming
   - Mitigation: Route streaming requests through the background service worker; or use direct `fetch()` with `ReadableStream` in the content script (generally works in MV3)

7. **Extension Store Review**
   - Risk: Chrome Web Store may reject the extension for various policy reasons
   - Mitigation: Follow Chrome extension best practices; minimal permissions; clear privacy policy; no remote code execution; consider initial distribution via "developer mode" loading

## Alternative Approaches

1. **Side Panel API instead of Content Script Injection**
   - Chrome's Side Panel API (`chrome.sidePanel`) provides a native sidebar for extensions
   - Trade-off: Cleaner integration, no DOM injection needed, but less flexible positioning and may not feel as integrated with the CivitAI page
   - Consider as a future enhancement or alternative mode

2. **CivitAI Orchestration API instead of DOM manipulation**
   - Use CivitAI's Orchestration API (`orchestration.civitai.com`) to generate images directly via API, bypassing the on-site generation form entirely
   - Trade-off: More powerful (full API control), but requires CivitAI API key, costs Buzz, and doesn't use the familiar on-site UI
   - Could be offered as an advanced mode alongside the DOM-based approach

3. **Bookmarklet approach**
   - Instead of a full extension, use a bookmarklet that injects the chat UI
   - Trade-off: Simpler distribution, no store review needed, but loses persistence, storage API, and background service worker capabilities
   - Not recommended for this use case due to complexity of the chat interface

4. **Use existing LLM chat extensions (e.g., "UseChatGPT", "Sider", "Monica")**
   - Several browser extensions already provide in-page LLM chat
   - Trade-off: Would need to add CivitAI-specific DOM manipulation on top of them; less control; may not support the specific providers wanted
   - Not recommended as the primary approach, but could inform UI design patterns

## Architecture Decision Records

### ADR-1: Vanilla TS + CSS vs. Framework
**Decision**: Use vanilla TypeScript with hand-rolled UI (no React/Vue/etc.)
**Rationale**: Content scripts run in a constrained environment; bundling a framework adds size and complexity; the chat panel UI is relatively simple; avoids conflicts with CivitAI's own React/Mantine setup.

### ADR-2: Shadow DOM for Style Isolation
**Decision**: Use Shadow DOM for the injected chat panel
**Rationale**: CivitAI uses Mantine with global CSS class names that could conflict with our styles. Shadow DOM provides perfect style isolation.

### ADR-3: Direct API calls from content script vs. proxied through background
**Decision**: Make API calls directly from the content script using `fetch()` with streaming
**Rationale**: Simpler architecture; MV3 content scripts can make cross-origin requests when the host is listed in `host_permissions`; avoids message-passing overhead for streaming responses.

### ADR-4: Prompt parsing strategy
**Decision**: Use a structured output format with XML-like tags in the system prompt
**Rationale**: More reliable than trying to parse freeform text; LLMs handle XML-style delimiters well; allows extracting positive prompt, negative prompt, and parameters from a single response.

## Dependencies

- **Build**: TypeScript 5.x, Vite or Webpack 5
- **Runtime**: Chrome 116+ (for Manifest V3 features)
- **External APIs**: xAI API (`api.x.ai/v1`), OpenRouter API (`openrouter.ai/api/v1`)
- **No npm runtime dependencies** - vanilla TS/CSS approach keeps the extension lightweight
