# Chat: multimodal + agentic page control (2026-06-21)

> **Status: historical implementation plan.** It records the design that introduced multimodal
> chat and confirmable page actions, but the implementation has since evolved. Do not use its
> file list or build slices as an active queue; use the
> [living LLM-assistant architecture and evaluation plan](./2026-07-31-llm-assistant-architecture-and-evaluation.md)
> and current tests instead.

## Goal
Three interlinked capabilities, built on shared primitives:
1. **Post images to the LLM** — paste / drag / file-pick / "grab the image I'm viewing" → send to a vision model.
2. **LLM sees images** — Civitai CDN URLs (public) passed straight through; local files as data URLs.
3. **LLM acts on the page** — read page state freely; propose writes (prompt/params, feed tags, navigation, generate) as confirm-to-apply cards.

## Decisions (with the user)
- Build the **foundation first**, then layer vision + agentic together.
- **Read free, confirm writes**: read tools run immediately; write tools surface a confirmable action card — nothing mutates the page without a click.
- **No model-capability tracking** — send the image; if the model can't accept it, let the provider's API error surface (api-client already passes API error bodies through). User's responsibility to pick a vision model.

## Architecture — three primitives

### A. Multimodal message model
- `lib/types.ts`: `ChatMessage.content` becomes `string | ContentPart[]`, where
  `ContentPart = {type:'text', text} | {type:'image_url', image_url:{url, detail?}}`.
  String stays the common case (back-compat).
- `lib/api-client.ts`: in the request serializer, pass `content` through as-is when it's an
  array (OpenAI-compatible user messages accept text+image parts). System/assistant/tool stay
  strings. Streaming + tool loop unchanged (deltas are text).
- Storage: image data URLs are large → add `unlimitedStorage` permission (manifest). Page-image
  URLs are tiny (just the CDN URL). (Future: evict old image bytes from saved convos.)

### B. Image attach + page-grab (UI)
- `chat-panel.ts`: input area gets an attachment strip + affordances:
  - 📎 file picker, clipboard **paste** of images, **drag-drop** onto the panel → `FileReader`
    → data URL → pending attachment thumbnail.
  - "Attach current image" button → reads the image open on the page.
  - Render assistant/user messages whose `content` is an array (text + `<img>` thumbnails).
  - On send: combine textarea text + pending attachments into a `ContentPart[]` user message.
- `dom-bridge.ts`: add `getOpenImageUrl()` (the main image on /images/:id or the lightbox via
  `<img>.currentSrc`) and `getVisibleImageUrls()` (feed thumbnails) for the page-grab + a future
  agentic image tool.

### C. Page-action tools (agentic, confirm-writes)
- New `lib/page-tools.ts` (same shape as `civitai-tools.ts`): a `PAGE_TOOLS` array + an executor.
  Executed in the content script (DOM access), wired into `executeTool` alongside
  `executeCivitaiTool` (dispatch by tool name).
  - **Read (run now):** `get_page_context` (route, onGeneratePage, form state, open image URL,
    feed kind + applied tags), `read_generation_form`.
  - **Write (propose, don't apply):** `propose_generation` ({positive, negative, params}),
    `propose_feed_tags` ({tagIds|names, mode}), `propose_navigation` ({url}),
    `propose_generate` (click submit). Each returns "surfaced to user; applied only if they
    accept", and emits a confirm **action card** into the chat.
- Action cards: generalize the existing apply-to-form button. A card renders the proposed action
  + Apply/Dismiss; Apply calls the matching `dom-bridge` write (reuse `setPrompt`/`setParameter`/
  `highlightField`; reuse `buildHrefWithTags` for tags; `location.assign` for nav).
- Reuse the existing tool-loop (`sendMessageWithTools`, `maxToolRounds`); just a bigger tool set
  and a name-dispatched executor.

## Build slices (each testable live in the MCP browser)
1. **Foundation + post/see images** (primitive A + B): types, api-client serialization,
   `unlimitedStorage`, chat-panel render+attach (paste/drag/file), `getOpenImageUrl` + grab
   button. → attach an image, the model sees it. Verify with a vision model.
2. **Agentic page control** (primitive C): `page-tools.ts`, executor dispatch, read tools,
   write-as-confirm-card, card UI + apply wiring. → "set my feed to these tags", "draft a prompt
   and put it in the form" (with confirm).

## Files
- `lib/types.ts` — ContentPart union; `ChatMessage.content` widened.
- `lib/api-client.ts` — array-aware content serialization.
- `lib/page-tools.ts` (NEW) — PAGE_TOOLS + executePageTool.
- `entrypoints/civitai.content/chat-panel.ts` — attach UI, multimodal render, action cards.
- `entrypoints/civitai.content/dom-bridge.ts` — getOpenImageUrl/getVisibleImageUrls; nav helper.
- `entrypoints/civitai.content/index.ts` — wire page-tools into executeTool; pending-attachments
  → multimodal user message; action-card apply handlers.
- `wxt.config.ts` — add `unlimitedStorage` permission.

## Verify (chrome-devtools MCP)
- Paste/drag/file an image → thumbnail in input → send → vision model describes it.
- "Attach current image" on an /images/:id page → model sees that image.
- Non-vision model + image → provider API error surfaces cleanly in the panel.
- "Filter the feed to X and Y" → action card → Apply → feed updates (reuses tag-filter URL).
- "Draft a cyberpunk prompt" on /generate → action card → Apply → form fields set + highlighted.
