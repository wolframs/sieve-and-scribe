# NoobAI-XL Prompt Reference

## Overview

NoobAI-XL is based on Illustrious-xl-early-release-v0, trained on the **complete** Danbooru
AND e621 datasets (~13 million images total). This gives it the broadest knowledge base of
any SDXL anime model — deep anime knowledge from Danbooru plus extensive furry knowledge
from e621.

Two versions exist:
- **eps-prediction** (epsilon) — the safe default, generally preferred
- **v-prediction** — better lighting/dark scenes, but needs v-pred-aware sampling and lower CFG (~3-4)

**NoobAI-XL is the FINAL release in this line** — no further NoobAI-XL versions are planned.
Its successor is **Chenkin Noob XL (CKXL)**, a separate model trained on Danbooru data through
~January 2026.

## Quality & Aesthetic Tags

### Positive Quality Tags
Always include:
```
very awa, masterpiece, best quality, newest, highres, absurdres
```

**`very awa`** is NoobAI's unique aesthetic tag — it significantly boosts image quality.
Don't skip it.

Quality tag hierarchy (strongest → weakest):
`masterpiece` > `best quality` > `high quality` / `good quality` > `normal quality` > `low quality`

Year/recency tags: `newest` > `recent` > `mid` > `early` > `oldest`
Use `newest` to bias toward modern art styles.

### Negative Quality Tags
Standard negative:
```
worst quality, old, early, low quality, lowres, signature, username,
logo, bad hands, mutated hands, text, watermark
```

For anime specifically, add to negative to prevent e621 bleed:
```
mammal, anthro, furry, ambiguous form, feral, semi-anthro
```

## Prompt Order (Recommended by Official Guide)

```
[subject count], [character name], [series], [artist(s)],
[special tags], [general tags], [other tags], [quality tags]
```

Quality tags can go at front OR back — both work.

## Character Tags

- Format: `character name \(series\)` — escape parentheses!
- Example: `ganyu \(genshin impact\)`, `lucy \(cyberpunk\)`
- Add the series tag immediately after character name for disambiguation
- **Tag normalization rules:**
  - Remove underscores: `hatsune_miku` → `hatsune miku`
  - Escape parentheses: `(genshin impact)` → `\(genshin impact\)`
  - These are **critical** — wrong format = tag not recognized

## Artist Tags

- Use artist name directly — **NO prefix** (no "by", no "artist:")
- Example: just `ebifurya`, not `by ebifurya`
- NoobAI recognizes artists from both Danbooru and e621
- NAI3 (NovelAI) artist trigger words do NOT work identically
- Check the official trigger word CSV for exact artist names

## Source & Rating Tags

NoobAI does NOT use Pony-style tags:
- No `source_anime` / `source_furry`
- No `score_9` tags
- For NSFW control: use `nsfw` in negative, or `rating:safe` / `rating:explicit`

## The e621 Factor

Because NoobAI trained on e621, it has knowledge pure Illustrious lacks:
- Anthropomorphic/furry characters and anatomy
- Species-specific tags (canine, feline, avian, etc.)
- Broader creature/monster knowledge

**Double-edged sword** — furry concepts can leak into anime output.
Always use furry-related negatives when generating pure anime content.

## eps vs v-pred

| Aspect | eps-prediction | v-prediction |
|--------|---------------|--------------|
| Maturity | More trained, generally better | Less trained as of early 2025 |
| Diversity | More diverse/creative output | More prompt-adherent |
| Lighting | Standard | Significantly better dark/moody scenes |
| CFG | 5-7 (standard) | ~3-4 — v-pred oversaturates/burns at standard CFG |
| Software | Works in A1111, Forge, ComfyUI | Needs v-pred-aware sampling support (ComfyUI, Forge) |
| Overall | **The safe default** for most users | For advanced users wanting better lighting |

For v-pred, you may need LatentModifier nodes in ComfyUI for best results.

## Recommended Generation Settings

| Setting | Value |
|---------|-------|
| Resolution | 1024x1024 area (see ratios below) |
| Steps | 20-28 |
| CFG | 5-7 (eps); ~3-4 (v-pred) |
| Clip Skip | 2 |
| Sampler | Euler a, DPM++ 2M Karras |

Recommended aspect ratios:
- 768x1344, 832x1216, 896x1152, 1024x1024
- 1152x896, 1216x832, 1344x768, 1024x1536 / 1536x1024

## LoRA Compatibility

- Works well with LoRAs trained on Illustrious XL base models
- Pony LoRAs generally do NOT work (different base)
- AnimagineV3 / SDXL 1.0 LoRAs: sometimes work, not recommended
- Community LoRAs tagged "NoobAI" or "Illustrious" are best

## Common Pitfalls

1. **Forgetting `very awa`** — significant quality drop without it
2. **Using Pony score tags** — completely ignored, wastes tokens
3. **Not escaping parentheses** in character names — tag not recognized
4. **Leaving underscores in tags** — must remove them
5. **Not adding furry negatives for anime** — e621 bleeding
6. **Using "by" prefix for artists** — not needed, may confuse
7. **Using meta tags carelessly** — some meta tags describe file properties,
   not visual output. `absurdres` works; random meta tags may not.
