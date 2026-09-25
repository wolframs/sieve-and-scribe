# Feature: feed tag-filter injector (2026-06-21)

> **Status: historical feature plan.** The repository now contains a more developed feed-filter
> implementation, so the sketch and open questions below are preserved as provenance rather than
> an active backlog. Use current code and tests for behavior; use the
> [living LLM-assistant architecture and evaluation plan](./2026-07-31-llm-assistant-architecture-and-evaluation.md)
> for assistant work.

## The wish
CivitAI's `/images` and `/videos` *feeds* have no free-text tag filter (only ~30 curated
chips) — but the feed URL secretly accepts `?tags=<id>;<id>;<id>` (numeric tag IDs,
semicolon-separated). Inject a small UI element into the feed that lets the user type tag
names and filter the feed by them. The hard part — getting tag IDs from names — is solved.

## Verified mechanics (tested live, logged-in browser)
1. **URL filter works:** `https://civitai.com/images?tags=499` → feed filters, URL retained,
   results returned. Multi-tag = `?tags=499;4838` (semicolon-separated; user-confirmed).
   CivitAI shows NO visible active-tag indicator for URL-provided tags → our element also
   becomes the missing "active filters" display.
2. **name → numeric ID** via CivitAI's own tRPC endpoint (same-origin, works with cookies):
   ```
   GET /api/trpc/tag.getAll?batch=1&input=<urlencoded JSON>
   input = {"0":{"json":{"query":"cyberpunk","limit":10,"entityType":["Image"]}}}
   → [0].result.data.json.items = [{id:499,name:"cyberpunk",isCategory:false}, ...]
   ```
   - **`entityType:["Image"]` is required** — without it you get junk tags (`cyberpunk]`,
     `cyberpunk,`). With it, clean ranked tags.
   - Public REST `/api/v1/tags` is NOT usable — returns names only, no IDs, model-scoped.

## Implementation sketch
New content-script module (separate from the LLM chat panel), active on the feed pages
(`/images`, `/videos`, and probably `/search/*` left alone since it has its own facets):
- Inject a compact control into/near the existing filter row (the chip bar). A text input
  + autocomplete dropdown + removable chips for selected tags.
- On type (debounced ~250ms): call `tag.getAll` (entityType `["Image"]`; verify videos use
  the same), show `{name,id}` suggestions.
- On select: add `{name,id}` chip; rebuild the URL's `tags` param (merge with any existing
  `?tags=`, `;`-join the IDs, preserve other query params) and navigate.
  - Simplest navigation: set `location.search` (full reload; feed reads tags on load).
  - Nicer: `history.pushState` + dispatch so the SPA reacts without full reload (needs
    testing against CivitAI's router; fall back to reload if flaky).
- On load: parse existing `?tags=` IDs back into chips so state is visible (reverse-resolve
  names via `tag.getAll` by... no id-lookup; instead keep a name↔id map in the chip when
  added, and for IDs present at load show the raw id or fetch name — minor).
- Re-inject on SPA route changes (reuse the existing locationWatcher pattern).

## Open questions to settle during build
- Multi-tag separator: confirm `;` (user says yes) vs `,` vs repeated `tags=`.
- Videos feed: does `entityType:["Image"]` return the right tags, or is there a Video type?
- AND vs OR semantics of multiple `tags=` ids (does the feed intersect or union?).
- Does `tag.getAll` work logged-out? (Likely yes — it's the public filter autocomplete.)

## Notes
- Standalone from the prompter chat, but lives in the same extension/content script.
- Pairs with field notes in `2026-06-16-civitai-ux-field-notes.md` (this IS the fix for the
  #1 friction documented there).
