# Video Generation Reference

## On-Site Modes

The Video tab supports: **text-to-video, image-to-video, first/last-frame, reference-to-video**,
plus post-processing modes — upscale, interpolate, AI video-edit.

## Model Roster

| Category | Models | Traits |
|----------|--------|--------|
| In-house (open-weight) | LTX 2/2.3, Wan 2.1, Hunyuan | LoRA support, seeds, laxer content rules, cheaper |
| Partner APIs | Kling, Veo 3, Sora 2, Grok Video, Seedance, HappyHorse, Vidu | Plain cinematic prompts, no LoRAs, PG-only, expensive |

The in-house models are what you get creative control over. The partner APIs are a one-way
trip: type a good sentence, pay more, get max fidelity, no knobs.

## The On-Site Video Form

The form is deliberately minimal — it exposes exactly:

- **Prompt** and **negative prompt**
- **Aspect**: 16:9 / 1:1 / 9:16
- **Duration**: 5s / 10s
- **CFG**: a single normalized Low↔High slider (not a numeric CFG value)
- **Seed**

There is no steps field, no sampler picker, no clip skip — none of that is exposed on-site. Numeric
steps/CFG/guidance figures in this doc describe what the underlying model uses internally (relevant
if you're running it off-platform via ComfyUI, or just to understand what the slider is doing);
on-site, put everything into the prompt and use the slider only as a coarse guidance dial.

## Universal Rules (every video model, no exceptions)

All video models take **natural-language cinematic description — never booru tags**. A prompt
that would be perfect for Illustrious ("1girl, white hair, cowboy shot, masterpiece") is dead
weight here; video models were never trained on tag soup.

1. **Structure**: subject → action → camera → lighting/mood. Write in present tense, describing
   what *unfolds* over the clip — video prompting is about change over time, not a static tableau.
2. **ONE dominant camera move per clip**, named with real cinematography vocabulary: dolly
   in/out, pan left/right, tilt, tracking shot / camera follows, orbit, crane, pull-back, whip
   zoom, static shot. Stacking two camera moves ("the camera dollies in while panning right and
   craning up") confuses every model on the roster — pick the one move that matters.
3. **Motion needs speed + direction**, not just a verb. "She walks" is weak; "she walks briskly
   left to right across the frame" is a prompt. Same for camera: "slowly toward camera," not just
   "dolly in."
4. **5 seconds is the coherence sweet spot.** 10s is available and fine for simple, low-motion
   shots, but the longer the clip the more it drifts — extra motion, morphing detail, camera
   wobble. If a concept needs more screen time, generate multiple 5s clips and stitch rather than
   asking for one long unstable one.
5. **Image-to-video locks appearance to the source frame.** Describe ONLY the motion and camera —
   re-describing the subject's looks (hair color, outfit, face) is wasted tokens at best and can
   fight the source image at worst.
6. **Anime video has no first-class model.** There is no anime-trained video generator on the
   roster. The community meta: generate the still with an anime SDXL model (Illustrious/NoobAI/
   Pony), then animate it via image-to-video — Wan 2.1 with an anime-style motion LoRA is the
   established path. Don't ask an in-house video model to generate anime-style motion from a text
   prompt alone; it will drift toward a realism-trained default.

## Model-by-Model

### LTX 2 / 2.3 (Lightricks) — the price/performance king

- **Cheapest on-site** (from ~35 Buzz), fast, and the only model here with **native audio
  generation** — this is LTX's actual edge and the single most common thing users forget to use.
- Up to **20s clips** on 2.3. First/last-frame control. Both t2v and i2v. LoRA training available
  on-site.
- **Prompt as a flowing 4–8 sentence cinematic narrative** — not a tag list, not a terse
  one-liner. Then **describe the sound**: ambience, dialogue (in quotes), volume/intensity. If
  you don't write the audio, LTX won't invent anything interesting for you.
- **Avoid**: on-screen text, internal emotions ("she feels nostalgic" — LTX can't render a
  feeling, only what a feeling looks like), overloaded multi-event scenes.
- **Settings** (if run off-platform): steps 20–40, guidance 3–7 where exposed.

### Wan 2.x (Alibaba) — the open realism / LoRA leader

- The **open-weight quality and realism leader**, and it has by far the **biggest video-LoRA
  ecosystem** — motion, style, and character LoRAs all exist for it. LoRAs must match the *exact*
  variant: Wan 2.1 vs 2.2, T2V vs I2V, high-noise vs low-noise. Cross that and it's a base-model
  mismatch, same as loading a Pony LoRA on Illustrious. See `references/loras.md` for the general
  compatibility discipline.
- **Wan 2.1 runs in-house**: seeds work, NSFW-capable on civitai.red. **2.2 / 2.5 / 2.7 are
  partner API only**: PG, 1080p, up to 10s, and 2.7 adds audio.
- **Prompt length**: ~80–120 words, and **front-loaded** — Wan weights the beginning of the
  prompt more heavily, so put the subject and the most important action first, not buried at the
  end.
- **Formula**: subject + scene + action + camera + lighting + mood. Explicit speed and direction
  on every motion. ONE camera move, as with every model on this list.
- **Negatives matter a lot here** — Wan obeys them strongly, unlike the CFG-1 distilled image
  models. Always include Wan's canonical negative (reproduce it in full; add task-specific bans
  on top, don't replace it):

  ```
  bright colors, overexposed, static, blurred details, subtitles, worst quality, low quality,
  JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn
  faces, deformed, disfigured, malformed limbs, fused fingers, still picture, cluttered
  background, three legs, many people in the background, walking backwards
  ```

### Hunyuan Video (Tencent) — the physics showcase

- **Text-to-video only** — no image-to-video mode.
- **Best-in-class physics and motion**: water, smoke, cloth, hair — anything with complex real-
  world dynamics looks more convincing here than anywhere else on the roster. Trade-off: slow.
- **Structured template**, in order: subject description + scene + action + camera language +
  atmosphere + style + lighting + shot size. This is more rigid than LTX's flowing-narrative
  style or Wan's formula — Hunyuan responds better to filled-in slots than free prose.
- **Multi-shot syntax**: `[Scene 1] ... camera switch to [Scene 2] ...` for cuts within a clip.
  Sequential action within one shot uses "then" / "after a while" rather than describing
  simultaneous events.
- **Settings**: ~40 steps, CFG ~4.

### Partner Models — max fidelity, no knobs, no LoRAs

Kling, Veo 3, Sora 2, Grok Video, Seedance, HappyHorse, Vidu. Pick these when budget is not the
constraint and you want the highest achievable fidelity, or you specifically need a capability
only they offer:

- **Kling / Veo 3 / Sora 2** — top-tier fidelity. **Veo 3 and Sora 2 generate synced audio**
  natively (dialogue, ambience, foley), the same way LTX does but with tighter lip/action sync.
- **Vidu** — reference-to-video from up to **7 reference images** at once; the tool for "make
  this exact character/scene move" without a LoRA.
- **HappyHorse / Seedance** — strong newer arrivals worth trying alongside Kling/Veo/Sora for
  fidelity work.
- **Grok Video** — the cheap option in this tier: 720p, fast, PG.

Prompting for all of them: **plain cinematic natural language, one scene, one camera move** —
same universal rules as above, just without LoRA support and without an in-house content policy
(they're PG-only regardless of platform).

## Choosing a Model

| Priority | Model |
|----------|-------|
| Cheap iteration, stylized look, need audio | **LTX 2/2.3** |
| Open realism, human subjects, LoRAs, NSFW | **Wan 2.1** (in-house) |
| Physics showcase (water/smoke/cloth), text-to-video | **Hunyuan** |
| Max fidelity, PG, budget not a constraint | **Kling / Veo 3 / Sora 2** |
| Reference-to-video from multiple images | **Vidu** |
| Cheap 720p partner option | **Grok Video** |

## Worked Examples

### LTX 2.3 — cinematic narrative with sound (t2v)

```
A weathered lighthouse keeper stands at the top gallery of a stone lighthouse at dusk, wind
whipping the tails of his coat as storm clouds roll in over a churning sea. He raises a brass
telescope to his eye and slowly scans the horizon, then lowers it and turns to look directly
at the lamp room behind him, where the great lens has just begun to rotate and cast its first
beam into the gathering dark. The camera performs a slow dolly in toward his weathered face as
the light sweeps past, briefly flaring across the lens. Waves crash against the rocks far below
in a steady, heavy rhythm, the sound rising and falling with each swell; wind gusts hiss and
moan around the gallery railing, occasionally rattling a loose shutter below; the lighthouse
foghorn sounds once, low and mournful, in the middle of the shot.
```

Negative prompt: not typically needed on LTX — express unwanted elements positively in the
narrative instead (e.g. write "clear glass, no visible text" rather than relying on a negative
to suppress them).

Params: aspect 16:9, duration 5s, CFG slider mid-to-high (guidance ~5 if run off-platform).

### Wan 2.1 — front-loaded formula with canonical negative (i2v)

Positive (subject + scene + action + camera + lighting + mood, front-loaded, ~100 words):

```
A young woman in a red wool coat walks briskly left to right along a rain-slicked city
sidewalk at night, neon signage reflected in the wet pavement around her feet. She glances
over her shoulder once, mid-stride, then faces forward again and quickens her pace slightly
as a taxi passes behind her, headlights sweeping across the wall. The camera tracks alongside
her at a steady walking pace, holding her at a consistent distance in a tracking shot, never
cutting closer or pulling back. Cool blue-and-magenta neon lighting dominates, with soft rain
haze diffusing every light source. Mood: tense, solitary, electric.
```

Negative (canonical Wan negative, reproduced in full — add task-specific bans after it, don't
replace it):

```
bright colors, overexposed, static, blurred details, subtitles, worst quality, low quality,
JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn
faces, deformed, disfigured, malformed limbs, fused fingers, still picture, cluttered
background, three legs, many people in the background, walking backwards
```

Params: aspect 9:16 (vertical, matches the sidewalk framing), duration 5s. Since this is i2v,
the source frame already fixes her appearance (red coat, face, hair) — the prompt above
correctly describes only motion, camera, and lighting, not her looks.

### Hunyuan — structured template with a scene switch (t2v)

```
Subject: a barn owl perched on a mossy branch, feathers ruffled by wind.
Scene: a dense misty forest at first light, shafts of pale sun cutting through fog.
Action: the owl turns its head slowly toward the camera, blinks once, then launches
silently off the branch. [Scene 1] camera switch to [Scene 2]: the owl gliding low
over a fog-filled forest floor, wingtips nearly brushing the mist.
Camera: static shot on the branch, then a tracking shot following the owl's glide.
Atmosphere: quiet, cold, dawn stillness broken only by the owl's motion.
Style: photorealistic nature documentary.
Lighting: soft diffused backlight through fog.
Shot size: medium shot on the branch, wide shot during the glide.
```

Params: CFG ~4, ~40 steps if run off-platform; on-site, mid CFG slider.

## Common Pitfalls

1. **Booru tags on a video model** — they do nothing; video models were never trained on tag
   soup. Write sentences.
2. **Two camera moves in one prompt** — pick the single move that matters for the shot.
3. **Forgetting sound on LTX or the audio-capable partner models** — if you don't describe it,
   you're leaving the model's differentiating feature on the table.
4. **Re-describing appearance in image-to-video** — the source frame already fixed it; extra
   description competes with it instead of guiding motion.
5. **Asking for 10–20s of complex action** — coherence degrades with length; prefer several 5s
   clips over one long unstable one unless the shot is simple and low-motion.
6. **Loading a video LoRA trained on the wrong Wan variant** (2.1 vs 2.2, T2V vs I2V, high-noise
   vs low-noise) — treat this exactly like an image-model base mismatch. See
   `references/loras.md`.
7. **Expecting an anime-native video model** — none exists; go through the SDXL-still-then-i2v
   path instead.
