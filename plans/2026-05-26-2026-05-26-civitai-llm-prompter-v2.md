# CivitAI LLM Prompter - Chrome Extension (v2 - Updated Plan)

> **Status: historical initial design.** This point-in-time proposal is retained for
> architectural context, but its implementation details and task list are no longer current.
> Use the [living LLM-assistant architecture and evaluation plan](./2026-07-31-llm-assistant-architecture-and-evaluation.md)
> and the current source tree as implementation authority.

## Objective

Build a Chrome-compatible browser extension (Manifest V3) that provides an in-browser LLM chat interface on CivitAI pages (`civitai.com` and `civitai.red`), allowing users to converse with LLMs via OpenAI-compatible endpoints (xAI and OpenRouter) and use the LLM's responses to fill out CivitAI's on-site image/video generation prompt fields. The extension acts as a bridge: you chat with an LLM about what you want to generate, and with one click, the LLM's output populates the CivitAI generation form.

## Research Findings Summary

### API Compatibility
- **xAI**: OpenAI-compatible endpoint at `https://api.x.ai/v1`. Models include `grok-4.3` (flagship).
- **OpenRouter**: OpenAI-compatible endpoint at `https://openrouter.ai/api/v1/chat/completions`. Hundreds of models. Optional headers: `HTTP-Referer`, `X-OpenRouter-Title`.
- Both use standard `Authorization: Bearer <API_KEY>` headers and OpenAI chat completions format.

### CivitAI Site Architecture (from source code analysis)
- Built with **Next.js** + **Mantine UI** + **tRPC** + **Zustand** stores
- The `/generate` page renders a sidebar containing the `GenerationForm` component
- Two domains: `civitai.com` and `civitai.red` - same app, different domains
- The generation form requires authentication

### CivitAI Generation Form - Precise DOM Structure (from GitHub source)

**Component Tree:**
```
GeneratePage (src/pages/generate/index.tsx)
  └─ AppLayout
       └─ <aside> (right sidebar)
            └─ GenerationForm
                 ├─ GenerationErrorBoundary
                 ├─ GenerationProvider
                 ├─ SegmentedControl (Image/Video toggle)
                 ├─ GenerationFormProvider (react-hook-form + zod)
                 │    └─ TextToImageWhatIfProvider
                 │         └─ GenerationFormContent (GenerationForm2.tsx)
                 │              └─ StepProvider
                 │                   └─ GenForm (react-hook-form <Form>)
                 │                        └─ [ALL FORM FIELDS]
                 └─ VideoGenerationProvider (for video tab)
```

**Prompt Fields:**
- **Positive prompt**: `InputPrompt` component wrapping Mantine `Textarea`, controlled by react-hook-form
- **Negative prompt**: Same `InputPrompt` component, conditionally hidden for Flux/SD3 models
- Both use the `withController` HOC which auto-generates `id="input_{name}"`

**Key Selectors:**

| Target | Selector | Notes |
|---|---|---|
| Positive prompt | `#input_prompt` or `textarea[name="prompt"]` | Mantine Textarea, react-hook-form controlled |
| Negative prompt | `#input_negativePrompt` | Conditionally rendered |
| Positive prompt (alt) | `[data-tour="gen:prompt"]` | Tour attribute on wrapper |
| Submit button | `[data-tour="gen:submit"]` | Generate button |
| CFG Scale | `[data-testid="gen-cfg-scale"]` | InputNumberSlider |
| Steps | `[data-testid="gen-steps"]` | InputNumberSlider |
| Seed field | `#input_seed` | SegmentedControl + NumberInput |
| Sampler | `#input_sampler` | Select dropdown |
| Aspect ratio | `#input_aspectRatio` | SegmentedControl |
| Clip skip | `#input_clipSkip` | InputNumberSlider |
| Any form field | `#input_{fieldName}` | Universal pattern from `withController` |

**Form Persistence:**
- Form state persisted to `localStorage` under key `generation-form-2`
- Prompt/negativePrompt stored separately in `generation:prompt` / `generation:negativePrompt`
- This means we can also set prompts via `localStorage` as a fallback

**Dual Form System:**
- Legacy form (`GenerationForm2`): Uses Mantine `Textarea` for prompts - **this is what currently renders on `/generate`**
- Newer data-graph form (`generation_v2`): Uses Tiptap/ProseMirror rich text editors with `.tiptap-textarea-shell` and `.ProseMirror` classes
- Our extension should target the **legacy form first** but include fallback selectors for the Tiptap editor

### Build Framework Decision: WXT
- **WXT v0.20.26** - actively maintained, Vite-based, purpose-built for web extensions
- Built-in `createShadowRootUi()` for Shadow DOM content script UIs with style isolation
- Built-in `@wxt-dev/storage` for typed storage
- Built-in `ctx.locationWatcher` for SPA navigation detection
- Built-in auto-imports for `defineContentScript`, `defineBackground`, etc.
- Supports vanilla TypeScript templates (no framework needed)
- Dev mode with HMR for popup/options pages; content scripts auto-reload

## Implementation Plan

### Phase 1: Project Scaffolding with WXT

- [x] **1.1** Initialize WXT project with vanilla TypeScript template:
  - Run `pnpm dlx wxt@latest init` selecting vanilla TS template
  - Project name: `civitai-llm-prompter`
  - Configure `wxt.config.ts` with Manifest V3 settings

- [x] **1.2** Configure `wxt.config.ts` with:
  - `manifest.name`: "CivitAI LLM Prompter"
  - `manifest.permissions`: `["storage", "activeTab"]`
  - `manifest.host_permissions`: `["https://civitai.com/*", "https://civitai.red/*", "https://api.x.ai/*", "https://openrouter.ai/*"]`
  - `manifest.content_scripts` targeting civitai.com and civitai.red (WXT handles this via entrypoint `matches`)
  - `manifest.web_accessible_resources` for any needed assets
  - Vite config for TypeScript path aliases if desired

- [x] **1.3** Create WXT entrypoint directory structure:
  ```
  civitai-llm-prompter/
  ├── wxt.config.ts
  ├── package.json
  ├── tsconfig.json
  ├── entrypoints/
  │   ├── background.ts              # Service worker
  │   ├── civitai.content/           # Content script (injected into CivitAI)
  │   │   ├── index.ts               # Main content script entry
  │   │   ├── chat-panel.ts          # Chat panel UI (Shadow DOM)
  │   │   ├── dom-bridge.ts          # DOM interaction with CivitAI form
  │   │   ├── prompt-parser.ts       # Parse LLM output into structured prompts
  │   │   └── style.css              # Chat panel styles (injected into Shadow DOM)
  │   ├── popup/
  │   │   ├── index.html
  │   │   └── main.ts
  │   └── options/
  │       ├── index.html
  │       └── main.ts
  ├── lib/                            # Shared library code (auto-imported by WXT)
  │   ├── api-client.ts              # OpenAI-compatible API client with streaming
  │   ├── storage.ts                 # WXT storage definitions
  │   ├── types.ts                   # TypeScript type definitions
  │   └── constants.ts               # Shared constants, selectors, defaults
  ├── public/
  │   └── icon/                      # Extension icons (16, 32, 48, 128)
  └── assets/                         # Static assets
  ```

- [x] **1.4** Add dev dependencies: `wxt` (includes Vite, TypeScript support), `@wxt-dev/storage` for typed storage

### Phase 2: API Client and Storage Layer

- [x] **2.1** Implement `lib/types.ts` with TypeScript interfaces:
  - `ProviderType` enum: `'xai' | 'openrouter' | 'custom'`
  - `ProviderConfig`: provider type, API key, base URL, default model
  - `ChatMessage`: role (system/user/assistant), content, timestamp
  - `Conversation`: id, title, messages array, created/updated timestamps
  - `GenerationPrompt`: positive prompt, negative prompt, optional parameters (cfgScale, steps, sampler, seed, clipSkip)
  - `ExtensionSettings`: providers map, active provider ID, system prompt, temperature, maxTokens, panelPosition
  - `StreamChunk`: delta content, finish_reason (for streaming responses)

- [x] **2.2** Implement `lib/storage.ts` using `@wxt-dev/storage`:
  - Define `settings` storage item (synced) for `ExtensionSettings`
  - Define `conversations` storage item (local) for `Conversation[]`
  - Define `activeConversationId` storage item (local) for current conversation
  - Define `panelState` storage item (local) for panel open/closed, position
  - Include default values and migration logic
  - Helper functions: `getActiveProvider()`, `saveConversation()`, `getConversation()`

- [x] **2.3** Implement `lib/api-client.ts` - unified OpenAI-compatible chat completions client:
  - `sendMessage()` function accepting: messages array, provider config, abort signal
  - Support configurable `baseURL` per provider (xAI = `https://api.x.ai/v1`, OpenRouter = `https://openrouter.ai/api/v1`)
  - Standard `POST /chat/completions` with `Authorization: Bearer <key>`
  - **Streaming support** via `fetch()` with `ReadableStream` reader - parse SSE lines (`data: {...}`) for real-time token display
  - OpenRouter-specific headers when provider is openrouter: `HTTP-Referer`, `X-OpenRouter-Title`
  - Error handling: 401 (bad key), 429 (rate limit with retry-after), 500 (server error), network errors
  - AbortController support for cancelling in-flight requests
  - Return type: `AsyncGenerator<string>` yielding content deltas, or a single response object

- [x] **2.4** Implement `lib/constants.ts`:
  - `PROVIDER_DEFAULTS`: map of provider type → { baseURL, defaultModel, models[] }
  - `SELECTORS`: object mapping CivitAI DOM targets to CSS selectors (with fallbacks)
  - `DEFAULT_SYSTEM_PROMPT`: expert SD/Flux prompt crafter instructions
  - `PROMPT_TEMPLATE_TAGS`: XML tags for structured output parsing (`<prompt>`, `<negative>`, `<params>`)
  - `EXTENSION_ID`: unique prefix for CSS classes (`cllp-`)

### Phase 3: Settings/Options Page

- [x] **3.1** Build `entrypoints/options/index.html` and `entrypoints/options/main.ts`:
  - API key input fields for xAI and OpenRouter (password type with show/hide toggle)
  - Provider selector (radio buttons or dropdown: xAI / OpenRouter / Custom)
  - Custom base URL field (shown only when Custom is selected)
  - Model selection: dropdown populated from constants + option to type custom model ID
  - Temperature slider (0-2, step 0.1)
  - Max tokens input (number, default 2048)
  - System prompt textarea (pre-filled with default, editable)
  - Save button with success/error feedback (no alert() - use inline status message)
  - Reset to defaults button
  - Clean, minimal styling (WXT handles bundling)

- [x] **3.2** Add connection test functionality:
  - "Test Connection" button next to each provider config
  - Sends a minimal completion request (`messages: [{role: "user", content: "Hi"}]`, `max_tokens: 5`)
  - Shows success (model name received) or error (HTTP status, message)
  - Non-blocking, with loading spinner

### Phase 4: Content Script - Chat Panel UI (Shadow DOM)

- [x] **4.1** Implement `entrypoints/civitai.content/index.ts` - main content script entry:
  - Use `defineContentScript()` with `matches: ["https://civitai.com/*", "https://civitai.red/*"]`
  - Set `cssInjectionMode: 'ui'` for Shadow DOM CSS isolation
  - Import `./style.css` for panel styles
  - Use `ctx.locationWatcher.run()` + `wxt:locationchange` event to handle SPA navigation (WXT built-in)
  - Detect if we're on the `/generate` page to enable/disable form interaction features
  - Initialize chat panel via `createShadowRootUi()` from WXT
  - Initialize DOM bridge for form interaction
  - Handle panel toggle via keyboard shortcut or extension icon click

- [x] **4.2** Implement `entrypoints/civitai.content/chat-panel.ts` - the chat panel UI:
  - Create panel DOM structure inside Shadow Root container:
    - Header bar with title, minimize/close buttons, settings gear icon
    - Message container (scrollable) with user/assistant message bubbles
    - Input area: textarea + send button
    - "Apply to Form" button on each assistant message (conditionally shown when on /generate)
    - Streaming indicator (typing dots animation) during response
  - Panel positioning: fixed right side, collapsible to icon, draggable
  - Dark/light theme: read `data-mantine-color-scheme` attribute from document root, default to dark
  - Panel state persistence (open/closed, position) via storage
  - Message rendering: handle markdown-like formatting, code blocks for prompts
  - Auto-scroll to bottom on new messages
  - Keyboard shortcuts: Enter to send, Shift+Enter for newline, Escape to close

- [x] **4.3** Implement `entrypoints/civitai.content/style.css`:
  - All classes prefixed with `cllp-` (e.g., `.cllp-panel`, `.cllp-message`, `.cllp-input`)
  - Dark theme as default (matching CivitAI's default dark mode)
  - Light theme variant via CSS custom properties, toggled by `data-mantine-color-scheme`
  - Smooth animations for panel open/close, message appearance
  - Responsive: panel should not overlap critical CivitAI UI elements
  - Highlight animation for form fields when "Apply to Form" is used (brief glow effect)
  - Loading/streaming animations
  - Ensure all styles are self-contained (Shadow DOM isolation via WXT)

- [x] **4.4** Implement conversation management in the chat panel:
  - New conversation button (in header or menu)
  - Auto-title conversations from first user message
  - Auto-save conversations to storage on each message
  - Load conversation history on panel open
  - Clear current conversation button (with confirmation)

### Phase 5: Content Script - DOM Bridge (CivitAI Form Interaction)

- [x] **5.1** Implement `entrypoints/civitai.content/dom-bridge.ts` - critical bridge between LLM output and CivitAI's form:
  - **`detectForm()`**: Use `MutationObserver` or WXT's `autoMount` to detect when the generation form is present. The form lives in a sidebar `<aside>` element. Check for `#input_prompt` or `[data-tour="gen:prompt"]` as confirmation.
  - **`readCurrentPrompt()`**: Read current values from `#input_prompt` and `#input_negativePrompt` to provide context to the LLM about what's already configured.
  - **`readFormState()`**: Read current generation parameters (model, CFG, steps, sampler, seed, aspect ratio, clip skip) from their respective `#input_{name}` fields. This provides full context to the LLM.
  - **`setPrompt(field, value)`**: Set prompt values using the `nativeInputValueSetter` technique for React-controlled inputs:
    1. Get the textarea element via selector
    2. Use `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set`
    3. Call the setter with the new value
    4. Dispatch `new Event('input', { bubbles: true })` to trigger React's state update
    5. Dispatch `new Event('change', { bubbles: true })` for good measure
  - **`setParameter(field, value)`**: Set generation parameters on appropriate form fields. Handle different input types: sliders (Mantine Slider), dropdowns (Mantine Select), number inputs (Mantine NumberInput), segmented controls. Each may need different event dispatch strategies.
  - **`highlightField(field)`**: Brief visual highlight animation on a field after its value is set (add a temporary CSS class to the element or its wrapper).
  - **`isOnGeneratePage()`**: Check if current URL matches `/generate` route.
  - **`watchForForm(callback)`**: MutationObserver that fires when the form appears/disappears (SPA navigation).

- [x] **5.2** Implement `entrypoints/civitai.content/prompt-parser.ts` - parse LLM responses into structured data:
  - **`parseAssistantMessage(content)`**: Extract structured data from LLM response:
    - Look for XML-tagged sections: `<prompt>...</prompt>`, `<negative>...</negative>`, `<params>...</params>`
    - If no XML tags found, treat the entire response as the positive prompt (fallback mode)
    - Parse `<params>` section for key-value pairs (cfgScale, steps, sampler, seed, clipSkip, aspectRatio)
  - **`formatPromptForLLM(currentState)`**: Format the current form state as context for the system/user message, so the LLM knows what's already configured.
  - **`buildSystemPrompt(userSystemPrompt, currentState)`**: Combine the user's configured system prompt with dynamic context about the current form state and model selection.

- [x] **5.3** Implement the "Apply to Form" action flow:
  - User clicks "Apply to Form" button on an assistant message
  - Call `parseAssistantMessage()` to extract structured data
  - If on `/generate` page and form is detected:
    1. Call `setPrompt('prompt', parsed.positivePrompt)` for the positive prompt
    2. If negative prompt present, call `setPrompt('negativePrompt', parsed.negativePrompt)`
    3. If parameters present, call `setParameter()` for each provided parameter
    4. Highlight all modified fields with `highlightField()`
    5. Show success toast/notification in the panel
  - If form not detected, show error: "Navigate to the Generate page first"
  - Support "Append" vs "Replace" mode (toggle in panel settings or modifier key on click)

### Phase 6: Background Service Worker

- [x] **6.1** Implement `entrypoints/background.ts`:
  - Extension icon click action: toggle the chat panel visibility by sending a message to the active CivitAI tab
  - Set extension icon state (active/inactive badge) based on whether current tab is a CivitAI page
  - Listen for `chrome.tabs.onUpdated` to update icon state on tab navigation
  - Optional: context menu entry "Send to CivitAI Prompter" for selected text on any page
  - Message routing: forward messages between popup, content script, and options page if needed
  - Note: API calls are made directly from the content script (no proxying needed with `host_permissions`)

### Phase 7: Extension Popup

- [x] **7.1** Build `entrypoints/popup/index.html` and `entrypoints/popup/main.ts`:
  - Status display: connected to CivitAI page? (check via `chrome.tabs.query` + messaging)
  - API provider status: which provider is active, is key configured?
  - Quick toggle: open/close chat panel on current CivitAI tab
  - Quick provider switcher: dropdown to change active provider without opening options
  - Quick model switcher: dropdown populated from provider's model list
  - Link to full settings (options page)
  - Current conversation: show last message preview
  - Compact, clean design

### Phase 8: System Prompt Engineering

- [x] **8.1** Design default system prompt instructing the LLM to:
  - Act as an expert AI image/video generation prompt crafter
  - Understand CivitAI's ecosystem (Stable Diffusion, SDXL, Flux, SD3, etc.)
  - Output prompts using structured XML tags: `<prompt>`, `<negative>`, `<params>`
  - Be conversational and helpful, explaining prompt choices when asked
  - Understand booru-style tagging, natural language prompts, attention weights `(word:1.2)`
  - Know model-specific syntax differences (SD vs Flux vs SD3)
  - Include suggested generation parameters when relevant
  - Default example:
    ```
    You are an expert AI image generation prompt crafter. Help the user create prompts for CivitAI's image generation tools.
    
    When providing a prompt, use this format:
    <prompt>The positive prompt text here</prompt>
    <negative>The negative prompt text here (optional)</negative>
    <params>
    cfgScale: 7
    steps: 30
    sampler: Euler a
    </params>
    
    You can also provide explanations and suggestions outside the tags. Be conversational and helpful.
    ```

- [x] **8.2** Implement dynamic system prompt enhancement:
  - When a conversation starts or the form state changes, inject current form state as context
  - Include: current model name, base model type, current prompt, current parameters
  - Format as a supplementary context block appended to the user's system prompt
  - This lets the LLM give contextually relevant suggestions (e.g., different CFG ranges for Flux vs SD)

### Phase 9: Polish and Edge Cases

- [x] **9.1** Handle CivitAI's SPA navigation:
  - Use WXT's `ctx.locationWatcher.run()` + `wxt:locationchange` event listener
  - On URL change: re-detect if on `/generate` page, update form detection, show/hide "Apply" buttons
  - Content script matches `https://civitai.com/*` and `https://civitai.red/*` (all pages) so the panel is always available
  - Form interaction features only activate when `/generate` is detected

- [x] **9.2** Handle both domains identically:
  - Same content script for both `civitai.com` and `civitai.red`
  - Same DOM structure expected on both (confirmed: same app, different domains)
  - Test on both domains

- [x] **9.3** Implement error handling and user feedback:
  - API key missing → error message in chat with link to settings page
  - API key invalid (401) → clear error: "Invalid API key. Please check your settings."
  - Rate limiting (429) → display "Rate limited. Retrying in X seconds..." with countdown
  - Network errors → "Connection failed. Check your internet connection."
  - DOM element not found → "Generation form not detected. Navigate to the Generate page first."
  - Streaming interrupted → graceful fallback to partial response display
  - All errors shown as system messages in the chat, not browser alerts

- [x] **9.4** Add keyboard shortcuts:
  - Toggle panel: configurable shortcut (default: `Ctrl+Shift+P` or via `chrome.commands` API)
  - Send message: Enter (in input textarea)
  - Newline: Shift+Enter
  - Apply last response to form: `Ctrl+Shift+A` (when on /generate page)
  - Close panel: Escape

- [x] **9.5** Performance optimization:
  - Lazy-load the chat panel DOM (only create when first opened)
  - Debounce DOM observations (form detection) to avoid excessive MutationObserver callbacks
  - Limit conversation history in memory (load last N messages, paginate rest)
  - Use `requestAnimationFrame` for DOM updates during streaming
  - Clean up event listeners and observers on panel close / context invalidation

- [x] **9.6** Handle the Tiptap/ProseMirror editor fallback:
  - If `#input_prompt` textarea is not found, look for `.ProseMirror[contenteditable="true"]` inside `.tiptap-textarea-shell`
  - For ProseMirror editors, use `document.execCommand('insertText', false, value)` or set `textContent` + dispatch input event
  - This future-proofs against CivitAI migrating to the newer Tiptap-based form

## Verification Criteria

- [ ] Extension installs successfully in Chrome via developer mode (load unpacked)
- [ ] Chat panel appears on both `civitai.com` and `civitai.red` pages via Shadow DOM
- [ ] Panel styles are isolated from CivitAI's Mantine styles (no visual conflicts)
- [ ] API keys can be configured in settings and persist across sessions
- [ ] Chat messages sent to xAI return streaming responses displayed in real-time
- [ ] Chat messages sent to OpenRouter return streaming responses displayed in real-time
- [ ] "Apply to Form" successfully populates the positive prompt textarea on `/generate`
- [ ] "Apply to Form" successfully populates the negative prompt when provided
- [ ] "Apply to Form" optionally sets generation parameters (CFG, steps, sampler)
- [ ] Panel theme matches CivitAI's dark/light mode setting
- [ ] Panel persists across SPA navigation within CivitAI
- [ ] Conversations are saved and can be resumed after page reload
- [ ] Error states show clear user-facing messages (no console-only errors)
- [ ] Extension popup shows correct status and allows quick provider switching

## Potential Risks and Mitigations

1. **CivitAI DOM Structure Changes**
   - Risk: CivitAI updates their UI, breaking CSS selectors and DOM interaction
   - Mitigation: Use multiple fallback selector strategies (ID → data-tour → data-testid → name attribute → class); use MutationObserver with flexible matching; the `#input_{name}` pattern is generated by `withController` HOC which is deeply embedded in their form architecture and unlikely to change

2. **React Controlled Input Value Setting**
   - Risk: React's synthetic event system may not pick up programmatic value changes
   - Mitigation: Use the `nativeInputValueSetter` technique with `input` + `change` event dispatch; test thoroughly; fallback to `localStorage` injection (`generation:prompt` / `generation:negativePrompt` keys) which CivitAI's `usePersistForm` hook reads; fallback to `document.execCommand('insertText')` for contenteditable

3. **CSP (Content Security Policy) Restrictions**
   - Risk: CivitAI's CSP may interfere with content script behavior
   - Mitigation: Chrome extension content scripts are exempt from page CSP for API calls when using `host_permissions`; Shadow DOM is not affected by CSP; WXT handles manifest CSP configuration

4. **API Key Security**
   - Risk: API keys could be accessed by other extensions or compromised
   - Mitigation: Use `chrome.storage.local` (not synced); never expose keys in the DOM; keys only sent via HTTPS to API endpoints; warn users about risks in settings UI

5. **Streaming SSE in Content Scripts**
   - Risk: Content scripts may have limitations with fetch streaming
   - Mitigation: MV3 content scripts support `fetch()` with `ReadableStream` directly; `host_permissions` enables cross-origin requests; WXT's architecture handles this cleanly

6. **Dual Form System (Legacy vs Tiptap)**
   - Risk: CivitAI may switch from Mantine Textarea to Tiptap/ProseMirror editors
   - Mitigation: Include fallback selectors for `.ProseMirror[contenteditable]`; abstract the form interaction behind a common interface in `dom-bridge.ts`; the `#input_prompt` pattern works for the current form

7. **WXT Framework Risk**
   - Risk: WXT could become unmaintained or have breaking changes
   - Mitigation: WXT is actively maintained (v0.20.26 as of May 2026); generates standard Chrome extension output; if needed, can eject to plain Vite config since WXT is just a Vite plugin wrapper

## Alternative Approaches

1. **Side Panel API instead of Content Script Shadow DOM**
   - Chrome's Side Panel API provides a native sidebar for extensions
   - Trade-off: Cleaner integration, no DOM injection needed, but panel is in a separate browser sidebar (not overlaying the page), less flexible positioning, and the panel can't directly access the page's DOM for form interaction (would need messaging bridge)
   - Could be offered as an alternative mode in the future

2. **CivitAI Orchestration API instead of DOM manipulation**
   - Use CivitAI's Orchestration API to generate images directly via API
   - Trade-off: More powerful (full API control), but requires separate CivitAI API key, costs Buzz, and doesn't use the familiar on-site UI
   - Could be offered as an advanced mode alongside the DOM-based approach

3. **IFrame-based UI instead of Shadow DOM**
   - WXT supports `createIframeUi()` which provides full style isolation + HMR
   - Trade-off: Complete isolation but can't access page DOM directly from iframe; would need postMessage bridge to content script for form interaction; adds complexity
   - Shadow DOM is the better choice here since we need page DOM access

4. **Use existing LLM chat extensions**
   - Extensions like Sider, Monica, ChatHub provide in-page LLM chat
   - Trade-off: Would need to add CivitAI-specific DOM manipulation on top; less control over providers, system prompt, and structured output parsing
   - Not recommended - our use case is too specific

## Architecture Decision Records

### ADR-1: WXT Framework
**Decision**: Use WXT (v0.20.26+) as the build and development framework
**Rationale**: Purpose-built for web extensions; provides built-in Shadow DOM UI creation, typed storage, SPA navigation handling, auto-imports, and Vite-based bundling. Eliminates boilerplate for manifest management, content script registration, and UI injection. Active maintenance and good documentation.

### ADR-2: Vanilla TypeScript (No UI Framework)
**Decision**: Use vanilla TypeScript with hand-rolled DOM manipulation for the chat panel
**Rationale**: The chat panel UI is relatively simple (message list, input area, buttons); avoids bundling a framework; no risk of conflicts with CivitAI's React/Mantine; Shadow DOM already provides style isolation; WXT's vanilla template works well for this.

### ADR-3: Shadow DOM for Style Isolation
**Decision**: Use WXT's `createShadowRootUi()` for the injected chat panel
**Rationale**: CivitAI uses Mantine with global CSS that would conflict with our styles. Shadow DOM provides perfect isolation. WXT handles the setup automatically with `cssInjectionMode: 'ui'`.

### ADR-4: Direct API Calls from Content Script
**Decision**: Make API calls directly from the content script using `fetch()` with streaming
**Rationale**: MV3 content scripts can make cross-origin requests when hosts are listed in `host_permissions`; avoids message-passing overhead for streaming; simpler architecture; WXT supports this pattern.

### ADR-5: Structured XML Output from LLM
**Decision**: Use XML tags (`<prompt>`, `<negative>`, `<params>`) in system prompt to get structured output
**Rationale**: More reliable than JSON (no escaping issues in freeform text); LLMs handle XML delimiters well; allows extracting positive prompt, negative prompt, and parameters from a single response; degrades gracefully (if no tags, treat entire response as prompt).

### ADR-6: Target Legacy Form First, Tiptap as Fallback
**Decision**: Primary selectors target `#input_prompt` (Mantine Textarea); fallback to `.ProseMirror` for Tiptap
**Rationale**: The legacy `GenerationForm2` with Mantine Textarea is what currently renders on `/generate`. The Tiptap-based form exists in the codebase but is for the newer data-graph form. Including the fallback future-proofs the extension.

## Dependencies

- **Build**: WXT v0.20.26+ (includes Vite, TypeScript), @wxt-dev/storage
- **Runtime**: Chrome 116+ (for Manifest V3 features)
- **External APIs**: xAI API (`api.x.ai/v1`), OpenRouter API (`openrouter.ai/api/v1`)
- **No npm runtime dependencies** beyond WXT - keeps the extension lightweight
