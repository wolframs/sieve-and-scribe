# Multi-step agentic execution (2026-07-20)

> **Status: historical predecessor plan.** This analysis remains useful context for `ask_user`
> and revisable workflows, but its snapshot of implemented behavior is no longer current. Active
> gaps, ordering, and verification evidence belong in the
> [living LLM-assistant architecture and evaluation plan](./2026-07-31-llm-assistant-architecture-and-evaluation.md).

## Goal

Let the user hand the agent an underdetermined, multi-step job and have it carry the job
through — asking when it genuinely doesn't know, and revising when the page tells it something
it couldn't have known up front.

Motivating case: *"here's an image, make me a video out of it, moody and cinematic."* The agent
should work out that this needs image-to-video, ask which video model family fits (the
trade-offs differ enormously), research LoRAs for the look, fill the generator in, and stop
short of spending Buzz.

None of that is possible today. This document says why, and what to build.

## What's already there (verified 2026-07-20, not assumed)

- **The tool loop is already multi-round.** `sendMessageWithTools` in `lib/api-client.ts` runs
  up to `maxToolRounds` (default 4) rounds of tool calls per user turn, so read-chains like
  search → trigger words → mine prompts already work. Raising the cap is one line.
- **The image-to-video form is injectable.** In that mode the form is Model (defaults to Kling
  Video v2.5 Turbo), Prompt, Negative Prompt, the normalized CFG, Seed, and duration radios
  [5, 10]. No aspect ratio — it inherits that from the source image. The source image goes in
  through a real `<input type="file" accept="image/png,image/jpeg,image/webp" multiple>`, so it
  can be set with a `DataTransfer` + `change` dispatch. Bytes can come from a chat attachment, a
  page image, or a CivitAI CDN URL fetched via the background worker (which already holds host
  permissions for the LLM proxy).
- **Mode switching is drivable but fiddly.** The media-type buttons carry clean `aria-label`s
  (`Image` / `Video` / `Audio` / `3D Models`), but the Video button opens a *submenu* — Create
  Video, Image to Video, First/Last Frame, Reference to Video, Upscale, Interpolate, Edit Video
  — so reaching text-to-video or i2v is two interactions. Programmatic `.click()` does not open
  it; real pointer events are required, the same lesson as the resource picker's search.

## The core problem: constraints are discovered at runtime

A static, up-front plan is wrong **in principle**, not merely awkward.

CivitAI hides resources whose base model doesn't match the loaded checkpoint — confirmed live
when an SDXL LoRA silently refused to attach to a Z-Image checkpoint. So whether step 4 (attach
LoRA) is even possible depends on how step 2 (choose model) resolved. The agent cannot know at
plan time. Underdetermined prompts surface this sooner, but it holds for fully specified ones
too.

The second problem compounds it: **every write today is fire-and-forget.** `propose_*` returns
"proposed" and the mutation happens later, when the user clicks Apply, after the turn has
ended. The model never learns whether it worked. There is no feedback path from Apply back into
the conversation — that absence is the single biggest gap.

Both rejected alternatives fail on this:

- *One Apply card per write* — six clicks for a six-step job, and the agent still can't react to
  any of them.
- *A frozen batch plan* — one click, but it commits to decisions that later steps may invalidate,
  and it can't incorporate a revision or a new input mid-flight.

## Design: the plan is a living object

### A. Plan state

A persisted plan object: an ordered list of steps, each with a status
(`pending` / `applied` / `failed` / `skipped`) and its failure reason when it has one. The agent
can rewrite the unexecuted tail between steps, because it sees the results of the executed head.

**Re-inject the plan into every request**, the way `buildSystemPrompt` already injects form
state. Rolling context defaults to 20 turns (`lib/constants.ts`), and a
plan → execute → ask → revise cycle burns turns quickly; a plan living only in the transcript
would roll out of the window and the agent would quietly lose the brief.

### B. `ask_user`

A tool that poses a structured question with concrete options and does **not** end the plan —
the state persists, the answer resumes execution rather than restarting the reasoning.

The option sets are already written: `lib/sdxl-knowledge.ts` and
`.claude/skills/sdxl-prompt-craft/references/video.md` document the real trade-offs (cheap,
stylized, with audio → LTX; open realism with LoRAs and NSFW → Wan 2.1 in-house; maximum
fidelity, PG, expensive → Kling / Veo 3 / Sora 2). That is a well-formed multiple choice with
genuine consequences behind each branch, not a vague "what would you like?".

Worth building **first**: it stands alone and fixes "which video model?" today, with no plan
machinery at all.

### C. A revisable card

Per-step controls — each step individually skippable and editable before execution, so Apply is
never all-or-nothing.

**Generate is never bundled.** It spends Buzz. It stays its own explicit confirmation even
inside an approved plan.

### D. Three missing DOM tools

Each is a bounded automation of the kind `attachResource` already proved out, and each is
verifiable live on the rig:

- `propose_mode` — media type plus sub-mode (two interactions, real pointer events).
- `propose_model` — drive the Swap picker. Same modal shape as the resource picker, so the
  keyboard-event and per-card Select-button lessons carry straight over.
- `propose_source_image` — file-input injection for image-to-video.

## When does planning engage?

Mechanically, not by vibes: **two or more write actions with ordering dependencies between
them.** A single write behaves exactly as it does today.

Plus a **user-side plan-mode toggle in the composer**. This is what de-risks the heuristic — with
a manual override the system prompt only has to be right in the default case, which is a far
easier bar than getting it right every time.

## Build order

Smallest first; each step is useful on its own even if the next never happens.

1. `ask_user` — immediately valuable, no plan machinery required.
2. `propose_mode`, `propose_model`, `propose_source_image` — each verified live before moving on.
3. The plan object: per-step status, revisable tail, re-injection into every request.
4. The plan-mode toggle and the system-prompt trigger rules.

## Open questions

- Does `ask_user` render as an action card, or as a distinct question affordance in the composer?
- How many steps before a plan is too long to review honestly? A cap may be healthier than
  trusting the agent's restraint.
- Image-to-video is the first mode needing a source image, but First/Last Frame and Reference to
  Video (up to 7 images) have their own shapes. Worth mapping before generalising
  `propose_source_image`.
- Should a failed step halt the plan by default, or fall through to the agent for a decision?
  Halting is safer; falling through is what makes it feel agentic.
