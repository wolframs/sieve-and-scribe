# Sieve & Scribe

A browser extension that adds an LLM assistant and grouped tag filtering to
[CivitAI](https://civitai.com/). It can research models and images, inspect the active generation
workflow, craft image or video prompts, and propose changes to the site without silently spending
Buzz or mutating the page.

The project is actively developed. Chrome MV3 is the primary tested target; Firefox builds are
available for development but are not currently release-validated.

<!-- DRAFT: needs author -->
The name is the two halves. **Sieve** is the filtering: Boolean tag groups over Civitai's feed —
AND/OR, exclusions, saved presets, and a readable expression you can copy out and paste back in.
**Scribe** is the assistant: a side-panel chat that lets an OpenRouter or xAI model use the site
the way you would — read the generate form, look models and LoRAs up through Civitai's own REST
API and official Site MCP, and hand prompts back as cards you apply or dismiss.

I wrote it for my own use, and it runs on your own API key. It is not affiliated with, endorsed
by, or connected to Civitai.

<!-- DRAFT: needs author -->
<!-- SCREENSHOT SLOT — the side panel and the filter dock. Nothing captured from the live feed:
     that would publish other people's images. Use placeholder or own-generation content. -->

## What it does

- Opens a persistent chat in Chrome's side panel, with xAI and OpenRouter model selection.
- Supports streaming, multi-round tool calls, saved conversations, rolling context, and numbered
  image attachments that can be inspected again later.
- Reads the current CivitAI route, generation form capabilities, feed state, visible images, and
  uploaded generator images.
- Uses structured CivitAI REST tools for model/LoRA research, trigger words, example prompts, and
  articles.
- Uses CivitAI's official Site MCP inventory directly:
  - **Off** hides CivitAI research tools.
  - **Read-only** exposes every server tool annotated as read-only.
  - **Full — confirm writes** also exposes account/write tools, but each call becomes a visible
    confirmation card showing the tool and arguments before it can execute.
- Proposes prompts, source images, resources, navigation, feed filters, and generation through
  persisted action cards. Apply/Dismiss results are returned to the assistant so it can replan.
- Can pause on one bounded multiple-choice question when a material creative choice is unresolved,
  persist the selected answer, and resume without treating the answer as permission to change the page.
- Keeps Generate as its own confirmation; applying a prompt or source image never starts a paid
  generation.
- Adds a grouped CivitAI feed filter with tag AND/OR groups and exclusions, reversible detail-page
  tag pickup, one-click tray assignment, direct chip and whole-group regrouping, persistent
  collapsible summaries for large groups, explicit Boolean connectors between consistently framed
  groups, and a focused group editor with local search, multi-selection, bulk reassignment,
  exclusion, removal, ordering, and a focused review view for unresolved, duplicated, or noisy tag
  names. Draft history provides Undo, Redo, and Revert-to-applied with
  a live group/tag/facet summary. Similar-tag expansions retain their seed and membership as
  compact, expandable bundles across URLs and presets. Individual OR groups can be saved once and
  inserted into or used to replace a group in another filter. A readable, ID-stable Boolean expression
  view supports copy/export and validated import. Search and group-match composition controls
  stay above long selections. URL-restored IDs resolve through local caches and CivitAI's tag-by-ID
  route, so long-tail and punctuation variants do not remain as numeric fallback labels. Cached tag
  discovery supports a compact secondary editor for creator,
  orientation,
  reaction/view/comment/collection minimums, generation metadata, CivitAI-generation provenance,
  primary model version, and used/excluded resources. Model/resource choices are resolved only
  when searched; feed cards are matched locally by their existing version IDs. Named presets
  preserve the whole combined filter and its labels.
- Integrates the feed editor into the left side of CivitAI's desktop **Filters** popup, widening
  it without increasing its height or narrowing the native controls. Uses CivitAI's theme tokens,
  preserves drafts across closing/reopening, and keeps actions visible while long editor contents
  scroll within the available column. Native and tag filters retain separate Apply buttons.
  Narrow screens stack the editor inside native Filters; detail pages use the same integration.
  The editor stays hidden when native Filters are unavailable, including generation views.
- Keeps a bounded, redacted local journal of extension warnings/errors that the user can export
  from Settings when an intermittent site change needs debugging. Nothing is uploaded automatically.
  Enable **Settings → Diagnostic logs → Debug mode** before reproducing a problem to include
  chat/tool events, action states, and form-verification comparisons in the newest 250 entries.
  **Export active chat + logs** also includes the selected conversation and proposed prompts
  (including older chats), while omitting image attachments and provider settings. Exports go
  to `Downloads/Sieve & Scribe Logs`; review transcript exports before sharing.

## Install an unpacked development build

Requirements: Node.js 20 or newer, [pnpm](https://pnpm.io/), and Chrome 116 or newer.

```sh
pnpm install
pnpm build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`.output/chrome-mv3`. Open CivitAI, click the extension icon, open Settings to add an xAI or
OpenRouter API key, choose a model, and click **Open Chat**.

The optional CivitAI API token enables authenticated/private lookups and confirmed Site MCP
actions. The assistant remains useful for public catalog work without it.

Built-in catalog lookups run through the active CivitAI tab, retaining its `.com` or `.red`
host and login session. On `.red`, omitted mature-content filters default to included;
explicit safe-only requests are respected. Results still depend on account and server access
rules. The official Site MCP is a separate, token-authenticated service. Empty results report
their search scope and do not establish an authentication or content-filter failure.

## Development

```sh
pnpm dev                 # Chrome development build
pnpm dev:firefox         # Firefox development build
pnpm build               # Chrome production build
pnpm build:firefox       # Firefox production build
pnpm zip                 # Chrome distribution archive
pnpm zip:firefox         # Firefox distribution archive
```

Important source areas:

- `lib/api-client.ts` — OpenAI-compatible streaming and multi-round tool loop.
- `lib/chat-controller.ts` — conversation, tools, persisted proposals, and continuation flow.
- `lib/civitai-mcp.ts` / `lib/civitai-mcp-rpc.ts` — bounded official Site MCP transport.
- `lib/page-tools.ts` / `lib/action-state.ts` — readable page capabilities and confirmed actions.
- `entrypoints/civitai.content/` — page bridge and chat UI.
- `entrypoints/sidepanel/`, `entrypoints/popup/`, `entrypoints/options/` — extension surfaces.
- `plans/2026-07-31-llm-assistant-architecture-and-evaluation.md` — canonical living plan and
  implementation evidence. Older files under `plans/` are historical.

## Tests

```sh
pnpm check                         # typecheck + deterministic unit/integration tests
pnpm build                         # Chrome production build
pnpm test:civitai:mcp-contract     # opt-in live, no-key official MCP contract
pnpm test:assistant:protocol       # deterministic streaming/tool-loop protocol tests
pnpm exec playwright install chromium # one-time setup for the isolated agent browser tests
pnpm test:assistant:e2e            # builds the extension, then tests agent chains without API credit
pnpm browser:smoke:setup           # isolated project-local Chrome profile + daemon
pnpm test:e2e                      # browser smoke; see docs/browser-smoke.md
```

The agent browser suite loads the actual built extension in a disposable Chromium profile and
drives its side-panel document, background streaming proxy, controller, storage, and page bridge.
Only remote services and the CivitAI page are fixtures. It checks visible tool progress and saved
errors, catalog success/failure, missing-tab recovery, cancellation, the tool limit and lookup
cache, provider failures, and confirmed prompt application. It needs no credentials and writes
panel screenshots to `.artifacts/agent-e2e/`. It does not verify CivitAI's current DOM or live API
availability; the separate site smoke and live evaluations cover those boundaries.

Successful Apply cards finish locally and save an internal outcome for the next user message.
They do not request another completion for each confirmed LoRA. Resource Apply uses the exact
version's generation metadata and the open picker's native selection callback, so personal
browsing filters do not need to be changed. It checks access, generation availability, allowed
resource types/base models and strength, then verifies the selected version/weight in the form.
The bridge depends on CivitAI's picker structure: an unrecognized UI, unavailable version, or
unverified update produces a visible error instead of selecting a similarly named resource.
See [docs/resource-picker.md](docs/resource-picker.md) for the site contracts and test limits.

Live assistant evaluations are intentionally separate because they spend API credit. They are
fixed to OpenRouter `openai/gpt-5.6-luna` and read only `OPENROUTER_TEST_API_KEY` from the ignored
local `.api_keys` file:

```sh
pnpm test:assistant:live -- --scenario mcp-image-grounding
pnpm test:assistant:live -- --scenario feed-facets
pnpm test:assistant:live -- --scenario feed-resources
CLLP_RUN_LIVE_ASSISTANT_EVALS=1 pnpm test:assistant:live -- --scenario all
```

Targeted scenarios are the normal development path. The all-scenario run needs the additional
opt-in flag. Sanitized reports are written under ignored `.artifacts/assistant-eval/`.

The browser smoke is not self-contained and does not make LLM calls. Its exact prerequisites,
coverage, and current limitations are documented in [docs/browser-smoke.md](docs/browser-smoke.md).

## Privacy and confirmation boundaries

- Provider API keys, the optional CivitAI token, settings, and conversations are stored in the
  browser's local extension storage.
- Provider keys are sent only to their configured xAI/OpenRouter endpoint. The CivitAI token is
  sent only to CivitAI's REST API and fixed official MCP origin.
- User messages and attached images are sent to the selected LLM provider when chatting. CivitAI
  tool queries are sent to CivitAI. The extension does not include an analytics service.
- The newest 250 extension warnings/errors are kept in local extension storage after best-effort
  credential, prompt-field, image-data, and URL-query redaction. Export is user-initiated and uses
  an optional Downloads permission; review the JSON file before sharing it.
- Tool results are bounded before returning to the model. Internal service URLs are removed from
  Site MCP text.
- Page and account writes require a visible user confirmation. Generate always requires a separate
  confirmation because it may spend Buzz.

Review the manifest in `wxt.config.ts` for the current permissions and network origins.

## Content, age restriction, and warranty

<!-- DRAFT: needs author -->
The software is provided as is, without warranty of any kind — see [LICENSE](LICENSE).

Civitai is an adult-permitted platform, so the default system prompt lets the assistant write and
refine explicit prompts where the site allows them, without lecturing or appending warnings. That
default sets three limits that do not move: no sexual content involving minors or characters
presented as minors, in any framing, including "aged up"; no explicit depictions of real,
identifiable people; and no content presenting non-consensual acts as real. On `civitai.com` it
keeps prompts inside that site's PG/PG-13 rules and points you to `civitai.red` for anything past
them. The system prompt is editable in Settings, and replacing it replaces those limits with
whatever you write instead.

The extension itself does no age check and no content gating. What you can reach is set by the
services it talks to and by what you put in Settings: your own OpenRouter or xAI key and chosen
model, under that provider's policies; the Civitai login session in the active tab, plus an
optional Civitai API token, which is what NSFW catalog lookups need; and which of the two Civitai
sites you have open. The set of hosts the extension may contact is fixed in the manifest and is
not a setting.

## License

MIT — see [LICENSE](LICENSE).
