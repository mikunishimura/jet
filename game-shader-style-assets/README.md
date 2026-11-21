# game-shader-style assets

Companion folder for [`../game-shader-style.md`](../game-shader-style.md). It has two halves with different rules:

| Folder | What | Can you ship it? |
|---|---|---|
| `recreated/` | **Original** procedural masks, generated from the measured profiles, plus the generator | **Yes.** Made for this project and free to use |
| `reference/` | Effect masks, compiled shaders, tuning data and gameplay capture **extracted from Beat Stomper 1.1.1** (© Rocky Hong) | **No.** Study only. Kept out of git via `.gitignore` |
| `verify/` | Harness that compiles the doc's code samples and measures them against the capture | Yes (our code) |

Logos, artist art, UI icons and the character were deliberately left out. They're branding, and they don't help with learning the shader style.

---

## `recreated/`: use these

Regenerate at any size with `python3 recreated/generate.py --size 1024` (needs Pillow).

| File | Replaces | Use | Match to reference |
|---|---|---|---|
| `ripple.png` | `Ripple2` | hollow shockwave ring for landings and taps; scale it up while fading | radial alpha within 1/255 |
| `glow.png` | `Glow` | light shafts and landing beam (fades along its length) | same 0 → 0.39 ramp and cross falloff |
| `soft.png` | `Soft` | flat disc with a feathered edge (stomp disc, bubble) | within 18/255 |
| `vignette.png` | `Lomo` | black-alpha vignette over everything | within 1/255 |
| `grading.png` | `Grading` | black-alpha darkening ramp, top → bottom (4 px wide; stretch it) | exact (linear) |
| `ring-wipe.png` | `Ring` | radial progress ring: alpha ramps clockwise from 12 o'clock; animate `alphaTest` 0 → 1 to wipe | same idea, own geometry |
| `swirl-cookie.png` | `FlashlightIrregularCookie` | distortion map for the grab-pass math: `offset = (rg * 2 - 1) * 0.1`, `b` = mask | functional equivalent: the doc's `swirl.frag` field baked to a texture |
| `shards.png` | n/a | 2×2 sheet (square, diamond, triangle, sliver) for the landing debris burst | n/a |

All of them are white or black with the shape in **alpha**, so tint them with the current hue (see `hueRotate` in the doc) and pick the blend mode per use: additive for light, normal for washes.

---

## `reference/`: study material (not for shipping)

### `textures/`
The original effect masks: `Ripple2`, `Glow`, `Soft`, `Lomo`, `Grading`, `Fade`, `FlashlightIrregularCookie` (the vortex cookie), `Ring`, `Ink2`, `InkPar` (2×2 ink-splat sheet) and `Default-Particle` (Unity built-in). `_contact-sheet.png` shows RGB on top and alpha below.

### `shaders/`
- `*.gles3.glsl`: the **real compiled GLSL ES 3.0** of the game's three custom shaders (every variant; vertex and fragment are interleaved as Unity's HLSLcc emits them):
  - `Custom_GrabPass_Disortion`: grab-pass refraction, with RG = signed offset and B = mask.
  - `ddShaders_dd_Invert`: the fragment shader is trivial; the invert is all blend state.
  - `UI_UI_Gradient`: a rotated two-color gradient (ShaderForge).
- `render-states.txt`: the blend, color mask, ZWrite and cull of each pass. This is where the invert (`OneMinusDstColor OneMinusSrcAlpha`) and additive (`SrcAlpha One`) live.
- `shaderlab-properties.txt`: the property blocks and tags of the custom shaders.

### `data/`
- `materials.json`: all 37 gameplay materials, with shader, passes and blend, textures and HDR colors.
- `tuning.json`: decoded script values: the hue-system material roles and pastel anchors, `ThemeManager` audio-reactive ratios per level, **every `Bloom` camera** (22, by script), the distortion wave, parallax and sine values. Entries marked `mappingInferred` are values matched to field names by order.
- `timings.json`: the measured landing and fever timelines (±33 ms).

### `audio/` (listen only)
All 109 clips from the game, decoded from its compressed audio banks:
- `effects/`: the sounds behind the effects in the doc: `Stomp01`–`06`, `Stomp`, `Landing01`/`02`, `Hit01`–`05`, `HitWall`, `WHOOSH_Wide_Slow`, `HotSpot`, `Charge01`, `ComboStart2`, `Crusher` and the "Fever Time" voice line.
- `other-clips/`: UI sounds, voice callouts and score announcements.
- `music/`: the 9 level tracks, as AAC at 192 kbps.

The music belongs to the credited artists. Several effects have stock-library names, so they come from commercial sound packs licensed to the game's developer, not to us. Don't ship or commit any of it.

### `capture/`
- `gameplay-landings-and-fever.mp4`: 14 s of real play (540 px wide), with 5 landings, one hotspot/fever and the climb.
- `landing.png`, `stomp.png`, `fever.png`, `invert.png`, `background.png`: labeled frame strips (timestamps in seconds).
- `compare-game-vs-doc-code.png`: top row is the game, bottom row is the doc's code at matched moments.
- `luma-trace.csv`: per-frame `t, luma, saturation, hue` for the clip, which is the basis of every timing in the doc. Load it in a spreadsheet and plot luma to see the landing envelopes.

---

## `verify/`: re-run the check after editing the doc

From the repo root:

```bash
node game-shader-style-assets/verify/extract.mjs game-shader-style.md game-shader-style-assets/verify/samples
python3 -m http.server 8766 --bind 127.0.0.1 &          # serve the repo root
npx -y -p playwright@1.56.1 node game-shader-style-assets/verify/run.cjs \
  "http://127.0.0.1:8766/game-shader-style-assets/verify/index.html?seed=1" /tmp/shader-check
python3 game-shader-style-assets/verify/score.py /tmp/shader-check/result.json fever
```

If `npx -p` doesn't put playwright on Node's path, run `npm i -D playwright@1.56.1` once instead.

The score line prints the resting luma, the landing peak and its ratio, the time back to baseline, and the white-frame/negative values. Compare them with the targets in the doc's §8.1 table. `?seed=N` changes the random hue steps, and the URL flags `nobloom`, `nobg`, `noplat` and `nofx` switch layers off for debugging.
