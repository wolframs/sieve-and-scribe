# Civitai projects — consolidation direction (decided 2026-06-16)

> **Status: historical decision and migration record.** It documents why this repository became
> the canonical project, but its implementation recommendations describe an earlier architecture
> and are not a current task queue. Use the
> [living LLM-assistant architecture and evaluation plan](./2026-07-31-llm-assistant-architecture-and-evaluation.md)
> for ongoing work.

## Canonical repo
**`civitai-llm-prompter` is the overlord.** All civitai prompt-crafting work consolidates here.

## What happened to the siblings
- **`civitai-mcp` — DELETED** (local + Forgejo remote, June 2026). It was a hand-rolled CivitAI MCP server that now duplicates the **official civitai.red MCP server**. Killed to avoid future confusion. Do not recreate; lean on the official server instead.
- **`cc_civitai` — ABSORB, then retire.** It's a Claude Code skill (`sdxl-prompt-craft`) holding the real value: expert prompt knowledge for Illustrious XL / Pony V6 / NoobAI-XL / finetunes + LoRA discovery, with reference docs (pony, illustrious, noobai, loras). Migrate that knowledge into this repo, then retire the standalone repo.

## Two surfaces, one brain
Both surfaces are wanted, **browser extension has priority** — because it talks to xAI **and OpenRouter** (OpenAI-compatible), giving full model-picking freedom. The Claude Code skill is Claude-only, so it's the secondary surface.
- Drop `sdxl-prompt-craft` into this repo's `.claude/skills/` → powers the extension's system prompt **and** gives Claude that expertise during dev.
- Lift the model reference docs in as the prompt-craft knowledge layer; replace the generic `default system prompt` in `lib/constants.ts` with it.

## Target stack
1. **civitai.red MCP server** — data/discovery backend (LoRA lookup, trigger words, model metadata).
2. **sdxl-prompt-craft knowledge** — the expertise (from cc_civitai).
3. **civitai-llm-prompter** — the delivery app (browser, OpenRouter), + the skill for in-editor use.

## Next-session checklist
- [x] Copy `cc_civitai/.claude/skills/sdxl-prompt-craft/` → here. *(now `.claude/skills/sdxl-prompt-craft/`)*
- [x] Fold reference docs into the extension's system prompt. *(see below — landed in new `lib/sdxl-knowledge.ts`, re-exported via `lib/constants.ts`)*
- [x] Evaluate pointing `lib/api-client.ts` / data lookups at the official Civitai MCP server. *(evaluation below)*
- [x] Retire `cc_civitai`. **Local working copy deleted (2026-06-16) after confirming clean tree + all commits pushed. The private Forgejo remote is retained as backup.** Delete the remote too once a real `pnpm build` confirms the migration.

---

## Migration log (2026-06-16)

### Knowledge layer landed
- New module **`lib/sdxl-knowledge.ts`** is the prompt-craft brain. It exports `SDXL_PROMPT_KNOWLEDGE` (the expertise distilled from the skill's SKILL.md + illustrious/pony/noobai/loras references), `OUTPUT_CONTRACT`, and the composed `DEFAULT_SYSTEM_PROMPT`.
- `lib/constants.ts` no longer defines the generic prompt; it imports + re-exports `DEFAULT_SYSTEM_PROMPT` (call sites unchanged).
- **Design decision — condensed, not verbatim.** The skill's reference docs were written for a *Claude Code agent that can run `curl`*; their output format is markdown (`**Positive prompt:**` …) and they include API/`curl` discovery recipes. The extension's LLM can do neither: it can't shell out, and its replies are parsed for `<prompt>/<negative>/<params>` XML (`entrypoints/civitai.content/prompt-parser.ts`) to drive "Apply to form". So the knowledge was fused onto that **exact XML output contract** (kept intact, plus `clipSkip`/`aspectRatio`), and the `curl`/API-discovery sections were intentionally dropped — that capability belongs to the MCP path below, not the system prompt. The skill itself (with the full references) lives in `.claude/skills/` and still gives Claude the `curl` recipes during dev.

### Civitai MCP evaluation
**Official endpoints found:**
- Discovery: **`https://mcp.civitai.com/mcp`** (Streamable HTTP, Bearer = Civitai API key) — search/browse models, LoRAs, images, creators, hash lookup.
- Orchestration: **`https://orchestration.civitai.com/mcp`** — generation-focused (`generate_image`, `find_models`, `enhance_prompt`, `chat_completion`, etc.).

**The blocker:** the extension is an **OpenAI-compatible *chat* client**, not an MCP client. `lib/api-client.ts` only does `POST /chat/completions` (streaming) with no tool-calling loop. MCP needs a JSON-RPC-over-Streamable-HTTP client + session handling + a model tool-call orchestration loop. So "point `api-client.ts` at the MCP server" isn't a config swap — it's a feature.

**Recommendation (phased):**
1. **Ship the knowledge layer as-is (done).** It makes the model an expert prompt writer with zero live calls — enough to release. Live LoRA/trigger lookup is an enhancement, not a blocker.
2. **Live discovery via an OpenAI-style tool-calling loop** in `api-client.ts` (pass a `tools` array, loop on `tool_calls`). Two backends to choose between:
   - **(a) Civitai REST direct** — **BUILT 2026-06-16** (`lib/civitai-tools.ts` + `sendMessageWithTools` in `lib/api-client.ts`). Three tools: `search_civitai_loras`, `get_civitai_model` (trigger words), `mine_civitai_prompts`. Same-origin from the content script; optional token in settings (`civitaiApiToken` / `civitaiToolsEnabled`). Gracefully falls back to plain chat when a model rejects the `tools` param. *Still needs a real browser + API key to exercise end-to-end.*
   - **(b) Official Civitai MCP** (`mcp.civitai.com/mcp`) — Civitai maintains the tool surface, but requires implementing a Streamable-HTTP MCP client in-extension and adding `mcp.civitai.com` to host permissions (cross-origin). Graduate to this if Civitai's tool surface outpaces the REST recipes.
3. The **orchestration** MCP (actual image generation) is **out of scope** — this tool crafts prompts to paste into CivitAI's *own* generator; it shouldn't become a generation client.
