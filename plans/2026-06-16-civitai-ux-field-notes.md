# CivitAI UX field notes — exploration for the prompter (2026-06-16)

> **Status: historical field research.** These observations describe one logged-out CivitAI
> session on 2026-06-16 and may no longer match the live site. They remain useful evidence, not
> current implementation authority. Track active assistant work in the
> [living architecture and evaluation plan](./2026-07-31-llm-assistant-architecture-and-evaluation.md).

Goal: explore civitai.com as a user would, find the friction, and note where the
on-site LLM chat panel ("LLM Prompter") can actually help. Logged OUT during this
pass (no account in the test profile), so generation/auth flows are noted but not
fully exercised.

Driving via chrome-devtools-mcp → headed Chrome-for-Testing with the extension loaded.

## TL;DR implications for the prompter
1. **Be the natural-language entry point the site lacks.** The feed can't filter by free
   tags; the rich search is a separate, non-obvious page. A chat panel where you type
   "cyberpunk samurai, night, neon, Illustrious base" and it returns matching images/LoRAs
   (via the Civitai API tools we just built, or by driving `/search/*`) routes around the
   whole feed-vs-search split. This is a real, felt gap — not a nice-to-have.
2. **The generate page is the killer surface, and it's auth-gated.** `/generate` →
   `/login` when logged out, so "apply to form" only works for signed-in users. The panel
   should detect auth/form state and, when off the generate page, still be useful as chat +
   "send me to generate with this prompt".
3. **Prompt metadata is inconsistent.** Many images (esp. uploaded, not made-onsite) expose
   only "Resources used", no prompt. The `mine_civitai_prompts` tool must degrade
   gracefully and prefer made-onsite / metadata-only images.
4. **Images are tagged but you can't filter the feed by those tags.** Detail pages show
   auto-tags (moon, night, woman…). The panel could turn "more like this, but rainy" on a
   given image into a concrete tag/search set — bridging view→intent→prompt.
5. **The page is heavy (ads + animated slot-counters everywhere).** A lightweight in-page
   assistant that answers "what LoRA/tags do I need" without navigating the slow SPA has
   standalone value.
6. **Context-ingestion is the upgrade.** Today the content script only reads the *generate
   form*. On `/images`, `/models`, `/search` it's a blind generic chat. Feeding it the
   current page's context (an image's tags+prompt, a model's trigger words) would let the
   chat reason about what you're looking at — the difference between a chatbox and a
   co-pilot.

## Observations by area

### Images feed + filtering
- `/images` offers a single horizontal row of ~30 **curated category chips** (ANIMAL,
  ANIME, ARMOR, CAR, FANTASY, SCI-FI, WOMAN, …). Click = toggle one curated category.
- The **Filters** dialog adds: time period (Day/Week/Month/Year/All Time), checkboxes
  (Metadata only, Made On-site, Originals Only, Remixes Only), an **"All Base Models"**
  dropdown, and two **"Created with…"** resource pickers (filter images by the
  checkpoint/LoRA used). Sort dropdown = Most Reactions / etc.
- **VERDICT: there is NO free-text / multi-tag input to filter the feed.** You cannot say
  "show me images tagged `cyberpunk, neon, samurai`". You get curated chips OR
  filter-by-resource. This matches the user's complaint exactly.
- "Created with…" (resource filter) IS genuinely useful for prompt-mining a specific
  model — but it's keyed on models, not concepts/tags.

### Search bar + category dropdown
- Top bar = category dropdown (Models/Images/Videos/…) + free-text box. Searching
  "cyberpunk samurai" with category=Images routes to a **separate page**:
  `/search/images?sortBy=images_v6&query=…` (Algolia index `images_v6`).
- That search page is FAR richer than the feed: full-text ("100,000 results") + a facet
  sidebar with **Sort, Creation Date range, Media Type, Aspect Ratio, Users, Tags, Tools,
  Techniques, Base Model**. So a real **Tags** facet exists — just not on the feed.
- **THE UX TRAP (user's exact point):** the `/images` *feed* and the `/search/images`
  *search* are two different systems with different filters and **no shared state**. To
  filter by an arbitrary tag you must abandon the feed, use the top search bar, and land in
  search — non-obvious. There's no "filter this feed by tags X,Y,Z" affordance in place.
- Page is ad-heavy (a Google/PixVerse ad iframe popped over the feed mid-interaction).

### Model / LoRA pages (prompt + trigger word surfacing)
- Model cards (`/models`) carry a base-model badge (IL/NAI/Pony) + a "CREATE" button that
  jumps into the generator with that resource. Useful context the panel could read.

### Image detail pages
- Show auto-tags (e.g. moon, night, woman, man, sky, tree), a "Generation data" panel, and
  "Resources used" (e.g. "Flux.2 Checkpoint"). Prompt text is only present when the image
  carries metadata — the sampled image exposed resources but NO prompt / no copy button.
- Heavy animated number counters (reaction/stat slot-machines) on every card.

### Generate page (prompt crafting — the core use case)
- `/generate` requires login: logged-out hits `/login?returnUrl=/generate`. Could NOT
  exercise the real form / "apply to form" in this profile.
- This is exactly where the panel + `<prompt>/<negative>/<params>` apply-to-form is meant
  to shine; needs an authenticated session to test end-to-end.

### Misc friction
- Cookie/consent CMP wall on entry (snigelweb), non-standard buttons.
- Ad iframes inject over content mid-browse; SPA feels laggy.

## Generation flow notes
- Blocked logged-out. Next step to test for real: sign into the (visible) test-profile
  window, then drive `/generate` to verify form detection + apply-to-form + the tool-calling
  lookup, all on a live session.
