# Game shader style: "one hue, all light"

A field guide to the visual language of **Beat Stomper** (Rocky Hong, Android 1.1.1). It covers how its landing, boost and background effects are built and timed, rewritten as three.js / GLSL recipes you can reuse.

This is a teardown of *techniques*, not a clone. The goal is to understand why the game feels the way it does and reuse the approach in your own games. No game assets are reproduced here, and every sample below is original code.

---

## 0. How this was learned (and how sure each claim is)

| Source | What it gave |
|---|---|
| `base.apk` + `split_config.arm64_v8a.apk`, v1.1.1 (versionCode 66). Unity **6000.3.21f1**, IL2CPP, built for **GLES3** | the build |
| Shader blobs, LZ4-decompressed from `data.unity3d` | the real compiled **GLSL ES 3.0** of every shader, plus the pass render states (blend, ZWrite, color mask) |
| 47 materials | which shader, texture and HDR color each effect uses |
| Textures | the alpha profiles of the effect masks (`Ripple2`, `Glow`, `Soft`, `Lomo`, `Grading`, ink, cookie) |
| IL2CPP metadata (v39) string table | the game's class, field and method names (`PlayerBehavior.OnHotSpot`, `ColorChanger.colorAngleTo`, …) |
| Serialized script data, decoded by hand with PPtr anchors | the tuning values (bloom per level, distortion intensity, audio-reactive ratios) |
| 30 fps capture of real play in an ARM64 emulator, with per-frame luma, saturation and hue | the **timings**: stomp → land, flash envelope, fever sequence, beat-synced inversion |

Every non-obvious claim carries a tag: **[extracted]** means read directly from the build, **[measured]** means taken from the video trace, and **[inferred]** means my reading of names plus behavior. The gameplay code is compiled ARM64, so durations hard-coded in C# come from the video, not the source.

**Assets:** [`game-shader-style-assets/`](game-shader-style-assets/README.md) holds:
- free-to-use procedural masks matching the game's (`recreated/`)
- the extracted textures, compiled shaders, decoded tuning data and gameplay capture, for study only (`reference/`, git-ignored)
- the verification harness (`verify/`)

---

## 1. The style in six rules

1. **One hue at a time, and it never stops moving.** Every surface takes its color from one rotating hue angle. The background, platforms, particles, trail, ripples and UI accents are all the same family, with the lightness doing the separating. A `ColorChanger` re-hues a fixed list of 11 materials (`GlowA, Movable, Trail, Button, TapWave, Shade, Symatrick, GlowB, Visulize, RandomColor, AInvert`) by lerping `colorAngleNow → colorAngleTo`. **[extracted]**
2. **Pastel anchors × HDR tints = neon.** The base colors are pastels with channels between 0.5 and 0.8 (`(0.5, 0.8, 0.672)`, `(0.672, 0.5, 0.8)`: the same saturation and value, permuted). The materials then multiply them by **over-range** tints like `(3.0, 0.5, 1.92)`. In an 8-bit target this clamps: the dominant channel pins at 1.0 and the weak ones stay low, which reads as a hot, saturated neon you never authored directly. **[extracted]**
3. **Flat geometry, light does the detail.** Platforms are untextured slabs and the hero is a square with a face. There are no outlines and no normal maps. All the richness comes from additive sprites, soft masks and a **very low bloom threshold** (0.05–0.6 across levels), so almost everything glows a little. **[extracted]**
4. **Blend modes, not shader complexity.** The whole game has three custom shaders: a grab-pass distortion, a two-pass invert and a UI gradient. Everything else is stock Unity sprite and legacy particle shaders. The effects come from choosing the right blend equation: additive light, subtractive "dark glow", and `OneMinusDstColor` inversion. **[extracted]**
5. **The music drives the post.** A `ThemeManager` feeds a smoothed spectrum into bloom, blur and background brightness every frame, with per-level ratios. Bloom gets **weaker** on loud frames (`bloomRate` is negative), so loud passages read crisper instead of muddier. **[extracted values, inferred use]**
6. **Typography is scenery.** The score is drawn a second time as giant, translucent ghost digits behind the action. They punch in on every landing and count past during the boost. **[measured]**

---

## 2. Effect inventory (what each material really is)

From the build, simplified. "×2" means Unity's legacy particle shaders compute `2 · vertexColor · _TintColor · tex`.

| Material | Shader → blend | Mask texture | Role |
|---|---|---|---|
| `TapWave` | Particles/Additive → `SrcAlpha One` (×2) | `Ripple2` (hollow ring) | tap/landing shockwave, tint `(3, 0.5, 1.92, 0.23)` |
| `GlowWave` / `GlowWaveAdd` | Particles/Alpha Blended / Additive | `Ripple2` | softer landing ripple variants |
| `GlowA` / `GlowB` | Sprites/Default / Sprites/Diffuse | `Glow` (one-ended gradient) | vertical light shafts; `glowUpAlpha` / `glowDownAlpha` per level |
| `Shade` | Sprites/Default, premultiplied | `WhiteMid` | full-screen hue wash |
| `Trail`, `Movable`, `Visulize` | Sprites/Diffuse, `_Color (3, 0.5, 1.92, a)` | white | player trail (a 0.14), platforms, spectrum blocks (a 0.30) |
| `AInvert` | Particles/Alpha Blended, `_Color (-1, -1, -1)` | `Default-Particle` | **dark** halo around the hotspot (negative light) |
| `Heat` | `Custom/GrabPass Disortion` | `FlashlightIrregularCookie` (swirl) | boost vortex |
| `InvertMaterial` | `ddShaders/dd_Invert`: pass 1 depth-only, pass 2 `OneMinusDstColor OneMinusSrcAlpha` | none | photo-negative during fever |
| `Ink`, `InkPar` | Particles/Alpha Blended | brush stroke, 2×2 splat sheet | menu and transition ink |
| `CoverBackground` | `UI/UI_Gradient` (ShaderForge) | none | two-color rotated gradient, `_Rotation` 5.8 rad |

Post stack, per camera **[extracted]**: Unity Standard Assets `Bloom` (screen or add blend) with `bloomThreshold` 0.05–0.6, `bloomIntensity` 0.2–1.0 and `sepBlurSpread` 0.5–7.5, plus `BlurOptimized` and `BloomOptimized` on some cameras. The main camera uses threshold 0.6, intensity 0.9 and spread 3. Most levels sit near threshold 0.05–0.15.

### The two shaders worth reading

The **distortion** is the classic grab-pass refraction. Here is the decompiled fragment core **[extracted]**:

```glsl
// Custom/GrabPass Disortion: _IntensityAndScrolling = (0.0, 0.1, 1, 1) on "Heat"
vec2 n   = texture(_MainTex, uv0).xy * 2.0 - 1.0;            // RG = signed offset
vec2 off = n * _IntensityAndScrolling.xy * texture(_MainTex, uv2).z; // B = mask (MASK variant)
color    = texture(_GrabTexture, screenUV + off).rgb;        // refract what's behind
```
The vertex stage scrolls `uv0 += _Time.y * _IntensityAndScrolling.zw`, so the swirl texture drifts while the quad scales up.

The **invert** has an empty fragment shader (`SV_Target0 = vs_COLOR0`). All the work is in the blend state: `Blend OneMinusDstColor OneMinusSrcAlpha`. With white at alpha 1 this gives `1 − dst`, a true negative of whatever was already drawn. Pass 1 writes depth only (`ColorMask 0`), so overlapping geometry never double-inverts. **[extracted]**

---

## 3. Background: five cheap layers that breathe with the music

Back to front, as seen in the capture:

1. **Two-tone vertical gradient** in the current hue: a dark, saturated top and a warmer, lighter bottom. The darkening ramp `Grading` is black with alpha 0 at the top and 1 at the bottom.
2. **Stepped "skyline" blocks**: translucent rectangles in two parallax rows. They are the spectrum visualizer (`Visulize`, alpha 0.3), with block heights following FFT bands.
3. **Light shafts**: two or three thin vertical beams at about 10% alpha. The `Glow` mask fades linearly along its length (0.39 down to 0) and falls off across its width (0.39 at the center, 0.13 at the edges).
4. **Artist watermark** (logo ring plus name) at very low alpha. It scrolls at `ScrollParallex` 0.2–0.4 and sways on `SineMovements`.
5. **Dust**: tiny squares and triangles in the hue color, slowly drifting.

Then a **vignette** (`Lomo`: clear inside r ≈ 0.35, 0.76 at the edges, about 1.0 in the corners) and the low-threshold bloom over everything.

Layers 1–3 and the vignette fit in one full-screen fragment shader. The samples below are three.js `ShaderMaterial` GLSL.

<!-- sample:common.glsl -->
```glsl
// Rotate an RGB color around the grey axis (Rodrigues' formula).
// Luma stays ~constant, so the whole palette can spin without re-authoring a color.
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735026);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
float hash11(float n) { return fract(sin(n) * 43758.5453123); }
```

<!-- sample:fullscreen.vert -->
```glsl
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);   // a PlaneGeometry(2, 2) covers the screen
}
```

<!-- sample:background.frag -->
```glsl
uniform float uTime;
uniform float uHue;           // radians; one value drives the whole palette
uniform float uScroll;        // camera height / screen height (for parallax)
uniform float uPulse;         // smoothed loudness * backgroundColorRatio (about -0.01 to 0.075)
uniform float uInvert;        // 0..1 (the fever negative can also live here)
uniform sampler2D uSpectrum;  // N x 1 texture, smoothed FFT magnitudes 0..1
varying vec2 vUv;

vec3 tone(vec3 base) { return hueRotate(base, uHue); }

// One parallax row of skyline blocks. Each column listens to one FFT band.
float skyline(vec2 uv, float cols, float seed, float parallax) {
  vec2 p = vec2(uv.x * cols + seed, uv.y + uScroll * parallax);
  vec2 id = floor(p);
  float band  = fract(id.x * 0.618 + seed);                 // spread columns over the spectrum
  float level = texture2D(uSpectrum, vec2(band, 0.5)).r;
  float h = 0.15 + 0.35 * hash11(id.x * 7.0 + id.y * 31.0 + seed) + 0.25 * level;
  return step(fract(p.y), h);
}

// Glow-texture shaft: soft across, fading along its length.
float shaft(vec2 uv, float x, float halfWidth) {
  float across = 1.0 - smoothstep(0.35, 1.0, abs(uv.x - x) / halfWidth);
  float along  = 1.0 - 0.6 * uv.y;                          // brighter at the bottom end
  return across * along;
}

void main() {
  vec2 uv = vUv;

  // 1. two-tone gradient, same hue family
  vec3 top    = tone(vec3(0.16, 0.08, 0.30));
  vec3 bottom = tone(vec3(0.62, 0.20, 0.42));
  vec3 col = mix(bottom, top, smoothstep(0.0, 1.0, uv.y));

  // 2. spectrum skyline, two parallax rows (far row is fainter and slower)
  vec3 slab = tone(vec3(0.85, 0.45, 0.70));
  col = mix(col, slab, 0.16 * skyline(uv, 4.0, 0.0, 0.20));
  col = mix(col, slab, 0.22 * skyline(uv, 7.0, 3.3, 0.40));

  // 3. light shafts (additive, ~10%)
  float sway = 0.01 * sin(uTime * 0.7);
  float beams = shaft(uv, 0.36 + sway, 0.035) + shaft(uv, 0.86 - sway, 0.025);
  col += tone(vec3(0.95, 0.65, 0.85)) * 0.10 * beams;

  // vignette (Lomo): clear center, darker rim
  col *= 1.0 - 0.55 * smoothstep(0.30, 0.78, length(uv - 0.5));

  // music: tiny brightness pulse, then optional negative
  col *= 1.0 + uPulse;
  col = mix(col, 1.0 - col, uInvert);
  gl_FragColor = vec4(col, 1.0);
}
```

Why it works: three-plus layers of *low-contrast* shapes in one hue make depth without any detail competing with the gameplay layer. The only full-saturation, full-brightness pixels on screen are the effects.

### Audio → post (the `ThemeManager` loop)

Per-level values decoded from the build **[extracted]**:

| Level | `spectrumRatio` | `smoothRatio` | `bloomRate` | `blurRate` | `backgroundColorRatio` | hue offset |
|---|---|---|---|---|---|---|
| Light | 0.4 | 0.25 | −0.5 | 0 | 0.015 | −34° |
| LevelOne | 0.2 | 0.333 | −1.0 | 0.00025 | 0.075 | 34° |
| Spaze | 0.5 | 0.3 | −0.3 | 0.002 | −0.01 | 90° |
| Forsaken | 0.5 | 0.3 | −0.1 | 0.001 | 0.01 | 45° |

<!-- sample:audio.js -->
```js
// Audio-reactive driver: one smoothed loudness feeds bloom, blur and background.
// Ratios are per level; the defaults are the "Light" level's values.
export function createAudioDriver(analyser, {
  spectrumRatio = 0.4, smoothRatio = 0.25,
  bloomBase = 0.3, bloomRate = -0.5, backgroundColorRatio = 0.015, // bloomBase: UnrealBloomPass strength, see §7
} = {}) {
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const bands = new Float32Array(32);
  let level = 0, prevFlux = 0, lastBeat = -1;
  return {
    bands,
    update(now) {
      analyser.getByteFrequencyData(bins);
      let sum = 0, flux = 0;
      for (let b = 0; b < bands.length; b++) {
        const i = Math.floor(Math.pow(b / bands.length, 2) * bins.length); // log-ish spacing
        const v = bins[i] / 255;
        flux += Math.max(0, v - bands[b]);              // spectral flux = onset energy
        bands[b] += (v - bands[b]) * smoothRatio;      // the game's per-frame lerp
        sum += bands[b];
      }
      level += ((sum / bands.length) * spectrumRatio - level) * smoothRatio;
      const beat = flux > prevFlux * 1.5 && flux > 0.6 && now - lastBeat > 0.25;
      if (beat) lastBeat = now;
      prevFlux = flux;
      return {
        bloomStrength: Math.max(0, bloomBase + bloomRate * level), // louder -> crisper
        pulse: backgroundColorRatio * level * 10,
        beat,
      };
    },
  };
}
```

---

## 4. The hue system (`ColorChanger`)

A single angle drives everything. The game keeps `colorAngleNow` and `colorAngleTo` and eases between them with `colorMinLength` and `colorMaxLength` bounding the jumps. Each level also starts from its own `colorAngle` offset (the table above). Materials sit in roles: **A** (glow, platforms, trail, button, tap wave, wash), **B** (secondary glow), **C** (visualizer), a random-color role, and the **inverted** role (`AInvert`), which gets the negative of the current color. **[extracted names, inferred mechanics]**

What you see in the capture **[measured]**: during normal play the mean screen hue drifts slowly (about 215° → 250° → 280° over 3 s, roughly one shift per landing). During the boost it **jumps about 180° on every beat**.

<!-- sample:hue.js -->
```js
// One angle to rule the palette. Feed `uHue` to every material that should follow it.
export class HueDirector {
  constructor(start = 0) { this.now = start; this.to = start; }
  nudge(min = 0.35, max = 0.9) {               // on landing: step to a nearby hue
    this.to += (min + Math.random() * (max - min)) * (Math.random() < 0.5 ? -1 : 1);
  }
  flip() { this.to += Math.PI; this.now = this.to; } // fever beat: snap to the complement
  update(dt, rate = 4) { this.now += (this.to - this.now) * (1 - Math.exp(-rate * dt)); return this.now; }
}
```

Three rules that make this look designed rather than random:
- **Lightness separates the layers, not hue.** The background is about 0.2–0.6 luma, platforms about 0.75, effects clip at 1.0.
- **Accents shift the hue a little.** The stomp disc is the same family moved about 30° (pink → red).
- **The "dark" effect is the hue's negative**, not grey (see `AInvert`, §6).

---

## 5. Landing: stomp → impact

### Timeline **[measured at 30 fps, 5 of 5 stomps identical]**

| t | What happens | Technique |
|---|---|---|
| −167 ms | **Tap to stomp.** For 1–2 frames the square is drawn as a **smear bar** (about 1.4× wide, 3× tall) over a big **disc** about 0.78 screen widths across, in an accent hue. Screen luma +10–15. | smear frame instead of motion blur, plus a flat `Soft` disc |
| ≈ −120 ms | The bar **squashes** wide (about 3× wide, 0.8× tall) while a thin **column** links it to the platform below. | squash before contact, speed line |
| **0** | **Impact.** Luma more than doubles (62 → 150) in **1 frame** (or ramps over ≤ 100 ms as the disc grows). | additive stack + bloom |
| 0 → 100 ms | **Hold.** A white-hot vertical **beam** through the impact point, an **expanding hollow ring** (`Ripple2` profile), a horizontal light line, a burst of **square shards** in the hue color, and the **giant ghost digit** of the new score. | additive sprites, particle burst, ghost text |
| 100 → ~600 ms | **Fade**, roughly linear: 84% → 66% → 45% → 21% → 2% of the peak in 100 ms steps. The ring keeps growing and thins out, shards fly up and out, the camera eases up one floor. | linear envelope, ring scale ease-out |

The stomp-to-impact delay is the fall time and was 167 ms in every sample. The game's rhythm gives you that 167 ms of anticipation for free.

### The pieces

<!-- sample:ring.frag -->
```glsl
// Procedural Ripple2: hollow center, linear ramp to a hard rim.
// Measured texture profile: alpha 0 until r = 0.27, then linear to 1.0 at r = 1.
uniform vec3  uColor;   // HDR tint is fine (e.g. 3.0, 0.5, 1.92); additive blending clamps it
uniform float uAlpha;   // envelope
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = clamp((r - 0.27) / 0.73, 0.0, 1.0);
  a *= 1.0 - smoothstep(0.97, 1.0, r);          // anti-aliased hard rim
  gl_FragColor = vec4(uColor, a * uAlpha);      // use with THREE.AdditiveBlending
}
```

<!-- sample:beam.frag -->
```glsl
// Landing beam: white-hot core with a wide soft halo, fading at both ends.
uniform vec3  uColor;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float core = pow(across, 8.0);
  float halo = across * across * 0.35;
  float along = smoothstep(0.0, 0.2, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y));
  gl_FragColor = vec4(uColor, (core + halo) * along * uAlpha); // AdditiveBlending
}
```

<!-- sample:mesh.vert -->
```glsl
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

<!-- sample:juice.js -->
```js
// Envelopes measured from the game (seconds).
export const LAND = { attack: 0.0, hold: 0.10, fade: 0.50, bloomKick: 0.85 };

export function envelope(t, { attack, hold, fade }) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  if (t < attack + hold) return 1;
  return Math.max(0, 1 - (t - attack - hold) / fade);       // linear fade, as measured
}

// Squash & stretch for the stomp. Returns [scaleX, scaleY] relative to the square.
// tStomp = seconds since the stomp tap (impact lands at ~0.167 s).
export function stompScale(tStomp) {
  if (tStomp < 0.05) return [1.4, 3.0];                     // smear frame
  if (tStomp < 0.167) return [3.0, 0.8];                    // squash toward contact
  const k = Math.min(1, (tStomp - 0.167) / 0.18);           // settle after impact
  const s = 1 + 0.25 * Math.sin(k * Math.PI) * (1 - k);
  return [s, 2 - s];
}

// Fire everything for one landing. `fx` holds your meshes/materials; `t` is seconds since impact.
export function landingFrame(fx, t, hue) {
  const e = envelope(t, LAND);
  const grow = 1 - Math.pow(1 - Math.min(1, t / 0.6), 3);  // ring scale, ease-out cubic
  fx.ring.scale.setScalar(0.4 + 2.6 * grow);
  fx.ring.material.uniforms.uAlpha.value = 0.23 * 2 * e;    // TapWave tint alpha 0.23, x2 like legacy particles
  fx.beam.material.uniforms.uAlpha.value = e;
  fx.ghostDigit.material.opacity = 0.35 * e + 0.08;         // ghost score: punch in, settle faint
  fx.bloom.strength = fx.bloomBase + LAND.bloomKick * e;    // the bloom spike makes the white-out
  fx.camera.position.x = fx.cameraX + 0.04 * e * Math.sin(t * 90); // tiny shake (perlin in the game)
}
```

Shards: spawn 12–20 small squares (the hero's own shape) at the impact point. Give them random upward and outward velocity, spin, and the hue color at alpha 0.6–0.9, and let gravity pull them over about 0.8 s. Debris should look like "pieces of the player", never generic sparks.

---

## 6. The boost: hotspot → FEVER → multi-floor climb

In the code this is `PlayerBehavior.OnHotSpot` → `hotSpotPar`, `ringPar`, `climaxPar`, `slowMotion`, `DistortionWave.PlayAtPos`, `InvertController`, `LevelDesign.TweenUP`, ending with `climaxEnd` **[extracted names]**. The trophies `TotalHotSpots`, `HotSpotsInOneGame` and `WithOutBoost` confirm that the hotspot is the game's "boost".

### Timeline **[measured]** (t = 0 at the hotspot impact)

| t | What happens | Technique |
|---|---|---|
| before | A **gem** sits on a platform under a pulsing **"FEVER ▼"** hint (the `Flash` component, rate 10). Behind it is a **dark halo**: light *removed*, not added. | negative-color particle (`AInvert`, `_Color (-1, -1, -1)`) or subtractive blend |
| −167 ms | Normal stomp smear and disc. | §5 |
| 0 → 130 ms | Impact flash ramps to its **brightest of the session** (luma 103 → 196). Concentric rings, giant digit. | additive stack + bloom |
| 0 → ~750 ms | A **swirl vortex** grows from the impact and twists the whole screen. Serialized `DistortionWave`: **intensity 0.1, target scale 10×, about 1.25 s lifetime**. | grab-pass / post-pass refraction |
| ~450–750 ms | The screen floods a flat light cyan (bloom-saturated); the hero sits inside a hand-drawn **ring**. A secondary flash comes at +0.77 s. | bloom flood, ring sprite |
| **+1.10 s** | **One full-white frame** (luma 202), then **instantly** the negative world (luma 55). | white frame as a hard cut, then the invert pass |
| +1.1 → ~5.1 s | **The climb.** The hero (now with jaws, the `Crusher`) rockets up inside a light bubble, **chewing through platforms** into square shards. The camera tweens up about **20 floors in about 4 s**. Ghost digits count past at full screen height. **Every beat** (about 0.45 s, roughly 135 BPM for this track) the palette **flips to its complement** and the invert toggles: red → violet → green → red → teal. | beat-synced `HueDirector.flip()` + invert, camera tween |
| end | `climaxEnd`: a final bright flash (luma 197), then normal play resumes in a new hue. | flash envelope |

Why it feels huge with so little tech:
- **Contrast in time.** The fever opens with the brightest frame in the game and immediately cuts to the darkest (the white frame and then the negative). Your eye reads that as a scene change.
- **Inversion is free spectacle.** One blend mode turns every layer, bloom included, into a new palette. Flipping it on the beat makes the music *visible*.
- **The distortion only bends what's already there**, so it inherits the hue and never looks pasted on.
- **The camera does the "few floors" part**: one long eased tween while geometry is destroyed in passing, not a teleport.

### The pieces

<!-- sample:swirl.frag -->
```glsl
// Post-pass swirl: the DistortionWave/Heat effect as a three.js ShaderPass.
// Original: offset = (cookie.rg * 2 - 1) * 0.1, sampled from the grab texture,
// on a quad that scales up to 10x. Here the cookie is procedural.
uniform sampler2D tDiffuse;
uniform vec2  uCenter;     // 0..1 screen space
uniform float uRadius;     // current wave radius, in screen heights
uniform float uIntensity;  // starts at 0.1 (serialized "intense"), eases to 0
uniform float uAspect;     // width / height
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 d = vUv - uCenter;
  d.x *= uAspect;
  float r = length(d);
  float x = r / max(uRadius, 1e-4);
  // donut-shaped strength, like the cookie: zero at the eye and outside the wave
  float ring = smoothstep(0.0, 0.35, x) * (1.0 - smoothstep(0.55, 1.0, x));
  vec2 dir = r > 1e-5 ? d / r : vec2(0.0);
  vec2 tangent = vec2(-dir.y, dir.x);
  float lobes = sin(atan(d.y, d.x) * 3.0 + uTime * 6.0 - r * 18.0); // irregular swirl arms
  vec2 offset = (tangent * (0.8 + 0.4 * lobes) + dir * 0.35 * lobes) * ring * uIntensity;
  offset.x /= uAspect;
  gl_FragColor = texture2D(tDiffuse, vUv + offset);
}
```

<!-- sample:fever.js -->
```js
import * as THREE from 'three';

// The invert pass: dd_Invert's blend state on a full-screen quad drawn last.
// result = src * (1 - dst) + dst * (1 - srcAlpha). With src = white * a and alpha = a,
// this is lerp(dst, 1 - dst, a).
export function createInvertQuad() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneMinusDstColorFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  quad.renderOrder = 1e6;
  quad.onBeforeRender = (r, s, cam) => quad.position.copy(cam.position); // keep it on screen
  quad.setAmount = (a) => { mat.color.setScalar(a); mat.opacity = a; quad.visible = a > 0; };
  quad.setAmount(0);
  return quad;
}

// The dark halo around the hotspot: light removed, not added (AInvert's negative color).
// three.js only allows SubtractiveBlending on premultiplied-alpha materials.
// Keep it faint: at full strength it punches a black hole instead of a dim halo.
export const darkGlowMaterial = (map, strength = 0.3) => new THREE.SpriteMaterial({
  map, color: new THREE.Color(strength, strength, strength), blending: THREE.SubtractiveBlending,
  premultipliedAlpha: true, transparent: true, depthWrite: false,
});

// Fever timeline (seconds since hotspot impact). Measured from the game.
export const FEVER = {
  swirl: { duration: 1.25, intensity: 0.1, endRadius: 1.6 },
  flood: { from: 0.30, amount: 0.45 },
  whiteFrameAt: 1.10,
  climb: { start: 1.10, duration: 4.0, floors: 20 },
};

const easeInOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export function feverFrame(fx, t, beat, hue) {
  // 1) swirl vortex
  const k = Math.min(1, t / FEVER.swirl.duration);
  const swirl = fx.swirlPass.uniforms;
  swirl.uRadius.value = FEVER.swirl.endRadius * (1 - Math.pow(1 - k, 2));
  swirl.uIntensity.value = FEVER.swirl.intensity * (1 - k) * (t >= 0 ? 1 : 0);
  // 2) flood: a light wash ramps over the screen before the cut (a flat tint, independent of
  //    how bright the current hue is), then one pure white frame as a hard cut
  const f = Math.min(1, Math.max(0, (t - FEVER.flood.from) / (FEVER.whiteFrameAt - FEVER.flood.from)));
  const isWhiteFrame = t >= FEVER.whiteFrameAt - 0.02 && t < FEVER.whiteFrameAt + 0.02;
  fx.whiteout.setAmount(isWhiteFrame ? 1 : t >= 0 && t < FEVER.whiteFrameAt ? FEVER.flood.amount * f * f : 0);
  // 3) the climb: one eased tween across many floors; invert + complementary hue on every beat
  const c = (t - FEVER.climb.start) / FEVER.climb.duration;
  if (c >= 0 && c <= 1) {
    fx.camera.position.y = fx.climbFromY + easeInOutCubic(c) * FEVER.climb.floors * fx.floorHeight;
    if (!fx.climbing) { fx.climbing = true; fx.inverted = true; hue.flip(); } // hard cut into the negative
    else if (beat) { fx.inverted = !fx.inverted; hue.flip(); }
    fx.invert.setAmount(fx.inverted ? 1 : 0);
  } else if (c > 1 && fx.climbing) {
    fx.climbing = false; fx.inverted = false; fx.invert.setAmount(0); // climaxEnd: back to normal
  }
}
```

---

## 7. Porting notes (three.js)

- **Work in gamma space, like the original.** Every color in this doc is a display (sRGB) value, and the game blends in gamma space. In three.js, turn color management off so the numbers mean the same thing: `THREE.ColorManagement.enabled = false; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;`. With the defaults, three.js treats shader output as linear and brightens it about 2× on output; the first verification run measured exactly that.
- **Post order.** Render the scene (background quad → world → additive FX → invert quad), then the swirl `ShaderPass`, then `UnrealBloomPass`, then `OutputPass`. Bloom must come *after* the invert, as in the game (the invert is a world object and bloom is a camera effect), so the negative world glows too.
- **Bloom mapping (calibrated, not guessed).** `UnrealBloomPass` sums five blur levels, so it is much stronger than Unity's Standard Assets Bloom at the same numbers. A naive mapping (threshold 0.15, strength 0.9) turned the whole frame white in the first verification run. Matched against the real game's landing (baseline luma, peak ratio and fade time, §8): **threshold 0.75, radius 0.6, resting strength 0.3, landing kick +0.85**. The game pairs a low threshold with low intensity (0.05 / 0.25) or a high threshold with high intensity (0.6 / 0.9). Never combine a low threshold with high strength.
- **HDR tints.** If your render target is half-float, values over 1 survive into bloom (a stronger glow than the original's 8-bit target). To match the original's neon clamp exactly, clamp `min(color, 1.0)` in the FX shaders.
- **Additive ×2.** Unity's legacy particles double the color (`2 · vertex · tint · tex`). When copying tint numbers, double them or the effect looks weak.
- **Cost.** Everything here is one full-screen background, a handful of quads, one post distortion and bloom. The original runs on low-end phones with GLES3 mediump.

---

## 8. Verification

The samples above are not just illustrative. A harness extracted every `<!-- sample:… -->` block from this file, compiled it in headless Chromium (WebGL2) with three.js 0.187, rendered a scripted landing and fever, and compared the result against the capture of the real game. Results are in §8.1.

### 8.1 Results (2026-11-21, Chromium + ANGLE Metal, Apple M4 Pro, 6 seeds)

The same luma metric was run on the game capture and on the reproduction.

| Check | Real game | This doc's code | Verdict |
|---|---|---|---|
| All GLSL/JS samples compile and run | n/a | 11 samples, 17 GPU programs, **0 errors, 0 warnings** | pass |
| Resting luma (normal play) | 61–108 | 95 | pass |
| Landing peak ÷ resting | 1.44–2.48 | 2.09–2.41 | pass |
| Time to peak after impact | +33 to +167 ms | +100 to +133 ms | pass |
| Back within 10% of resting | +434 to +533 ms | +533 to +567 ms | about 1 frame slow on 4 of 6 seeds |
| Beat detector on 135 BPM | 0.444 s | 0.445 s mean | pass |
| Fever: first negative frame | right after the white frame | right after the white frame (+1.10 s) | pass |
| Fever: hue flip per beat | ~180° every ~0.445 s | 178–180° every 0.433–0.467 s | pass |
| Cut depth: white → first negative | 202 → 55 (−73%) | 255 → 96–132 (−48 to −62%) | shallower |

What the verification changed in this doc:
1. `SubtractiveBlending` needs `premultipliedAlpha: true` in three.js r187.
2. The doc now says to work in gamma space.
3. The bloom values are calibrated against the game's landing curve instead of guessed.
4. The fever now cuts straight into the negative, instead of waiting for the next beat.
5. The pre-cut flood uses a light wash instead of bloom, because bloom fails on dark hues.
6. The dark halo has a strength default.

Known gaps:
- **The cut is shallower.** The depth of the drop depends on how bright the scene is before it, and the game's fever scene is brighter than the test scene.
- **Some of the scene isn't covered by the samples.** The test scene omits shards, dust and the watermark, so it is a structural match, not a pixel match.
- **Hard-coded durations are measured, not read.** Durations compiled into the game's C# come from 30 fps video, so they are accurate to about ±33 ms.
