# Illustrious XL Prompt Reference

## Model Versions & Key Differences

### v0.1 (Early Release)
- Trained on Danbooru up to 2023
- Needs quality tags AND extensive negative prompts to work well
- Base resolution: 1024x1024
- Many finetunes built on this (Hassaku, WAI-illustrious, Obsession, Diving, etc.)
- The base v0.1 is mediocre at generation; use finetunes instead

### v1.0 / v1.1
- Dataset updated to Danbooru 2024-June (new characters, artists, tags)
- Significantly better at generation than v0.1
- Base resolution increased to **1536x1536** — much better at high res
- Better ControlNet / img2img / LoRA compatibility
- Supports resolutions from 512x512 to 1536x1536

### v2.0 / v2.0 Stable

**v2.0 is an untuned merge base, not a generation-ready checkpoint.** Illustrious released it as
a merge point for downstream finetuners to build on — don't generate directly on raw v2.0; use a
v2.0-based finetune, or move to v3.0/v3.5 below for the current natural-language-capable line.

### v3.0 / v3.5 (NEW — eps + v-pred)

- Understands short **natural language** scene descriptions in addition to tags, but tags remain
  the backbone even here
- NL works best for scene/mood/spatial descriptions that are awkward in tags alone
- Booru tags still give more precise control for characters, clothing, composition, and quality
- **Hybrid approach recommended**: tags for character/outfit/quality, short NL phrases for scene/mood
  - Example: `masterpiece, best quality, 1girl, white hair, red eyes, school uniform, a serene garden at dusk with fireflies, cowboy shot`
- Don't write long paragraphs like you would for FLUX — keep NL portions short and descriptive
- Full NL-only prompting *works* but with reduced quality and accuracy vs tags
- Native resolution support from **256px up to 2048px**
- Two variants: eps and v-pred (same eps/v-pred tradeoffs as elsewhere in the anime-SDXL family —
  see `noobai.md` for the general eps-vs-v-pred rundown)
- **v3.5-vpred** additionally adds control tokens for contrast/brightness/saturation
- Finetunes like Hyphoria inherit this NL support; Hyphoria Qwen variant may have better NL via Qwen text encoder
- **Hasphoria** is a related model that adds a Gemma LLM encoder for deeper NL support (requires special ComfyUI workflow)

## Current Finetune Map (2026)

Most generation happens through a finetune rather than a bare base checkpoint:
- **WAI-illustrious** — now ~v16, the de facto "convenience" default for general anime work
- **Hassaku XL** — painterly/vibrant style finetune
- **Obsession** — detail-focused finetune
- **Nova Anime XL**, **JANKU** — anime finetunes
- Also: Diving and others building on v0.1/v1.x

**Watch for a naming trap:** "Hassaku (Anima)" is a *different, DiT-based model* (the Anima
family) — not the SDXL "Hassaku XL" above. Don't confuse the two when a user just says "Hassaku."

## Quality Tag System

**DO NOT use Pony score tags (score_9, etc.) — they do nothing on Illustrious.**

### Positive Quality Tags
Essential (always include):
```
masterpiece, best quality, absurdres
```

Optional boosters (use judiciously):
```
very aesthetic, perfect quality, absolutely eye-catching, highres
```

For v1.0+ you can also use year tags:
```
newest, recent, mid, early, oldest
```
`newest` biases toward more recent art styles from the training data.

### Negative Quality Tags
Standard negative template:
```
lowres, worst quality, low quality, bad anatomy, bad hands, text, error,
missing fingers, extra digit, fewer digits, cropped, jpeg artifacts,
signature, watermark, username, artist name
```

Extended negative (for v0.1 which needs more guidance):
```
lowres, (bad), bad anatomy, bad hands, extra digits, multiple views,
fewer, extra, missing, text, error, worst quality, jpeg artifacts,
low quality, watermark, unfinished, displeasing, oldest, early,
chromatic aberration, signature, artistic error, username, scan
```

## Prompt Order (Recommended)

```
[artist tag(s)], [subject count], [character description],
[items/held objects], [expression], [scene/environment],
[effects/atmosphere], [quality tags]
```

Example:
```
(redrop:0.7), 1girl, white hair, red eyes, maid uniform, apron,
holding broom, angry, anger vein, cafe, day, colorful, contrast,
masterpiece, best quality, absurdres, very aesthetic
```

## Artist Tags

- Use Danbooru artist names directly (no "by" prefix needed for most models)
- For some finetunes, `by artist_name` or `artist:artist_name` also works
- Check artist post count on Danbooru — 100+ posts = reliable reproduction
- Combine artists at partial weights for unique styles:
  `(artist_a:0.6), (artist_b:0.5)`
- Artist style search: https://danbooru.donmai.us/artists (filter by post count)

## Character Tags

- Use Danbooru format: `character_name \(series\)`
- Example: `hatsune miku`, `asuka langley \(evangelion\)`
- Some characters don't need series tag if they're unique enough
- Character knowledge depends on Danbooru post count and training cutoff date
- For v0.1: characters popular before 2023
- For v1.0+: characters popular before June 2024

## Composition & Framing Tags

These are powerful and underused. Pick ONE framing tag:
- `portrait` — head and shoulders
- `upper body` — above waist
- `cowboy shot` — mid-thigh up (classic anime framing)
- `full body` — entire figure
- `close-up` — face/detail focus
- `wide shot` — character small in environment

Angle tags (pick one):
- `from above`, `from below`, `from side`, `from behind`
- `dutch angle` — tilted camera, adds dynamism
- `pov` — first person perspective
- `straight-on` — direct facing

**Don't combine conflicting tags** like `close-up` + `full body`.

## Style Modifier Tags

Media/rendering style:
- `anime coloring`, `flat color`, `cel shading`
- `watercolor \(medium\)`, `oil painting \(medium\)`, `sketch`
- `traditional media`, `digital media`
- `anime screencap` — screenshot look
- `hyper-detailed, realistic` — 2.5D look (on supporting finetunes)

Era/aesthetic:
- `1980s \(style\)`, `1990s \(style\)`, `retro artstyle`
- `pc-98 \(style\)` — retro pixel aesthetic
- You can partially weight these: `(traditional media:0.5)`

## Lighting Tags

- `dramatic lighting`, `rim lighting`, `backlighting`
- `sunlight`, `moonlight`, `candlelight`
- `dappled sunlight` — light through leaves
- `cinematic lighting` — high contrast film look
- `soft lighting` — gentle, diffused
- `volumetric lighting` — god rays / light shafts
- `chiaroscuro` — extreme light/dark contrast
- `golden hour` — warm sunset tones

## Recommended Generation Settings

| Version | Resolution | Steps | CFG | Clip Skip | Sampler |
|---------|-----------|-------|-----|-----------|---------|
| v0.1 / finetunes | 1024x1024 (or SDXL ratios) | 20-28 | 5-7 | 2 | Euler a, DPM++ 2M Karras |
| v1.0 / v1.1 | Up to 1536x1536 | 20-28 | 5-7 | 2 | Euler a, DPM++ 2M Karras |
| v2.0 (untuned merge base — avoid raw) | — | — | — | — | — |
| v3.0 (eps) | 256px-2048px | 20-28 | 5-7 | 2 | Euler a, DPM++ 2M Karras |
| v3.5 (v-pred) | 256px-2048px | 20-28 | ~3-4 | 2 | Euler a, DPM++ 2M Karras |

Standard SDXL aspect ratios:
- 1024x1024 (square), 832x1216 (portrait), 1216x832 (landscape)
- 768x1344 (tall portrait), 1344x768 (wide landscape)

For v1.0+, can go higher: 1152x1536, 1536x1152, etc.

## Common Pitfalls

1. **Don't use score tags** — they're Pony-only and do nothing here
2. **Don't skip quality tags** — especially on v0.1, output quality drops hard
3. **Don't over-prompt** — past ~248 tokens, end tags get forgotten
4. **Don't use conflicting composition** — one framing tag, one angle tag
5. **CFG above 7 causes oversaturation** on most Illustrious models
6. **v-pred models need specific software support** — A1111 doesn't support v-pred yet; use ComfyUI or Forge
7. **Don't generate raw on v2.0** — it's an untuned merge base, not a finished checkpoint; use a v2.0-based finetune or move to v3.0/v3.5
