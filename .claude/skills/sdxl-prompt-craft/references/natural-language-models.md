# Natural-Language Image Models Reference

## Overview

This is CLASS 2 of the 2026 CivitAI model landscape: models with large text encoders —
T5, Mistral, Qwen-VL, Gemma — that **read** your prompt instead of pattern-matching booru
tags. Flux.1, Flux.2 (incl. Klein), Qwen-Image, Z-Image, Krea 2, Chroma, Pony V7, Anima,
Neta Lumina, and the closed partner models on-site (Imagen 4, Nano Banana, GPT Images, Grok
Imagine, Seedream, Reve, Boogu, MAI, Ernie, Wan Image, Lens) all belong here.

Bringing Illustrious/Pony/NoobAI habits to this class is the single most common failure mode.
`masterpiece, best quality, absurdres, 1girl, (detailed:1.3)` does nothing useful on a model
that reads sentences — worse, Flux-family models will sometimes render literal quality-tag
text as garbage typography in the image, because they take you at your word. Write like
you're briefing a photographer, not tagging a booru post.

## Shared Rules

These apply across the whole class unless a per-model section below overrides them.

**Structure the sentence, don't list nouns.** Flow: subject → action/pose → setting →
lighting → camera/technical → style/mood. Front-load what matters most — these encoders
weight early tokens more heavily, and most models cap out well under 100 words before
returns diminish. A few models (Qwen-Image, Flux.2's JSON mode) actively prefer explicit
structure over prose — see their sections.

**No booru spam, no attention weights.** `(tag:1.3)` weighting syntax is an SDXL/CLIP
convention; T5/Mistral/Gemma encoders don't parse it — at best it's inert dead text, at
worst it gets read literally and rendered as characters in the image. Same for quality-tag
strings like `8k, masterpiece, ultra detailed`. If you want more detail, describe the detail.

**Negative prompts depend on CFG, not the model.** CFG-1 distilled models throw the negative
prompt away entirely — there's no classifier-free guidance to steer away from it. That's
Flux.1 dev/schnell, Flux.2 Klein, and Z-Image Turbo. On those, express the negative as a
positive instruction instead: not "blurry" but "sharp focus"; not "extra fingers" but
"natural proportions, five fingers per hand." Negatives DO work on models that run at CFG
3–4 or higher: Qwen-Image, Z-Image Base, Chroma, and Neta Lumina.

| Negatives work | Negatives are ignored |
|---|---|
| Qwen-Image (CFG ~4.5–7) | Flux.1 dev/schnell |
| Z-Image Base (CFG ~4) | Flux.2 Klein |
| Chroma (CFG 3–4 only) | Z-Image Turbo |
| Neta Lumina (CFG 4–5.5) | |

**Style without artist tags.** Danbooru-style artist names don't transfer to this class the
way they do on SDXL. Describe the medium, palette, lighting, and camera instead — "shot on
35mm film, muted earthy palette, soft window light" — or reach for a style LoRA where the
target model supports one.

## Flux.2 (incl. Klein — the on-site default)

The most literal instruction-follower in the class: if you describe it, Flux.2 tries to put
it in the frame, including text, exact colors, and layout relationships. This makes it the
safest default when you're not sure which class-2 model to reach for.

**Klein** is the size-distilled variant and the on-site default. It's distilled hard enough
that the on-site form only exposes steps 4–12 (default ~8) and hides CFG and sampler
entirely — you get no dial to compensate for a vague prompt, so put everything into the
prompt itself.

Flux.2 supports structured JSON-style specs instead of prose — genuinely useful when a
scene has many independent parts to keep straight:

```json
{
  "subject": "a woman in a rain-slicked trench coat",
  "background": "neon-lit alley, wet asphalt reflecting signage",
  "lighting": "cool blue rim light from the signs, warm key light from a doorway",
  "style": "cinematic photography, shallow depth of field",
  "camera_angle": "low angle, looking up",
  "composition": "subject right-of-frame, leading lines from the alley walls"
}
```

It also handles exact hex colors ("a gradient starting #02eb3c") and strong typography —
put any literal text you want rendered in quotes.

**Flux.1 LoRAs do NOT work on Flux.2** — different architecture, no cross-loading.

## Flux.1 dev/schnell

The legacy natural-language workhorse and still the model with the biggest LoRA library in
this class. Plain flowing prose, no structured-JSON mode. Guidance ~3.5 for dev (20–28
steps); schnell is the distilled 4-step variant. No effective negatives on either — CFG-1
territory, so push wanted qualities in positively rather than banning unwanted ones.

## Qwen-Image (2512)

The realism + best-in-class text-in-image pick. Counterintuitively for this class, Qwen
prefers **short structured prompts over prose** — padding it out with extra descriptive
words measurably hurts output. The house format is labeled fields in 1–3 sentences:

```
Subject: a barista in a canvas apron, mid-pour into a ceramic cup.
Clothing: rolled sleeves, leather wrist strap.
Setting: a narrow specialty coffee shop, exposed brick, morning light through a front window.
Lighting: warm directional sunlight, soft falloff into the shop's interior.
Mood: quiet, unhurried focus.
```

Wrap any literal text you want rendered in double quotes. For text-heavy work (signage,
labels, posters) push CFG to 7 with 50 steps; for normal image work, CFG ~4.5 at 50 steps.
Negatives work well here — `blurry, low quality, distorted, watermark` is a solid baseline.
Qwen-Edit is the instruction-editing sibling: "change the shirt to red" rather than a full
re-description.

## Z-Image (Turbo/Base)

Lumina-architecture, 6B — the fast, low-VRAM favorite when you want throughput over
precision. Natural language, no structured mode.

| Variant | CFG | Steps | Negatives | Sampler |
|---|---|---|---|---|
| Turbo | 1.0 | 8–12 | Ignored | euler + beta |
| Base | ~4 | ~20 | Work normally | — |

Turbo is the one to reach for on rapid iteration passes; switch to Base once you need
negative-prompt control or are doing a final render.

## Krea 2 (Raw/Turbo)

12B DiT, currently the aesthetic/photorealism frontier pick on-site. Conversational natural
language — write it like you'd describe a photo to a person. It's particularly strong at
wide/cinematic aspect ratios and natural skin texture, which is where a lot of other
photoreal models still look waxy. Community recipe worth knowing: run the Raw checkpoint
with the Turbo LoRA layered at 0.6 — faster generation without giving up much of Raw's
fidelity.

## Chroma

8.9B, descended from the Flux-schnell lineage, and deliberately uncensored. Chroma is the
**hybrid** of this class: T5 natural language, booru tags, AND artist names all work in the
same prompt, because its training data folded in booru/e621/art-inclusive sources on top of
the usual caption data. That means you can write a natural-language scene and drop in a
Danbooru artist name or a couple of booru tags for texture, and it'll respond to all of it.

The CFG behavior matters here: negatives only work at CFG 3–4, and are ignored at CFG 1 like
the rest of the distilled crowd — Chroma isn't distilled to CFG-1-only, so don't run it there
if you need the negative prompt. Short structured prompts beat walls of text, same as Qwen.

## Pony V7

Don't let the name fool you — **this is not V6.** Pony V7 is built on AuraFlow, an entirely
different architecture from V6's SDXL base, and none of V6's score-tag knowledge carries
over: `score_9, score_8_up...` is unreliable and effectively deprecated on V7.

Prompt structure is its own recipe: special tags first, then a factual natural-language
description of the scene, then a stylistic description, then tags. Characters are referenced
as `<species> <gender> <name> from <source>` rather than a bare Danbooru-style character tag.
Generate at 768–1536px, 30+ steps. Don't force Clip Skip 2 onto it out of SDXL habit — it's
not the same text-conditioning setup and the mandatory-Clip-Skip-2 rule is V6-specific.
Cross-reference `references/pony.md` for the V6 side of the family.

## Anima

DiT architecture, ~2B parameters — the spiritual "Illustrious successor," including the
Hassaku Anima finetune (not to be confused with plain "Hassaku XL," which is Illustrious).
Anima is the rare model that genuinely bridges both classes: it accepts Illustrious-style
booru tag prompts AND natural language, so you can prompt it either way depending on which
gives you more precise control for a given request.

## Neta Lumina

Lumina 2 architecture with a Gemma text encoder, anime-focused. Neta Lumina has a hard
requirement the rest of this class doesn't: both the positive AND negative prompt **must**
be prefixed with the system string:

```
You are an assistant designed to generate anime images based on textual prompts. <Prompt Start>
```

Booru tags or natural language both work — but never mixed in the same prompt; pick one and
commit. Artists are referenced with an `@artist_name` handle rather than a bare tag. Run at
CFG 4–5.5, 30+ steps.

## Closed Partner Models On-Site

Imagen 4, Nano Banana, GPT Images, Grok Imagine, Seedream, Reve, Boogu, MAI, Ernie, Wan
Image, Krea, and Lens are all closed APIs surfaced in the on-site generator. Treat them the
same way: plain vivid natural language, no LoRA support, few exposed parameters, and
PG-leaning content moderation baked into the API itself. **Grok Imagine** is the standout
as the cheap, permissive cloud option when the others' moderation gets in the way.

## Fading — Don't Recommend Fresh

HiDream and SD 3.5 still exist and still generate, but they're on the way out of the 2026
meta. Don't reach for either on a new project; if a user already has a workflow built around
one, help them, but steer new requests toward the models above.

## Which One Should I Use

- **Most literal instruction-following, general default** → Flux.2 (Klein on-site)
- **Photorealism / current aesthetic frontier** → Krea 2 (Raw + Turbo LoRA at 0.6)
- **Legible text/logos in the image** → Qwen-Image (quoted text, CFG 7, 50 steps) or Flux.2
- **Cheapest/fastest iteration** → Flux.2 Klein or Z-Image Turbo
- **Uncensored / booru-and-NL hybrid** → Chroma
- **Biggest legacy LoRA library** → Flux.1 dev/schnell
- **Anime, modern architecture, tags-or-NL** → Anima; **anime with a Gemma-quality NL
  understanding** → Neta Lumina (mind the mandatory prefix)
- **AuraFlow-based Pony successor** → Pony V7 (treat as unrelated to V6 prompting)
- **No LoRA needed, just a fast clean result, PG content acceptable** → any closed partner
  model, Grok Imagine if moderation is a problem

## Worked Examples

**Flux.2 — structured JSON spec** (cinematic product-style shot, exact color control):

```json
{
  "subject": "a hand-thrown ceramic mug, matte glaze, steam rising from the coffee inside",
  "background": "a worn wooden table, blurred bookshelf behind",
  "lighting": "single soft window light from camera-left, warm morning color temperature",
  "style": "editorial food photography, shallow depth of field, f/2.0 look",
  "camera_angle": "eye-level, three-quarter view",
  "composition": "mug slightly left of center, steam trailing up through negative space",
  "color": "glaze is a gradient starting #3a5f4a fading to #1c2b22 at the base"
}
```
No negative prompt — Klein ignores it. Settings: steps 8 (Klein default), no CFG/sampler
exposed.

**Qwen-Image — short structured prompt** (same rough scene, Qwen's native format):

```
Subject: a matte ceramic mug on a worn wooden table, steam rising from the coffee inside.
Setting: a quiet kitchen corner, blurred bookshelf in the background.
Lighting: soft warm morning window light from the left, shallow depth of field.
```
Negative: `blurry, low quality, distorted, watermark, oversaturated`
Settings: CFG ~4.5, 50 steps.

Notice the difference in voice: Flux.2's JSON spec is explicit about every field including
exact hex color and named camera angle, because it's the most literal parser in the class.
The Qwen version is deliberately shorter — three labeled sentences, no exhaustive detail —
because piling on more descriptive words measurably degrades Qwen's output rather than
improving it.

**Neta Lumina — anime scene with mandatory prefix:**

Positive:
```
You are an assistant designed to generate anime images based on textual prompts. <Prompt Start>
a girl with short silver hair standing on a rain-soaked rooftop at dusk, city lights blurred
below, wind pulling at her coat, melancholic mood, soft cinematic lighting
```
Negative:
```
You are an assistant designed to generate anime images based on textual prompts. <Prompt Start>
lowres, blurry, extra limbs, watermark
```
Settings: CFG 5, 32 steps.

## Common Pitfalls

1. **Carrying SDXL habits over** — quality-tag strings, `(tag:1.3)` weights, and score
   strings are inert-to-harmful here; the model may render them as literal text.
2. **Writing a negative prompt for a CFG-1 model** — Flux.1, Flux.2 Klein, and Z-Image Turbo
   discard it outright; rephrase as a positive instruction instead.
3. **Over-describing on Qwen-Image** — more words hurt once past its short structured format;
   resist the urge to pad it out like a Flux prompt.
4. **Forgetting Neta Lumina's system prefix** on either the positive OR negative prompt —
   without it the model isn't in the expected mode.
5. **Mixing tags and natural language on Neta Lumina** — pick one register per prompt, unlike
   Anima, which genuinely accepts both.
6. **Assuming Pony V7 behaves like V6** — different architecture entirely; score tags don't
   transfer, and Clip Skip 2 isn't a V7 concept.
7. **Loading a Flux.1 LoRA on Flux.2** (or any cross-architecture LoRA in this class) — none
   of Flux.1, Flux.2, Chroma, Qwen, Z-Image, or Krea 2 share LoRA weights with each other.
8. **Reaching for HiDream or SD 3.5 on a new project** — both are fading; there's no reason
   to start something new on them in the current meta.
