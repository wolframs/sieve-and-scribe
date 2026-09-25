# LLM assistant architecture, evaluation, and implementation plan (2026-07-31)

This is the living, canonical plan for the extension's LLM-assistance architecture.
Revise it as implementation evidence changes the design. Keep completed decisions and
verification results here so future sessions do not have to reconstruct them from chat history.

## Objective

Turn the current multi-round research-and-proposal assistant into a testable, efficient,
closed-loop CivitAI agent while preserving the safety boundary that page mutations require user
confirmation and Buzz-spending generation is always a separate confirmation.

The order of work is deliberately **evaluation first**. Every behavioral adjustment should have
a targeted automated scenario before or alongside it, and that scenario should be run directly
after the adjustment rather than relying only on the broad unit suite.

## Verified baseline

At version 1.0.39 on `feat-chat-multimodal-agentic`:

- `sendMessageWithTools` provides a real OpenAI-compatible streaming tool loop with four
  tool-bearing rounds by default, followed by a forced textual completion.
- Five bespoke CivitAI REST tools cover model/LoRA search, model details, prompt mining, article
  search, and article reading.
- Ten page tools cover page/form context, page/chat/generator image viewing, and user-confirmed
  proposals for prompts, source images, feed filters, resources, navigation, and Generate.
- Page-write tools return `proposed` inside the model loop. The mutation happens later through an
  Apply card, and its result is not returned to the model. This is the central closed-loop gap.
- Stable chat-image numbering and explicit source-slot semantics are implemented. Source-image
  upload is confirmed separately and never starts generation.
- The stable default system prompt is approximately 24,400 characters before form context.
  Default-enabled tool schemas add another substantial fixed input on every completion round.
- `pnpm check` passes 93 tests and `pnpm build` succeeds, but the provider stream/tool loop,
  background LLM proxy, chat controller, and live CivitAI tool execution lack direct automated
  behavioral coverage.

## Findings that drive the design

### 1. Approval is outside the agent loop

Action cards are transient UI objects rather than persisted execution state. Apply, failure, and
Dismiss do not produce model-visible results, so dependent actions are planned against stale page
state. Proposed prompt application can also report success without checking every DOM mutation.

### 2. CivitAI capability coverage is narrow

The official Site MCP currently exposes a much larger platform surface. The directly relevant
anonymous browse subset includes model and model-version details, image search and exact image
metadata, creator search, filter-enum discovery, batching, pagination, and AIR identifiers.

The separate Orchestration MCP exposes generation, media analysis, model discovery, prompt
enhancement, workflow management, prompts, and generated-media resources. Discovery and analysis
fit this extension; generation and social/platform writes materially broaden its scope and remain
disabled unless separately approved as product work.

### 3. Website understanding is narrower than page control

The assistant can read form state and feed filters and can view selected images, but it cannot read
the semantic body of the current model, article, creator, comment, or image-detail page. Prefer
route/entity identification followed by structured CivitAI data lookup over arbitrary raw-HTML
scraping.

### 4. Fixed context and persistence costs are avoidable

- Stable knowledge and dynamic form state are currently fused into one system string, weakening
  explicit prompt-cache reuse when form state changes.
- The default tool inventory is sent without regard to the active route or whether a CivitAI tab is
  available.
- Independent parallel tool calls execute serially.
- Stream checkpoints rewrite a full conversation and then the full conversation collection,
  including persisted base64 image data.
- The most recent historical image-bearing message keeps its pixels in future requests until a new
  image-bearing message appears.

### 5. Provider and tool failures are too coarsely classified

Any tool-bearing HTTP 400/404/422 currently triggers a tool-less retry. Invalid images, malformed
schemas, incompatible request parameters, and actual lack of tool support can therefore collapse
into the same behavior. Usage, cache-token, server-tool, request-id, and per-round latency data are
discarded, making failures and costs hard to diagnose.

## Automated evaluation comes first

### Fixed live-test contract

- Provider: OpenRouter.
- Model: `openai/gpt-5.6-luna`.
- Credential: `OPENROUTER_TEST_API_KEY` loaded at runtime from the ignored local `./.api_keys`
  file. Never print, snapshot, persist, or place it in a child-process argument.
- Live tests are opt-in and separate from `pnpm check`, so ordinary unit work never spends API
  credit accidentally.
- The harness must reject the normal `OPENROUTER_API_KEY`; only the spending-capped test-key name
  is accepted.
- Each run records a redacted JSON report containing scenario, model, request count, tool trace,
  durations, token/usage data when available, assertions, and failure text. No prompts containing
  private user data and no authorization headers are recorded.
- Live scenarios use deterministic in-memory tools/page state wherever the external dependency is
  not itself under test. CivitAI network/MCP transport gets its own narrow contract test rather than
  making every model-behavior scenario depend on live site data.

### Harness layers

1. **Deterministic protocol tests (no API spend).** Inject a scripted streaming transport into the
   tool loop and cover fragmented SSE, parallel calls, malformed arguments, abort, round limits,
   unsupported-tool classification, and transient HTTP errors.
2. **Live model behavior evaluations.** Exercise the real OpenRouter model with deterministic mock
   tools and semantically score the resulting tool trace and safety behavior.
3. **CivitAI contract tests.** Independently verify the small public read-only Site MCP surface and
   result normalization. These do not need an LLM call.
4. **Optional browser smoke.** Verify DOM application against a live hydrated CivitAI page only for
   selectors/workflows that cannot be proven below the browser boundary.

### Initial live user stories

Keep the scenarios compact, but require meaningful orchestration:

1. **Grounded LoRA recommendation.** Given an active SDXL-family form and a request for a niche
   style, the model must search, inspect the selected model/version, avoid an unsupported result,
   and propose both a compatible resource and complete prompt without generating.
2. **Image-to-video preparation.** Given `Image 2`, an image-to-video form with an empty source
   slot, and constrained duration/resolution options, the model must inspect the exact image,
   propose the correct source slot, propose a motion-focused prompt using only available controls,
   and not call Generate.
3. **Runtime incompatibility recovery.** A resource proposal receives a deterministic incompatible
   result; after the result is returned to the loop, the model must revise or halt rather than
   continue to Generate or claim success.
4. **Ambiguity before spending.** An underdetermined video request must ask a bounded model/workflow
   question or produce a pending question state; it must not choose an expensive workflow and run
   generation silently.
5. **Tool failure degradation.** A lookup returns a bounded error. The assistant should preserve the
   useful prompt task, disclose the missing grounding, avoid invented IDs/trigger words, and finish
   without an infinite/repeated-call loop.

The first implementation slice may begin with stories 1, 2, and 5 because they exercise the
existing architecture. Stories 3 and 4 become required gates for the approval-continuation and
`ask_user` work that follows.

### Assertions

Avoid brittle exact prose checks. Assert observable behavior:

- ordered or partially ordered tool names and arguments;
- maximum call/round counts and absence of repeated identical failures;
- exact image number and generator slot;
- IDs and trigger words must originate in tool results;
- proposed parameters are a subset of the supplied form contract and within ranges;
- action risk invariant: no `propose_generate` unless the scenario explicitly requests it, and no
  direct mutation tool exists;
- final response acknowledges tool errors and does not claim a failed action succeeded;
- structured prompt output parses into a non-empty prompt where the story calls for one.

Use a small semantic rubric only where trace assertions cannot express the outcome. Keep the raw
model answer in the local redacted report for diagnosis, but do not make stylistic wording a pass
condition.

### Commands and spending guard

Planned commands:

```bash
pnpm test:assistant:protocol
pnpm test:assistant:live -- --scenario grounded-lora
pnpm test:assistant:live -- --scenario image-to-video
pnpm test:assistant:live -- --scenario tool-failure
CLLP_RUN_LIVE_ASSISTANT_EVALS=1 pnpm test:assistant:live -- --scenario all
```

The all-scenarios command must require an explicit opt-in environment flag in addition to the key.
Targeted single-scenario runs are the normal development workflow.

### Step 1 implementation evidence (version 1.0.40)

Implemented on 2026-07-31:

- `sendMessageWithTools` accepts an injected streaming transport while production continues to
  default to the background-routed extension proxy.
- Six deterministic protocol tests cover fragmented SSE, parallel tool-call assembly, consecutive
  tool results before image turns, forced tool-free completion, abort propagation, narrow
  unsupported-tools fallback, and preservation of unrelated 400 errors.
- The paid evaluator loads only `OPENROUTER_TEST_API_KEY` from `./.api_keys`, fixes the model to
  `openai/gpt-5.6-luna`, runs serially with no retries, writes ignored mode-600 redacted reports,
  and requires an extra environment flag for the all-scenarios command.
- Grounded-LoRA, Image-2-to-video, and lookup-failure scenarios ran targeted and passed. The tests
  assert structured trace/state invariants rather than exact prose and use deterministic CivitAI
  and page fixtures.
- Usage callbacks request and capture provider usage/cost chunks. In the final guarded suite, the
  image-to-video story used three completions, 26,368 prompt tokens, 545 completion tokens, and
  approximately USD 0.000633. The repeated fixed prompt/tool inventory is therefore a measured optimization
  target rather than a speculative one.

The evaluator immediately found and drove two production adjustments:

1. Luna initially supplied sampler, seed, and video-only arguments to an Illustrious form that did
   not expose those controls. `propose_prompt` schemas are now tailored to live form capabilities,
   and action-card creation independently filters stale or invented fields against a fresh form
   snapshot.
2. One grounded run inspected correct model details but omitted the exact trigger word. Model-detail
   results now include an explicit positive-prompt instruction alongside structured trigger words;
   the targeted scenario passed after that change.

Evaluation interpretation refinements retained in the harness:

- A fresh `get_page_context` call is not required when the controller has just injected the same
  live form state into system context; valid proposals against that snapshot are sufficient and
  avoid a redundant completion/tool call.
- On lookup failure, either a `propose_prompt` action or the extension's normal structured XML
  prompt card satisfies useful degradation. Resource IDs and trigger words remain strictly
  forbidden without grounding.
- Capability-aware prompt-field schemas and usage capture were pulled forward from Step 5 because
  Step 1 produced direct evidence for them.

Final Step 1 verification on version 1.0.40:

- guarded serial live suite: 3/3 Luna scenarios passed in 35.69 seconds;
- aggregate live usage: 96,120 prompt tokens, 1,705 completion tokens, 97,825 total tokens,
  approximately USD 0.002114;
- `pnpm check`: 14 files and 101 tests passed;
- `pnpm build`: Chrome MV3 production build passed.

## Target architecture

### Provider adapter

Own request dialect, streaming parsing, cache/session identifiers, capability-aware request fields,
usage metadata, and structured error classification. Chat Completions remains supported; xAI or
OpenRouter Responses support can be added behind the adapter rather than branching throughout the
controller.

### Context assembler

Build separately addressable blocks:

1. protected operational and safety contract;
2. relevant model-family knowledge;
3. user-editable instructions;
4. dynamic page/form state;
5. rolling conversation or summary;
6. persisted active-plan/action state.

This preserves prompt-cache boundaries and prevents user customization from silently replacing the
tool and output contracts.

### Small tool registry

Keep locally owned REST/page tools explicit. For the official CivitAI Site MCP, use the live tool
name, schema, and annotations rather than mirroring the server in source code. Annotated reads may
run immediately. A missing or false `readOnlyHint` is a write: it is hidden in read-only mode and
becomes one generic, persisted confirmation card in full mode. `destructiveHint` adds a warning;
it does not require a second policy framework.

### Approval continuation state machine

Persist proposed actions with an ID, originating assistant/tool call, dependencies, status, and
verified result. Applying or dismissing an action creates an `action_result` continuation. The
model then re-reads effective page state and may revise the unexecuted tail. Generate remains a
standalone confirmation regardless of plan approval.

### CivitAI adapters

- Site MCP: background-side Streamable HTTP client, cached live schemas, dynamic annotated reads,
  generic confirmed writes, bounded outputs, and token sent only to CivitAI.
- Existing REST/article adapters: retain when they expose useful data absent from MCP.
- Orchestration: optional discovery/analysis allowlist only in the initial product scope.
- Current page: resolve route/entity identifiers and use structured APIs before considering bounded
  semantic DOM text extraction.

## User-facing configuration direction

Expose product concepts rather than low-level transport knobs:

- research access: CivitAI catalog, general web search, orchestration analysis;
- research depth: Quick, Balanced, Deep;
- per-conversation provider/model and reasoning effort;
- confirmation policy for non-spending edits, with Generate always confirmed;
- context strategy: rolling turns, rolling summary, approximate token budget;
- image detail, resize, and pixel-retention policy;
- mature lookup default;
- user instructions separate from protected base behavior;
- provider privacy/routing controls and clear data-flow disclosure;
- CivitAI OAuth/account identity for distributable use;
- real custom-provider support, or removal of the currently unreachable custom-provider type.

## Step-wise implementation order and gates

### Step 0 — Persist this plan

- Add and maintain this file.
- Gate: normal checks/build, clean commit, push.

### Step 1 — Build the evaluation seam and harness

- Extract/inject provider streaming transport without changing production behavior.
- Add deterministic protocol tests for the loop and fallback classification.
- Add the opt-in OpenRouter live evaluator and initial stories 1, 2, and 5.
- Run each scenario targeted with `openai/gpt-5.6-luna`, then run the small suite once.
- Gate: protocol tests, live scenario assertions, `pnpm check`, build, clean commit, push.

### Step 2 — Close the approval loop

- Persist actions and their results.
- Verify each DOM mutation rather than treating invocation as success.
- Resume the model after Apply/Dismiss/failure.
- Enable and pass recovery story 3.
- Gate: targeted protocol/live tests, normal checks/build, commit, push.

Step 2a implementation note (version 1.0.41): prompt-action invocation and verification were
extracted behind a deterministic seam. Every requested setter must succeed and the effective form
snapshot must match the positive prompt, optional negative prompt, and every requested parameter
before the page bridge can report success. This closes the known false-success path and provides
the trustworthy `applied`/`failed` boundary needed by the persisted continuation coordinator.
Action IDs/status, Generate dependency gating, restore, and model continuation remain Step 2b.

Step 2b checkpoint 1 (version 1.0.42): actions now receive stable IDs and persist with
`pending`, `applying`, `applied`, `failed`, `unknown`, or `dismissed` status. Apply/Dismiss routes
through the controller, terminal actions are idempotent, lost acknowledgements become `unknown`
and are never retried, interrupted `applying` records restore as `unknown`, and cards restore with
their effective status. Generate proposals are conservatively rejected while any non-Generate
action is not verified `applied`. The controller's conversation I/O is injectable so these state
transitions run deterministically without browser-RPC emulation. Trusted action-result model
continuation and explicit dependency release remain the next checkpoint; until then Generate
blocking intentionally favors safety over recovery flexibility.

Step 2b checkpoint 2 (version 1.0.43): resolving or dismissing an action now persists its terminal
state before starting a continuation through the normal controller turn. The continuation is a
hidden `[TRUSTED EXTENSION ACTION RESULT]` event containing the stable action ID, authoritative
status/error, and fresh effective page context; source-image bytes are redacted from the event.
It reuses normal provider/settings loading, rolling context, streaming, tools, and persistence, and
does not render a fake user message. Internal events do not count against the user-turn rolling
window. Deterministic coverage proves a failed result is already durable when continuation starts
and that the follow-up assistant response is persisted. The next gate adds full scripted
failed/success Generate behavior and the two targeted Luna approval scenarios.

Step 2 completion (version 1.0.44): scripted production-loop tests and targeted Luna evaluations
now cover both approval outcomes. A failed verified write is persisted before continuation,
`propose_generate` receives a structured blocked result, and no Generate card or submission is
created. A verified successful write resumes Luna and permits exactly one distinct pending Generate
card; the prompt approval itself leaves the submission counter at zero. Corrective proposals carry
explicit supersession links: failed/unknown/dismissed chains keep blocking while a replacement is
pending or unsuccessful, and release only when the chain ends in a verified applied replacement.
This removes the temporary permanent-block limitation without weakening the spending boundary.

Final Step 2 live verification on version 1.0.44:

- guarded serial Luna suite: 5/5 scenarios passed in 72.79 seconds;
- both approval stories required five completion requests and three tool calls;
- aggregate suite usage: 173,497 prompt tokens, 2,630 completion tokens, 176,127 total tokens,
  approximately USD 0.007460;
- approval failure: one prompt mutation attempt, zero Generate submissions, no Generate card;
- approval success: one verified prompt mutation, one separate pending Generate card, zero Generate
  submissions until a second explicit approval.

Step 2 safety completion (version 1.0.45): the ordinary XML prompt-card Apply/Append controls no
longer bypass the action state machine. Assistant messages now have stable persisted IDs; the
controller reloads the source message from conversation storage, materializes Append as one complete
desired form state, and persists an inline action before invoking the same postcondition-verified
page-action executor. The source-message/mode key makes repeated Append idempotent. Successful,
failed, and lost-acknowledgement outcomes resume the model through the trusted continuation; inline
actions stay out of the card list because the original Apply/Append click was already the user
confirmation. The obsolete best-effort `applyToForm` page-bridge mutation was removed. Targeted
deterministic coverage passed for Apply, capability-filtered Append, duplicate suppression, and
unknown-without-retry. The targeted Luna `manual-apply` story passed in 7.50 seconds with two
completion requests, one separate pending Generate proposal, zero Generate submissions, 15,600
tokens, and approximately USD 0.000243.

### Step 3 — Add one structured question interaction

- Add `ask_user`, bounded options, persisted answer/resume semantics.
- Enable and pass ambiguity story 4.
- Defer `propose_model`, explicit workflow selection, and living multi-action plans until a tested
  user story demonstrates that ordinary questions plus existing proposal cards are insufficient.
- Gate: targeted live stories, normal checks/build, commit, push.

Step 3 implementation (version 1.0.48): `ask_user` is one additional persisted action kind with a
300-character question and two to four bounded, deduplicated options. Pending questions survive a
panel remount and block Generate; a selected option is saved before any provider continuation and
resumes through a dedicated trusted answer event. The answer itself approves no page mutation.
Dismiss uses the existing continuation path. The UI renders simple choice buttons plus Dismiss;
there is no plan engine, generic interaction framework, or custom-input sub-form.

Deterministic coverage verifies normalization, malformed choices, Generate blocking, idempotent
answers, invalid indices, persistence-before-continuation, and a scripted ask-answer-prompt tool
loop with zero page writes. Targeted OpenRouter `openai/gpt-5.6-luna` `ambiguity-question` passed
in 14.16 seconds: five requests, 38,555 prompt tokens, 533 completion tokens, one three-option
question, one persisted anime selection, one subsequent pending prompt, no Generate proposal, no
page mutation, and USD 0.001636245 reported cost.
Final repository gates passed: `pnpm check` ran 136 tests with two opt-in tests skipped; Chrome MV3
and Firefox MV2 production builds completed. Firefox still emits WXT's existing
`data_collection_permissions` release warning and remains a development, not release-validated,
target.

### Step 4 — Integrate the official CivitAI Site MCP without mirroring it

- Discover the official endpoint's current inventory and schemas in the background.
- In read-only mode, advertise every tool with `readOnlyHint: true`.
- In full mode, also advertise all other tools; calls to them produce one generic confirmation card
  showing the tool name and exact arguments. Execute only after Apply and return the bounded result
  through the trusted continuation loop.
- Treat a missing annotation as write. Show a prominent warning when `destructiveHint` is true.
- Forward the optional CivitAI token only to CivitAI's REST API and fixed MCP origin, enabling
  private/account reads and confirmed account actions without exposing the credential to the LLM.
- Retain transport timeouts, response bounds, internal-URL scrubbing, and one live contract smoke.
- Do not maintain aliases, copied schemas, argument allowlists, or a per-tool policy/UI registry.
- Retain richer bespoke REST tools while they provide useful structured workflows; remove overlap
  only when measured behavior shows no functionality loss.
- Gate: deterministic discovery/confirmation tests, public MCP contract, grounded Luna story,
  normal checks/build, commit, push.

Step 4 initial adapter (version 1.0.46): live discovery confirmed that the anonymous stateless
endpoint currently returns 53 tools, including platform writes, deletes, direct messages, uploads,
bounties, and moderator operations. The extension now fixes the endpoint in its background worker
and filters by the seven-name browse allowlist in code; only four non-overlapping assistant aliases
are advertised initially: model-version/AIR detail, image search, exact image detail, and creator
search. Live schemas are cached for one hour and tightened to ten search results, five batch IDs,
bounded queries/cursors, an 18-second timeout, and a one-megabyte transport ceiling. Tool text is
scrubbed, capped at 12,000 characters, and wrapped as untrusted Civitai reference data; raw
`structuredContent` and the configured user token are never forwarded.

Deterministic tests cover exact allowlisting, schema drift failing closed, JSON and SSE transport,
argument/result bounds, internal-URL scrubbing, MCP error envelopes, and controller dispatch. The
no-key public contract passed 2/2 checks against initialize, all seven live browse schemas, a narrow
enum call, and normalized creator search. The targeted Luna `mcp-image-grounding` story passed in
9.26 seconds: three completions, ordered image search then exact ID 4242 inspection, grounded prompt
content, no Generate proposal, no page mutation, 25,955 tokens, and approximately USD 0.000504.
The richer structured REST model/LoRA tools remain authoritative until explicit parity tests support
replacement.

Step 4 simplification (version 1.0.47): the seven-name allowlist, four aliases, copied schemas, and
per-tool sanitizers were removed after maintainability review. The extension now follows the live
official inventory using the three user-facing modes Off, Read-only, and Full with confirmation.
Every annotated read is available immediately; every other tool uses the same generic persisted
confirmation and trusted result continuation. MCP calls use the configured CivitAI token only at
the fixed official endpoint. Deterministic tests cover dynamic discovery, missing annotations,
destructive labeling, unchanged server arguments, token routing, read dispatch, and write
confirmation. The live contract intentionally checks annotation behavior and a representative
call instead of pinning a server-owned inventory. Final verification: `pnpm check` passed 129
tests with two opt-in tests skipped; the live public MCP contract passed 2/2; the Chrome MV3 build
passed; and targeted OpenRouter `openai/gpt-5.6-luna` `mcp-image-grounding` passed in 10.89 seconds
with three requests, 25,548 prompt tokens, 338 completion tokens, no Generate proposal, no page
mutation, and USD 0.0014474 reported cost.

### Step 5 — Reduce cost and latency without reducing capability

- Split cacheable and dynamic context blocks; add provider conversation/session cache keys.
- Route only relevant tools; parallelize independent reads; detect repeated calls.
- Bound result/image budgets and improve image retention.
- Capture usage, latency, and provider request IDs in redacted diagnostics.
- Gate: the same live stories must keep passing with equal or fewer requests/tokens where provider
  usage data permits comparison.

Step 5 measured slice 1 (version 1.0.49): OpenRouter request bodies now carry the opaque persisted
conversation ID as `session_id`, preserving provider/cache stickiness even after rolling context
changes which user message opens the transmitted window. Usage capture now records cached tokens,
cache-write tokens, cache discount when supplied, and serialized request bytes. These fields stay in
the ignored redacted evaluation reports and do not add production telemetry.

A controlled targeted `ambiguity-question` pair passed with identical behavior and zero mutations:

- stable session: four requests, 30,654 prompt tokens, 30,220 cached tokens, 422 cache-write tokens,
  9.72 seconds, USD 0.00059975;
- session omitted: five requests, 38,513 prompt tokens, 37,975 cached tokens, 523 cache-write tokens,
  14.27 seconds, USD 0.000762225.

Do not treat the different tool-round count as causal from one stochastic A/B run. The important
measurement is that both variants already reported about 98.6% cached input during a short stable
conversation. Keep the stable session key for rolling-window/provider stickiness, but defer system
prompt truncation, speculative tool pruning, Responses migration, and other functionality-risking
work until multiple scenario reports show an actual uncached-token or latency problem.

Current-state revalidation (version 1.0.50, 2026-08-15): the targeted Luna
`mcp-image-grounding` story passed all six assertions in 11.28 seconds. Four completion requests
called `search_images`, inspected returned image ID 4242 with `get_image`, then read page context;
there was no Generate proposal and no page mutation. OpenRouter reported 34,615 prompt tokens,
25,860 cached tokens, 8,743 cache-write tokens, 470 completion tokens, and USD 0.001634675 cost.

Cross-cutting production diagnostics (version 1.0.51): extension-owned warnings, errors, uncaught
errors, and unhandled rejections now flow through the background into a newest-250 local journal.
Values are bounded and best-effort redacted before persistence; Settings can export a reviewable
JSON file or open its Downloads location using an optional, user-triggered Downloads permission.
This is deliberately separate from the live evaluator's provider usage reports: it adds no
telemetry, network sink, prompt logging, or automatic upload.
Targeted tray/diagnostic tests passed 9 assertions; `pnpm check` passed 145 tests with two opt-in
tests skipped; Chrome and Firefox production builds passed; and the isolated live-browser smoke
passed 17/17, including a real detail-tag pickup, 32px direct tray assignment, and warning capture
from the CivitAI content script through background persistence to the Settings count.

Feed metadata filtering slice (version 1.0.52): keep tags as the primary surface and put secondary
facets behind one compact `More filters` row with an active summary. The first implemented facet
schema covers creator include/exclude, portrait/square/landscape, minimum total reactions/views/
comments/collections, generation-metadata presence, and CivitAI-generation provenance. It is
explicit URL state, composes with tag groups/exclusions, participates in response-cache identity,
uses the existing bounded cursor walk even without an AND-tag driver, survives v1 tag-only presets,
and is included in page context and `propose_feed_filter` confirmation cards.

The targeted Luna story exposed two useful harness behaviors. Optional numeric schema fields with
a minimum of one encouraged the model to invent `1` constraints, so the contract now tells models
to serialize unrequested minima as zero and execution normalizes non-positive values to unset. A
repeated identical successful `propose_*` call is now executed only once per assistant turn; later
duplicates receive `already_proposed`, preventing duplicate confirmation cards without caching
reads or failed proposals. Deterministic facet, preset-migration, envelope/cursor, page-tool, and
proposal-dedup tests passed. The final targeted `feed-facets` Luna run passed 8/8 assertions in
5.70 seconds with three requests, 26,198 prompt tokens, 17,340 cached tokens, 8,849 cache-write
tokens, 169 completion tokens, no unrequested active constraints, no Generate proposal, no page
mutation, and USD 0.001381825 reported cost. The isolated browser smoke passed 19/19.

Resolved resource slice (version 1.0.53): the same secondary editor now searches CivitAI only while
the user types in the model/resource picker. A selection stores the exact model-version ID plus a
bounded label snapshot in URL state and presets. Filtering compares those IDs with each feed item's
existing `modelVersionId`/`modelVersionIds`; it never enriches or looks up individual cards. The
three supported semantics are exact primary model, any required selected resource, and any excluded
resource. `propose_feed_filter` accepts the same grounded references. The targeted Luna
`feed-resources` story passed 7/7 assertions in 10.04 seconds with four requests, two grounded
CivitAI searches, 36,004 prompt tokens, 26,716 cached tokens, 9,276 cache-write tokens, 522
completion tokens, one unapproved filter proposal, no page mutation, no Generate proposal, and USD
0.00174106 reported cost. `pnpm check` passed 160 tests with two opt-in skips; Chrome and Firefox
production builds passed; and the isolated live-browser smoke passed 20/20 after its CORS-revealing
first attempt led the picker to use the current CivitAI origin instead of a cross-site credentialed
request.

Prompt-text, tool/technique, dates, media type, moderation flags, and per-reaction-type filters
remain deliberately deferred until a concrete user story justifies their UI and data cost.

UX correction (version 1.0.54): remove the viewport-height cap and outer overflow container from
the feed-filter panel. The panel now grows to its natural height; only intrinsically long lists
(tag suggestions and model/resource results) scroll, avoiding nested scroll regions.

### Step 6 — Improve persistence and settings

- Store conversations individually and move large image bytes out of the monolithic array.
- Add rolling summaries and the user-facing controls above in small, separately tested slices.
- Gate each slice with targeted behavior tests, normal checks/build, commit, and push.

### Step 7 — Optional provider-native web and Orchestration analysis

- Add only behind explicit settings and cost/privacy disclosures.
- Keep CivitAI tokens out of third-party provider requests by default.
- Do not expose generation or platform-write MCP tools as an accidental consequence of dynamic
  discovery.

## Invariants

- Never send or log API keys except to their intended endpoint in an authorization header.
- Never use the normal OpenRouter key for automated live tests.
- Never execute a dynamically discovered write/destructive tool without a persisted, explicit user
  confirmation showing the tool name and arguments.
- Never represent a proposed or invoked page action as verified success without a postcondition.
- Never bundle Buzz-spending Generate with another approval.
- Never make cloud generation a prerequisite for useful local behavior tests.
- Every coherent extension change bumps the version, runs relevant targeted tests plus
  `pnpm check` and `pnpm build`, commits, and pushes to `origin`.

## Decision log

- 2026-07-31: Automated end-to-end LLM behavior evaluation is the first implementation priority.
- 2026-07-31: Live evaluator is fixed to OpenRouter `openai/gpt-5.6-luna` and the local
  `OPENROUTER_TEST_API_KEY` spending-capped credential.
- 2026-07-31: This file is explicitly authorized as a living plan and may be revised as future
  implementation evidence changes priorities or design details.
- 2026-08-05: Close the discovered inline Apply/Append verification bypass before widening tools,
  then pull the anonymous Site MCP adapter ahead of structured questions because MCP coverage is the
  user's primary architecture concern and the bounded read-only tranche is independently testable.
- 2026-08-06: Replace the conservative Site MCP allowlist with the official server's live schemas
  and annotations. The maintainable safety boundary is generic write confirmation, not a second
  hand-maintained copy of CivitAI's capability catalog.
- 2026-08-06: Keep Step 3 to one persisted `ask_user` interaction. Defer model/workflow proposal
  types and living-plan machinery until measured user stories justify their maintenance cost.
- 2026-08-06: Fast-forward the completed 1.0.47 assistant checkpoint to `main` after deterministic,
  live MCP contract, targeted Luna, and build gates passed. Do not invent a release tag/store
  release without an established packaging and publication convention; continue `ask_user` on a
  fresh feature branch.
- 2026-08-06: Add OpenRouter session stickiness and cache/body accounting as the first measured
  efficiency slice. Current Luna runs already cache nearly all repeated input, so do not optimize
  raw prompt-token totals by deleting knowledge or tools without evidence of uncached cost.
- 2026-08-16: Keep feed facets in a compact secondary editor, persist them in explicit URL state
  and backwards-compatible presets, and top up sparse facet-only feeds through bounded cursors.
  Treat identical successful proposal calls as idempotent within one assistant turn.
- 2026-08-16: Resolve model/resource filters only at selection time, persist version IDs with label
  snapshots, and match existing feed payload fields rather than enriching every card.
- 2026-08-16: Prefer the feed-filter panel's natural height over an outer viewport scroll region;
  keep scrolling local to long result lists.
