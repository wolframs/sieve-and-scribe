# LoRA Usage & Discovery Reference

## What Are LoRAs?

LoRA (Low-Rank Adaptation) files are small model patches (~10-300MB) that modify a base
model's behavior without replacing it. They inject trained adjustments into the model's
attention layers, activated by trigger words in your prompt.

**Types of LoRAs:**
- **Character LoRAs** — teach the model a specific character's appearance
- **Style LoRAs** — apply an artist's style or aesthetic
- **Concept LoRAs** — teach poses, compositions, clothing, or abstract concepts
- **Detail/Enhancement LoRAs** — improve quality, anatomy, or specific features
- **LyCORIS** (LoHa, LoKr, etc.) — extended LoRA variants, used the same way

## LoRA Prompt Syntax

### Basic Usage
```
<lora:filename:weight>
```
- `filename` — the LoRA's .safetensors filename WITHOUT the extension
- `weight` — strength from 0.0 to 1.5 (default: 1.0)

Example:
```
1girl, blue hair, <lora:my_character_lora:0.8>, masterpiece, best quality
```

### Where to Place LoRA Tags
The `<lora:...>` tag can go **anywhere** in the prompt — its position doesn't affect
the LoRA's influence. By convention most people put them after the main subject tags
and before quality tags.

### Weight Guidelines

| LoRA Type | Recommended Weight | Notes |
|-----------|-------------------|-------|
| Character | 0.7 - 1.0 | Higher = more accurate likeness, risk of overfitting |
| Style | 0.4 - 0.7 | Lower weights blend better; too high = artifacts |
| Concept/Pose | 0.5 - 0.8 | Depends on training quality |
| Detail enhancer | 0.3 - 0.6 | These are subtle; too high = overprocessed |
| NSFW-specific | 0.5 - 0.8 | Varies widely; start low |

**Start at 0.7 and adjust.** Too high causes:
- Color bleeding / saturation issues
- Character face distortion
- Style artifacts overriding everything
- "Cooked" / burned-looking images — if the output looks cooked, that's your signal to lower
  the weight before touching anything else in the prompt.

### Stacking Multiple LoRAs

You CAN stack multiple LoRAs:
```
1girl, warrior, <lora:character_lora:0.8>, <lora:style_lora:0.5>, <lora:detail_lora:0.3>
```

**Rules of thumb:**
- 1-2 LoRAs: usually fine at normal weights
- 3 LoRAs: reduce weights (total effective weight ideally < 2.0)
- 4+ LoRAs: chaos territory — reduce all weights significantly
- Character + Style is the most common useful combination
- Two character LoRAs will fight each other (faces blend/conflict)
- Two style LoRAs can work if weights are low (0.3-0.5 each)

### Trigger Words

Most LoRAs require specific trigger words in the positive prompt to activate.
Without them, the LoRA may not activate or produce weak results.

- Trigger words are documented in the LoRA's description on Civitai
- Common patterns: character name, style name, or custom tags
- Some LoRAs work without triggers but are enhanced by them
- **Always check the LoRA's page for trigger words and recommended settings.**

**Never invent a trigger word or filename.** If you don't already know it from a live API call
(`trainedWords` from the model-details endpoint, below), look it up before writing it into a
prompt. If the lookup tools aren't available and you're not certain, say so plainly instead of
guessing — a fabricated trigger word does nothing but waste the user's Buzz on a generation that
silently ignores the LoRA.

## LoRA Compatibility Matrix

**CRITICAL: LoRAs are base-model specific.** Using the wrong LoRA produces garbage. As of 2026,
compatibility is **strictly per-architecture** — never suggest a LoRA across bases, and when in
doubt, treat two model names as incompatible until the Civitai listing's `baseModel` field says
otherwise.

| LoRA Trained On | Works With | Doesn't Work With |
|----------------|------------|-------------------|
| Illustrious XL | Illustrious finetunes, NoobAI, most ILXL merges | Pony, base SDXL, SD 1.5 |
| Pony V6 XL | Pony finetunes (T-Ponynai3, EasyFluff, etc.) | Illustrious, NoobAI, base SDXL |
| Base SDXL 1.0 | Some SDXL models | Usually not anime finetunes |
| SD 1.5 | SD 1.5 models only | Nothing SDXL-based |
| NoobAI-XL | NoobAI, some Illustrious models | Pony, base SDXL |
| Flux.1 (dev/schnell) | Flux.1 only | Flux.2, Chroma, Qwen, Z-Image, Krea 2 — anything else |
| Flux.2 (incl. Klein) | Flux.2 only | **Flux.1 — this is the single most common 2026 mistake** (see below) |
| Chroma | Chroma only | Flux.1, Flux.2, Qwen, Z-Image, Krea 2 |
| Qwen-Image | Qwen-Image only | Flux.1, Flux.2, Chroma, Z-Image, Krea 2 |
| Z-Image | Z-Image only | Flux.1, Flux.2, Chroma, Qwen, Krea 2 |
| Krea 2 | Krea 2 only | Flux.1, Flux.2, Chroma, Qwen, Z-Image |
| Wan 2.1 / 2.2 (video) | Exact same Wan version AND variant only | Any other Wan version, other video models |

**Illustrious ↔ NoobAI** cross-compatibility is generally good.
**Pony V6 ↔ Illustrious/NoobAI** cross-compatibility does **not work at all** — Pony V6 does not
mix with either family, full stop, regardless of how visually similar two anime checkpoints look.

**Flux.1 LoRAs do NOT work on Flux.2.** This is the most common LoRA mistake in the 2026
landscape — Flux.2 (including the on-site default, Klein) is a different architecture from
Flux.1 (dev/schnell) despite the shared "Flux" branding and BFL lineage, and the two do not share
LoRA weights. Always check the `baseModel` field on the Civitai listing before recommending a
Flux LoRA — "Flux" alone is not enough information; it must say `Flux.1 D`/`Flux.1 S` vs a
Flux.2-tagged base.

**Every natural-language DiT model is its own island**: Flux.1, Flux.2, Chroma, Qwen-Image,
Z-Image, and Krea 2 are five (six, counting the Flux.1/2 split) separate architectures with zero
LoRA cross-compatibility between them, despite all being "natural-language image models" in the
same prompting class. Prompting-class similarity does not imply LoRA compatibility — never infer
one from the other.

**Video LoRAs must match model AND variant.** A Wan LoRA trained on 2.1 does not reliably work on
2.2, and a T2V-trained LoRA does not reliably work in an I2V pipeline (or vice versa) — nor does a
high-noise-trained LoRA transfer to a low-noise pipeline. Treat "Wan 2.1 T2V" and "Wan 2.2 I2V
high-noise" as different base models for LoRA purposes, the same way you'd treat Illustrious vs
Pony. See `references/video.md` for the full video-model breakdown and which Wan variants run
in-house vs via partner API.

**Partner/closed models take no LoRAs at all.** Imagen 4, Nano Banana, GPT Images, Kling, Veo 3,
Sora 2, Grok Video/Imagine, Seedream, Seedance, HappyHorse, Vidu, and the other closed partner
models on-site have no LoRA support of any kind — there's nothing to look up or recommend for
them. If a user asks for a LoRA on one of these, the answer is that it isn't possible on that
model; suggest an in-house model instead if LoRA support is the actual goal.

## Well-Known Staple LoRAs by Model Family

### Pony V6 XL Ecosystem
- **ExpressiveH** — quintessential Pony enhancer. Smooth skin, dreamy quality,
  the classic "Pony look." Also a detail enhancer. Use at 0.5-0.8.
- **Granblue Fantasy PSXL** — flattens toward clean anime aesthetic
- **Styles for Pony Diffusion V6 XL** — collection of style modifiers

### Illustrious XL Ecosystem
- **CicaLust / CicaStyle** — anime style with shiny skin aesthetic
- Character LoRAs: huge ecosystem on Civitai for anime/game characters
- Artist style LoRAs: for artists with too few Danbooru posts to reproduce from tags alone
- Many trained on v0.1 base — check compatibility with v1.0+ finetunes

### NoobAI-XL Ecosystem
- Inherits compatibility with most Illustrious LoRAs
- Some LoRAs specifically trained on NoobAI exist (check Civitai filters)
- e621 knowledge means furry character LoRAs are less necessary than with pure Illustrious

## Discovering LoRAs: Civitai API

The Civitai REST API allows programmatic search for LoRAs. Claude Code can query this
directly when the user needs to find LoRAs for a specific purpose.

### API Setup

The user's Civitai API token should be available as an environment variable:
```bash
export CIVITAI_API_TOKEN="your_token_here"
```

Or passed per-request as a query parameter: `?token={api_key}`

**Prefer the header approach.** The `?token=` method works but the API leaks your token
in `metadata.nextPage` pagination URLs on the images endpoint. Using the header avoids this:
```bash
curl -s -H "Authorization: Bearer ${CIVITAI_API_TOKEN}" "https://civitai.com/api/v1/models?..."
```

### Search for LoRAs

```bash
# Search for Illustrious character LoRAs
curl -s -H "Authorization: Bearer ${CIVITAI_API_TOKEN}" \
  "https://civitai.com/api/v1/models?\
types=LORA&\
query=CHARACTER_NAME&\
sort=Most+Downloaded&\
limit=5" | jq '.items[] | {
  name: .name,
  id: .id,
  downloads: .stats.downloadCount,
  rating: .stats.rating,
  tags: .tags,
  url: ("https://civitai.com/models/" + (.id | tostring))
}'
```

**Gotcha**: Combining `query=` with `baseModels=` can return 0 results if the text query
is too specific for that base model family. If you get empty results, try dropping `query=`
and filtering by `baseModels=` + `tag=` instead, or broaden the search terms.

### Filter by Base Model

```bash
# LoRAs compatible with Pony V6
curl -s -H "Authorization: Bearer ${CIVITAI_API_TOKEN}" \
  "https://civitai.com/api/v1/models?\
types=LORA&\
query=anime+style&\
baseModels=Pony&\
sort=Highest+Rated&\
limit=10"
```

Valid `baseModels` values (case-sensitive):
- `Pony`, `Illustrious`, `NoobAI`, `SDXL 1.0`, `SD 1.5`, `Flux.1 D`, `Flux.1 S`

**Note on sort values**: `Most Downloaded`, `Highest Rated`, `Newest`, `Most Liked`, `Most Collected`
all work on the models endpoint. `Most Reactions` does NOT work on models (silently returns 0 results)
— it only works on the images endpoint.

### Get Model Details (Trigger Words & Usage Info)

```bash
curl -s -H "Authorization: Bearer ${CIVITAI_API_TOKEN}" \
  "https://civitai.com/api/v1/models/{MODEL_ID}" | jq '{
  name: .name,
  description: .description,
  tags: .tags,
  versions: [.modelVersions[] | {
    name: .name,
    trigger_words: .trainedWords,
    base_model: .baseModel,
    download_url: .downloadUrl,
    files: [.files[] | {name: .name, size: .sizeKB}]
  }]
}'
```

The `trainedWords` field contains the trigger words. This is the most reliable
way to get them programmatically.

**Gotcha**: `trainedWords` values can be messy — some LoRA authors put comma-separated
words in a single string (e.g., `["word1,word2,word3,"]`). Split on commas and trim
whitespace/trailing commas when parsing.

### Get Image Generation Metadata (Prompt Mining)

```bash
# Browse top-rated images made with a specific LoRA to learn effective prompts
curl -s -H "Authorization: Bearer ${CIVITAI_API_TOKEN}" \
  "https://civitai.com/api/v1/images?\
modelVersionId={VERSION_ID}&\
limit=10&\
sort=Most+Reactions" | jq '.items[] | {
  prompt: .meta.prompt,
  negative: .meta.negativePrompt,
  sampler: .meta.sampler,
  cfg: .meta.cfgScale,
  steps: .meta.steps,
  clipSkip: .meta.clipSkip,
  loras: [.meta.civitaiResources[]? | select(.type == "lora") | {name: .modelVersionName, weight: .weight}]
}'
```

This is GOLD for prompt engineering — you can see what prompts real users wrote to
get highly-rated images with a specific LoRA.

**Note**: LoRA/model info is in `meta.civitaiResources`, NOT `meta.resources` (which is
often empty). Each entry has `type`, `weight`, `modelVersionId`, and `modelVersionName`.

### NSFW Content Access

The API requires authentication (token) to access NSFW model data and images.
Without a token, NSFW content is filtered out.
With a valid token, set `nsfw=true` or leave unset (defaults vary by endpoint).

**`browsingLevel` bitmask** (alternative to `nsfw=true`, gives finer control):
- `1` = PG, `2` = PG13, `4` = R, `8` = X, `16` = XXX
- Combine with OR: `browsingLevel=28` for R+X+XXX

**`nsfwLevel` inconsistency**: On the images endpoint it's a string (`"None"`, `"Soft"`,
`"Mature"`, `"X"`). On the models endpoint it's a numeric bitmask. Don't compare across endpoints.

### Pagination

The API uses **cursor-based pagination**. Use `metadata.nextCursor` for the next page.
`metadata.nextPage` provides a full URL but may leak your token (if using `?token=`).
`metadata.totalItems` is always `null` — there is no way to get a total count.

### Offline Alternative: CivitaiLMB

If the API is unreliable, there's a community-maintained SQLite dump of all Civitai
model metadata (CivitaiLMB on GitHub). ~2GB but gives offline search over the entire
LoRA database including models hidden from Civitai's web search.

## When Writing Prompts That Include LoRAs

When the user mentions they have specific LoRAs loaded:

1. **Ask for the LoRA name and what it does** (or search Civitai for it)
2. **Look up trigger words** via the API if the user doesn't know them
3. **Include trigger words in the positive prompt** at appropriate position
4. **Add the `<lora:name:weight>` tag** with a sensible starting weight
5. **Adjust other prompt elements** — a strong style LoRA means back off
   on artist tags; a character LoRA means less physical description needed
6. **Note weight in output** and suggest the user adjust if results aren't right

When the user wants to FIND LoRAs for their concept:
1. Search Civitai API by keyword + base model + type LORA
2. Sort by Most Downloaded or Highest Rated for reliability
3. Pull trigger words from the model details
4. Check sample images/prompts for usage patterns
5. Present options with download links
