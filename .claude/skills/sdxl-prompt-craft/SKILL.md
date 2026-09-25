---
name: sdxl-prompt-craft
description: >
  Craft expert-level image AND video generation prompts for the 2026 CivitAI model landscape:
  anime SDXL families (Illustrious XL incl. v3.x, NoobAI-XL, Chenkin Noob XL, Pony Diffusion V6
  and their finetunes — WAI, Hassaku, Nova Anime XL, JANKU, T-Ponynai3), the natural-language
  image models (Flux.2 incl. Klein, Flux.1, Qwen-Image, Z-Image, Krea 2, Chroma, Pony V7, Anima,
  Neta Lumina), and video models (LTX 2/2.3, Wan 2.x, Hunyuan, Kling, Veo 3, Sora 2). Use this
  skill whenever the user wants to generate image or video prompts, write booru-style tags,
  craft prompts for any Stable Diffusion / Flux / DiT model, or asks for help with Danbooru/e621
  tagging for AI art. Also trigger when the user mentions: "prompt for", "image gen", "txt2img",
  "img2vid", "write me a prompt", "generate an image of", "make a video of", "SD prompt",
  "tag this", "booru tags", "LoRA", "trigger words", "find a LoRA", "what LoRA", "character
  LoRA", "style LoRA", or references any model name above. This skill does NOT call generation
  APIs — it writes optimized text prompts. It CAN query the Civitai API to discover and look up
  LoRAs, trigger words, and example prompts when a CIVITAI_API_TOKEN is available.
---

# CivitAI Prompt Craft (2026)

You write prompts for image and video generation models, leveraging deep knowledge of how each
family was trained and what prompting style it responds to. The families have **incompatible
syntax** — booru tags that boost one model are inert or actively harmful on another.

> Scope note: the directory is still named `sdxl-prompt-craft` for historical reasons, but the
> skill covers the whole 2026 landscape, not just SDXL.

## Step 1: Identify the target model's prompting class

This is the single highest-leverage decision. Ask only if genuinely ambiguous; otherwise infer.

**Class 1 — TAG-BASED.** Booru tags, quality prefixes, and attention weights all work.
Anime SDXL: Pony V6, Illustrious, NoobAI and their finetunes (WAI-illustrious, Hassaku XL,
Nova Anime XL, JANKU, Obsession, T-Ponynai3, Chenkin Noob XL). Also Neta Lumina (tags OR natural
language, never mixed) and Anima (accepts both).
→ `references/illustrious.md`, `references/noobai.md`, `references/pony.md`

**Class 2 — NATURAL-LANGUAGE.** Sentences; NO quality-tag spam, NO `(tag:1.2)` weights,
negatives often ignored. Flux.1, Flux.2 (incl. Klein), Qwen-Image, Z-Image, Krea 2, Chroma
(hybrid — also takes tags), Pony V7, HiDream / SD 3.5 (legacy), and the closed partner models
(Imagen 4, Nano Banana, GPT Images, Grok Imagine, Seedream, Reve, Wan Image, Lens).
→ `references/natural-language-models.md`

**Class 3 — VIDEO.** Always natural-language cinematic description. LTX 2/2.3, Wan 2.x, Hunyuan,
and partner APIs (Kling, Veo 3, Sora 2, Grok Video, Seedance, HappyHorse, Vidu).
→ `references/video.md`

**The two failure modes to avoid.** Writing `masterpiece, best quality, 1girl` for a class-2
model is a real failure — Flux-family models read prompts literally and may render those words
as visible text in the image. Conversely, writing a flowing paragraph for an SDXL finetune
wastes most of its tag-trained capacity.

**Two traps where the family name lies to you:**
- **Pony V6 vs V7** — completely different architectures. V6 needs the full `score_9…` string;
  V7 is AuraFlow-based where score tags are deprecated and unreliable. Never carry V6 advice to V7.
- **"Hassaku (Anima)" is not SDXL** — it's the DiT-based Anima family. Plain "Hassaku XL" is
  Illustrious.

When unsure among anime SDXL, default to **Illustrious** — it remains the ecosystem default.

## Step 2: Read the reference, then construct

Always read `references/loras.md` when the user mentions LoRAs, asks about trigger words, wants
to discover LoRAs, or when you want to suggest one. LoRA compatibility is strictly
per-architecture and getting it wrong wastes the user's Buzz.

**Ground LoRA claims in live data.** Never invent LoRA filenames, trigger words, or version ids.
Look them up via the Civitai API (recipes in `references/loras.md`); if you can't, say so.

## Step 3: Output format

```
**Model:** [target model name and family]
**Recommended settings:** [resolution/aspect, steps, CFG, sampler, clip skip — only params this model exposes]

**Positive prompt:**
[the prompt in the model's native style]

**Negative prompt:**
[negative tags — or "not used: this model ignores negatives at CFG 1"]

**LoRAs (if applicable):**
[name, weight, trigger words, Civitai link]

**Notes:** [settings tweaks, alternatives, model-choice rationale]
```

Only list parameters the target model actually exposes. Distilled models (Flux.2 Klein,
Z-Image Turbo) hide CFG and sampler; video models use a normalized CFG slider; Clip Skip is an
SDXL-family concept and is meaningless on DiT models.

## Model choice heuristics

- Anime/illustration with precise tag and artist control → SDXL families (Anima or Neta Lumina
  for the modern-architecture flavor)
- Photorealism / aesthetic frontier → Krea 2 or Qwen-Image
- Legible text or logos in-image → Qwen-Image (quoted text, CFG 7) or Flux.2
- Speed and cheap iteration → Flux.2 Klein or Z-Image Turbo
- Uncensored realism → Chroma or the SDXL/Pony families
- Video: cheap/stylized/with audio → LTX · open realism, humans, LoRAs, NSFW → Wan 2.1
  (in-house) · physics showcase → Hunyuan · maximum fidelity, PG → Kling / Veo 3 / Sora 2
- HiDream and SD 3.5 exist but are fading — don't recommend them fresh.

**Anime video has no first-class model.** The community path is: generate the still with an
anime SDXL model, then animate it via image-to-video (Wan plus an anime-style LoRA).

## Style & tone when crafting prompts

- Be creative and vivid. Don't just list the obvious — composition, framing, lighting, and
  palette change impact more than adding nouns.
- Think about what makes an image *compositionally interesting*, not merely content-complete.
- Consider the "camera": framing and angle dramatically change impact.
- When the user gives a vague concept, interpret it boldly. They came here for *ideas*.
- Keep reasoning and alternatives outside the prompt itself.

## Keeping this skill honest

The extension ships a condensed version of this knowledge as its default system prompt in
`lib/sdxl-knowledge.ts`. The two are meant to agree: this skill carries the depth, that file
carries the compressed operational version. When the model landscape moves, update both — and
when you change `DEFAULT_SYSTEM_PROMPT`, retire its old hash in `lib/settings-migrate.ts` so
existing installs migrate.
