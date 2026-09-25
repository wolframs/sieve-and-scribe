# Pony Diffusion V6 XL Prompt Reference

> ## ⚠ SCOPE WARNING — READ BEFORE APPLYING ANYTHING BELOW
>
> **Everything in this file applies to Pony Diffusion V6 XL and its V6 finetunes ONLY**
> (T-Ponynai3, Pony Realism, CyberRealistic Pony). **Pony V7 exists and is a completely
> different architecture (AuraFlow), not an SDXL model.** The V6 score-tag system this file
> teaches is unreliable/deprecated on V7 — applying it there produces poor, unpredictable
> results. If the target model is Pony V7, skip to **"Pony V7 (Different Architecture)"**
> near the end of this file, or go straight to `references/natural-language-models.md`.
> Always confirm which Pony you're targeting before prompting.

## Overview

Pony V6 XL is trained on ~2.6 million images with roughly equal anime/cartoon and furry content.
It uses a unique score-based quality system and source/rating tags not found in other model families.
**Clip Skip must be set to 2** or output will be low quality blobs.

Popular V6 finetunes: **T-Ponynai3**, **Pony Realism**, **CyberRealistic Pony**. These inherit
the score/source/rating tag system below — the same rules apply.

## Score Tag System (CRITICAL)

Due to a training artifact (Clever Hans effect), the full score string functions as a single
learned pattern. The model learned that the *entire long string* correlates with quality,
not individual score components.

### Positive Quality Tags
Always start prompts with the full string for best quality:
```
score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up
```

Shorter version (weaker but still works):
```
score_9, score_8_up, score_7_up
```

**Do NOT use `masterpiece`, `best quality`, `hd` etc.** — they're not trained into Pony
and waste tokens.

### Negative Score Tags
Score tags have **limited effect** in negatives. You can try:
```
score_4, score_3, score_2, score_1
```
But they won't push far from bad images. Better to use content-based negatives.

## Source Tags (Pony-Exclusive)

These steer the model toward different visual domains:
- `source_anime` — anime/manga style
- `source_cartoon` — western cartoon style
- `source_pony` — MLP/pony style
- `source_furry` — anthropomorphic/furry style

**Use these!** They dramatically affect output style. A prompt without source tags
may produce inconsistent mixing of styles.

## Rating Tags (Pony-Exclusive)

Content rating control:
- `rating_safe` — SFW content
- `rating_questionable` — suggestive but not explicit
- `rating_explicit` — NSFW

These are effective because they were part of the training captions.

## Prompt Order (Recommended)

```
[score tags], [source tag], [rating tag], [subject count],
[character/species], [physical description], [clothing],
[pose/action], [expression], [scene], [style/atmosphere]
```

Example:
```
score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up,
source_anime, rating_safe, 1girl, long hair, blue eyes, school uniform,
sitting, reading book, library, warm lighting, soft focus
```

## Tag Sources

Pony was trained on tags from **multiple boorus**: Danbooru (anime), e621 (furry),
Derpibooru (pony/MLP), plus additional custom annotations. This gives Pony broader
character/concept knowledge than Illustrious in some domains, especially furry/anthro.

## Natural Language

Pony V6 supports both booru tags AND natural language prompts.
Natural language works in most cases, but tags give more precise control.
You can mix them: start with tags, add NL descriptions for scene/mood.

## Artist & Character Tags

- Pony knows artists from across multiple boorus — broader but sometimes shallower than Illustrious
- Just use the artist name as a tag, no prefix needed
- For characters: use their standard name as a tag
- For MLP characters: use their standard name
- For anime: use Danbooru-style naming

## Popular Pony LoRAs & Styles

- **ExpressiveH** — the quintessential Pony enhancer. Smooth skin, dreamy quality,
  gives the classic "Pony look." Also functions as a detail enhancer. Use at 0.5-0.8.
- **Granblue Fantasy PSXL** — flattens toward clean anime aesthetic
- **Styles for Pony Diffusion V6 XL** — collection of style modifiers

## Negative Prompt Template

Standard Pony negative:
```
(worst quality, low quality:1.4), (zombie, sketch, interlocked fingers, comic), source_pony
```

Note: adding `source_pony` to negative when generating anime/human content helps avoid
pony-style artifacts. Similarly, add `source_anime` to negative for furry/pony content.

## Recommended Generation Settings

| Setting | Value |
|---------|-------|
| Resolution | 1024x1024 (standard SDXL ratios) |
| Steps | 25 (Euler a recommended) |
| CFG | 7 |
| Clip Skip | **2** (mandatory) |
| Sampler | Euler a, DPM++ 2M Karras |
| VAE | Pony VAE (included, optional for speed) |

Standard SDXL aspect ratios:
- 1024x1024, 832x1216, 1216x832, 768x1344, 1344x768

## Pony V7 (Different Architecture — everything above this line does NOT apply)

Pony V7 is built on **AuraFlow**, not SDXL. It shares a name and a lineage with V6, but not a
training recipe — treat it as an unrelated model when prompting:

- **Score tags are unreliable/deprecated.** Don't lead with `score_9, score_8_up…` — it's not
  the learned quality signal it was on V6.
- **Prompt structure** (in order):
  1. Special tags (whatever the specific checkpoint calls for)
  2. A factual natural-language description of the scene
  3. A stylistic natural-language description
  4. Tags (supplementary, not primary — the opposite emphasis from V6)
- **Characters**: format as `<species> <gender> <name> from <source>`.
- **Resolution**: 768-1536px. **Steps**: ≥30.
- **Do NOT force Clip Skip 2** — that's a V6-specific requirement; don't carry it over.
- For the full natural-language prompting approach, see `references/natural-language-models.md`.

## Key Differences from Illustrious

| Aspect | Pony V6 | Illustrious |
|--------|---------|-------------|
| Quality system | score_9 string | masterpiece, best quality |
| Source/Rating tags | Yes | No |
| Furry/anthro | Excellent | Weak (unless NoobAI) |
| Anime characters | Good | Better (deeper Danbooru) |
| Prompt adherence | Good | Better |
| Hands/anatomy | Decent | Better |

## Common Pitfalls

1. **Forgetting Clip Skip 2** — produces blobs/garbage without it
2. **Using masterpiece/best quality** — wastes tokens, not trained
3. **Forgetting source tags** — inconsistent style mixing
4. **Not using the full score string** — shorter versions work but weaker
5. **Ignoring rating tags** — model may produce unexpected content ratings
6. **Not adding source_pony to negative** when doing anime — pony artifacts leak through
7. **Applying any of this to Pony V7** — V7 is a different architecture (AuraFlow); score tags
   are unreliable there and Clip Skip 2 isn't required. See "Pony V7" above.
