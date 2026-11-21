# JET//LAB

Infinite procedural POV jet game in three.js. Fly straight to break speed barriers. The first one breaks right after launch; each next one asks for a straighter line than the last, and tier V needs you dead straight. Dodge close to obstacles to charge faster. Survive drones, UFOs and fighters. The score is how long you last and how far from spawn you get.

```bash
npm install
npm run dev        # http://127.0.0.1:5199
npm test           # speed-tier, collision and flight-model tests
npm run build
```

URL flags: `?autopilot` (the bot flies), `?god` (enemy fire does no damage). Console: `__jet.debug.info()`, `.setTier(n)`, `.spawn('drones'|'ufo'|'fighters')`, `.pickup()`, `.gate()` (fires a survey-gate pass).

## Controls

| Key | Action |
|---|---|
| **W** tap | launch / snap both sticks to center (fly straight and level) |
| **W** hold | charge the next speed barrier while you hold your line (the first one, tier II, charges by itself right after launch) |
| **A / D** hold | bank left / right. Short taps trim by fractions of a degree |
| **S** hold | bleed charge, then drop one tier every 0.75 s (down to I) |
| **Space** / **Shift** hold | climb / dive (also **↑ / ↓**). Release and the nose auto-levels at the new altitude. A **W** tap snaps you level and straight |
| **Mouse** | look + aim (pointer lock: click the game). Never steers the jet: the camera orbits / your head turns, and the crosshair is where shots go. Eases back to forward after ~1.6 s idle; **Q** / middle mouse snaps back |
| **LMB** / **J** | minigun down the crosshair (both guns converge on it). Assist leads a target only within ~14° of the crosshair (crosshair turns red). Overheats after ~3 s |
| **RMB** / **K** | salvo of 4 homing missiles on the locks nearest the crosshair; with no lock they fly straight down the crosshair (8 max, they reload) |
| **C** | chase camera (default: far behind, horizon never tilts) ↔ cockpit POV (banks with the stick). Remembered |
| **M** | mute |
| **O** / **Esc** | settings. Esc mid-flight (it releases the mouse) pauses the game with the settings window; Esc or `[ resume ]` continues |

## Mechanics (all numbers in `src/config.js`)

| Tier | Name | Speed | Mach | Hold the line within | For |
|---|---|---|---|---|---|
| I | Hypersonic | 3.0 km/s | 16 | n/a | n/a |
| II | Scramjet | 5.2 km/s | 28 | ±10° | 0.5 s (automatic right after launch) |
| III | Orbital | 8.0 km/s | 43 | ±4.5° | 2.0 s |
| IV | Escape | 12.4 km/s | 66 | ±1.8° | 2.6 s |
| V | Interstellar | 19.0 km/s | 101 | ±0.4° | 3.2 s |

The first Mach change comes about 0.5 s after launch. `tierLevel()` maps any tier count onto a 1–5 intensity for the systems that scale with speed (view distance, crash damage, buffet, fog, flames, audio pitch); with five tiers it is the tier itself.

**Speed and scale.** All speeds are 20× the original tuning (`SPEED_SCALE`). To keep that playable, the far field (terrain, path obstacles, view distance, fog, event spacing, cloud deck) scales by `WORLD_SCALE` = 20, so time-to-contact stays human (about 5 s of warning at tier V). The near field (flight altitude, ground grid, camera) keeps its size, so speed *feels* 20× faster. The ground grid fades out line spacings that would strobe at the current speed. Combat (enemies, bullets, missiles, their effects) runs in the player's moving frame and is not scaled. **FOV** grows continuously with Mach on a log scale (`FOV` in `src/config.js`), roughly 66° at M8 to 112° at M110.

- **Straight means 3D straight.** Climbing or diving breaks the line just like turning. The large HUD ring is your tolerance window (it turns red and dashed when you're off the line, and an arc around it shows the barrier charge); keep the small aim ring inside it.
- **Altitude** (log-scale altimeter on the right): fly anywhere from the floor (6 m) to the **24 km containment ceiling**, far above the **cloud deck at 8 km**. The deck is real geometry: you can punch through it and fly over it. You spawn midway in the **obstacle band** (6–1,500 m, ~750 m), where the rocks and path events are. Below 60 m you get ground effect (barriers ×1.3, fewer waves) but solid rubble. Above 1,000 m radar exposes you (waves ~1.7× as often, up to 2 extra hostiles, barriers ×0.75), so the open sky is safe from rocks but hot with enemies. Pinned against the ceiling or resting on the floor, the nose levels and vertical velocity is zero, so nothing that flies in your frame drifts.
- **The world is round (visually).** Every world vertex is lowered by d²/2R around the camera. R ≈ 2,500 km near the floor (flat, with slightly rounded far edges where things rise over the horizon) and R ≈ 300 km at the ceiling (clearly a sphere). See `src/render/curvature.js`. Collisions stay flat.
- **Ground contact** follows the same rule as rocks: dive more than ~20° into the floor and it's a head-on hit; skim it and you just scrape along.
- **The map is built for long, mostly straight runs.** Open plains, with rock fields and mountain ridges only inside rare mountain regions (never in the first ~4 km). Obstacles come **down your path**: every ~5–9 s of flight (time-based, so the rhythm is the same at any tier) a structure appears ahead on your current heading, about half on your line and half near misses. Many reward holding your line: spire pairs you thread, gates on the line. Walls with a gap appear from tier III (or at high difficulty). Mountain vistas off to the side are just scenery. Tune it in `WORLD_DENSITY` and `PATH` in `src/config.js`.
- **Crosswind gusts** grow with tier. They are a random process with no predictable calm spots, so higher tiers need active trimming. The heading tape at the top shows the line you're holding and its tolerance window. The needle under the speedometer shows your deviation.
- **Velocity is never taken away by enemies.** Damage only costs hull (and the run at 0); there is no hull cap and no tier loss from hits. Green repair beacons (+40 hull) spawn more often when the hull is below 40.
- **Terrain**: hitting a rock or mountain head-on (impact angle within ~44° of its center) does heavy damage and costs one tier (`COLLISION.tierLossOnHeadOn`). Clipping an edge just slides you along the surface.
- **Near misses**: pass an obstacle within ~1.8 km of its surface (plus 50 ms of travel at your speed) without touching it and the barrier charges 12–35%, more the closer you were, +100–400 points. Threading a gap in a wall counts once per side. The path spawns about half its obstacles as near misses, so dodging late is rewarded.
- **Survey gates** (orange-striped arches): flying through adds 35% barrier charge and +500 points.
- Score = 0.1 point per meter from spawn + 5 per second + kills (bonus for kills at high tier) + gates + near misses. Best time, range and score are saved in localStorage.

## Settings

A terminal-style settings window: **O**, the `[ settings ]` buttons on the menu and death screens, or **Esc** mid-flight, which doubles as the pause screen. Changes apply live and persist in localStorage (`src/core/Settings.js`, values sanitized and clamped).

- **Audio:** mute, master volume, engine & wind bus, effects bus.
- **Controls:** mouse sensitivity, invert Y, auto-recenter on/off, recenter delay.
- **View:** chase or cockpit camera, field-of-view offset (±15°), render scale (50–150 %, for performance), show FPS.
- **Effects:** *flashes & inversion* (turn off for a photosensitivity-safe mode: no color inversion anywhere, white flashes dimmed), screen-effect intensity, camera shake, speed blur.

Adding a setting takes a default in `DEFAULTS` plus one row in `SCHEMA` (`src/ui/SettingsPanel.js`), applied in `Game.applySettings()`.

## Look

Effects are vector-style, never realistic: explosions are expanding wireframe shells and rings plus hard square and `+` glyphs that blink out in steps; contrails are 1 px lines that trace your trajectory; missile trails are hollow square dots. No smoke, no soft gradients.

**Sky.** A procedural anime sky (`src/world/Sky.js`): saturated blue gradient, crisp white sun, and cel-shaded clouds (white tops, periwinkle shadows, thin drawn outlines) in three layers. Horizon cumulus towers only rotate when you turn. A high cumulus field drifts slowly. A low puff layer at ~8 km rushes overhead and smears into speed streaks along your flight direction as Mach rises. The smear is symmetric around each point, so the cloud field never slides when only speed changes (an earlier version rescaled it around the camera, which made clouds drift at launch and at every barrier; measured now: 0 px shift). The noise is 256-periodic, so the camera offset wraps and the sky stays crisp after any distance. The fog color equals the sky's horizon color, so terrain melts into the sky.

**Obstacles** are near-black solids with a white **silhouette-only** border: no lines across facets. It's an inverted-hull outline pass (back faces pushed out ~1.6 px in screen space along smoothed normals, thinning with distance), one extra draw call per chunk, in `outlineMaterial()` (`src/render/materials.js`). The floor grid is hairline (~1 px).

**Event juice** (timing and shapes ported from the teardown in `game-shader-style.md`, drawn as inversion masks so they never add a color). Everything radiates **from the jet on screen**: shockwaves, vortex, rings and beam bend space around it while the jet itself sits in a calm, crisp eye.
- A **survey gate** is a "landing" hit. The jet smears, then squashes. A hollow ink ring grows from the jet, with a beam and a hairline, a giant ghost gate count and a burst of ink squares. It peaks within 100 ms and is gone by about 0.5 s.
- The **first Mach change** (tier II, right after launch) pops: shockwaves from the jet, a ring, the new Mach number as a giant ghost (`M28`), a short hit-stop and a crack-and-thump sound with a bright ping.
- A **near miss** is a small, fast hit with a doppler whoosh and a `CLOSE` ghost.
- Tiers **III, IV and V** get the full "boost". A vortex twists space around the jet and the edges flood toward paper-white (the jet and the line ahead stay clear). One white frame cuts hard into the negative world, which flips on the beat for 2–4 beats with the tier's numeral as a giant ghost. The beat speeds up with Mach (0.445 s → 0.34 s), never past 3 flips per second (WCAG 2.3.1, enforced by a test).

All numbers are in `JUICE` (`src/config.js`), and the timelines in `src/render/Juice.js`.

**Ambient layer** (always on, Beat Stomper's background motion for a velocity game). A conductor (`src/render/Ambient.js`) turns speed, barrier charge, the engine's own sound (a frequency analyser on the engine and effects buses, before the user volume) and a beat clock whose tempo rises with Mach into what the layer draws (`src/render/AmbientLayer.js`):
- **Engine visualizer**: a ring of translucent ink columns standing on the horizon, a stepped skyline whose heights follow the engine spectrum; gunfire and barrier charge make columns jump.
- **Beat wave**: on every beat a band runs down the floor grid toward the horizon. It only darkens grid lines (measured: < 0.2% screen luminance, far from the 10% that makes a flash).
- **Distance numerals**: giant `NNN KM` markers lie on the floor every 10 km and rush under you.
- **Mach in the sky**: the live Mach number, huge and faint, painted ahead of you behind the clouds.
- **Toward space**: the zenith darkens and stars come out as you climb tiers.
- **Megastructure**: a colossal wireframe ring rises over the horizon, slowly turning, closer at higher tiers.
- **Light shafts**, **ink dust** you rush through, **dark halos** on enemies and incoming missiles that swell on the beat, and a slight **breathing** of vignette and blur with engine loudness.

It fades out during the boost negative, follows the `fx.intensity` setting (the beat wave stops with `fx.flashes` off), and `AMBIENT.master = 0` turns it off. Every number is in `AMBIENT` (`src/config.js`).

Restricted palette: a pure white world (measured R = G = B on screen; neutral lighting, no warm tints, light vignette, no constant chromatic fringing), black obstacles, grays for everything else, and a single accent (red) reserved for hostiles, damage and warnings. The palette lives in `PALETTE` (`src/config.js`) and the CSS variables in `src/style.css`. The UI is a flat terminal style: JetBrains Mono everywhere, block-character bars (`[████░░░░]`), a timestamped event log, terminal-window menus, and no glow, blur or shadows.

## Architecture

```
src/
  config.js              every tuning number
  game/
    SpeedSystem.js       pure tier state machine (unit-tested)
    Collision.js         circle (height-profiled) / capsule colliders, 3D normals, head-on vs edge (unit-tested)
    Player.js            stick model, gusts, hull, terrain contact with substeps
    Game.js              loop, events → FX/audio/HUD, director, floating origin, scoring
    Autopilot.js         attract mode + automated playtests
    Aim.js               mouse look/aim offset (pure; never touches the trajectory)
  core/Settings.js       player settings: defaults, sanitizing, persistence, change events
  ui/SettingsPanel.js    terminal settings window / pause screen (schema-driven)
  world/
    World.js             chunk streaming (forward cone, 4 ms/frame budget), collision + ray queries
    PathHazards.js       paced obstacle events down the player's path (pattern table)
    ChunkBuilder.js      bakes each chunk into 1 mesh + 1 edge-line draw call
    rocks.js             procedural rock archetypes with silhouette profiles for exact colliders
    biomes.js            continuous fields: rocky / ridge / pass
    features/            ← world-generation plug-ins (see below)
    Ground.js, Sky.js, Clouds.js  precision-safe infinite grid; fbm cloud deck with parallax
  render/
    PostFX.js            one pass: shockwaves, ripple, vortex, heat haze, radial blur + aberration,
                         negative flashes, glitch slices, vapor cone, flood/white frame,
                         inversion masks (ring, beam, ghost numeral), damage vignette
    FXDirector.js        event → effect envelopes, FOV punch spring, hit-stop
    Juice.js             gate ("landing") and barrier-break ("boost") timelines (pure, unit-tested)
    CameraRig.js         chase (default) + cockpit modes; FOV from Mach
    VectorFX.js          wireframe shells / rings (explosions, barrier breaks)
    curvature.js         planet curvature for every world shader (custom + patched built-ins)
    JetModel.js          third-person airframe, exhaust, contrails
    Cockpit.js, SpeedLines.js, Particles.js, materials.js
  combat/                Projectiles (tracers, missiles, plasma), Weapons (lock + aimbot)
  enemies/               Ufo, Drone, Fighter: flown in the player's frame, climb over terrain
  pickups/               type table (add new gadgets with one entry)
  ui/HUD.js              minimal ink HUD + canvas overlay (aim/line rings, rounded red target boxes, altimeter)
  audio/Audio.js         fully synthesized WebAudio (engine, booms, guns, alarms)
```

**Floating origin.** Past 3 km from the local origin, every system shifts back to (0, 0). Colliders stay in absolute doubles. Shaders get the origin split into a small remainder plus exact integer tile offsets, so the grid stays crisp at 1000 km.

## Adding world features (tunnels, waterfalls, …)

A feature is a plug-in that runs once per chunk. It is deterministic per seed and per chunk, and it can query the continuous biome fields, so a structure stays coherent across chunk borders.

```js
// src/world/features/tunnels.js
import * as THREE from 'three';
import { registerFeature } from './registry.js';
import { capsule } from '../../game/Collision.js';

registerFeature({
  id: 'tunnels',
  order: 4,
  generate(ctx) {
    const { rng, x0, z0, size, biomes, builder } = ctx;
    if (biomes.ridge(x0 + size / 2, z0 + size / 2) < 0.6 || !rng.chance(0.3)) return;
    const yaw = rng.range(0, Math.PI), len = 600, half = 70, h = 90;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const cx = x0 + size / 2, cz = z0 + size / 2;
    // geometry: a half-cylinder shell, merged into the chunk (1 draw call)
    const shell = new THREE.CylinderGeometry(half + 12, half + 12, len, 16, 1, true, 0, Math.PI);
    const m = new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationY(yaw)).setPosition(cx, 0, cz);
    builder.addGeometry(shell, m, 0xd8d5ce);
    // walls you can scrape (edge hits slide you; head-on hits hurt)
    for (const s of [-1, 1]) {
      const ox = dz * half * s, oz = -dx * half * s;
      builder.addCollider(capsule(cx + ox - dx * len / 2, cz + oz - dz * len / 2, cx + ox + dx * len / 2, cz + oz + dz * len / 2, 8, h));
    }
  },
});
```

Then add `import './tunnels.js';` to `features/index.js`. For animated things (a waterfall sheet with a scrolling shader, rotating beacons), use `builder.addObject(mesh, x, y, z, (time) => …)`. Collisions use `circle()` / `capsule()`. Trigger zones (bonuses, checkpoints) use `builder.addTrigger({ kind: 'segment', ax, az, bx, bz, type })` and are handled in `Game.onPlayerEvent('trigger')`.

## Verification

- `npm test`: 71 tests, including the ambient conductor (beat follows the Mach tempo and stays phase-continuous, the pulse can't flash, the layer fades out during the boost / at 0 intensity / when dead, sky progression, engine model before audio starts), pacing (first Mach change ≤ 1 s after launch, then one per barrier hold; a human-rate pilot sim reaches tier V in ≥ 8/10 runs), no tier loss from damage, near-miss detection (fires once, only close, never on touched obstacles, once per wall side), and the event-juice timelines (gate envelope and smear, the white-frame cut, beat-synced flips that always end positive, ≤ 3 flashes/s), and world density (static obstacles per 30 km straight lane) and path-event pacing (same rhythm at tier I and V), including vertical flight (auto-level, ceiling, steep vs shallow ground contact, pitch breaking the line, ground-effect charging, cone-collider flank normals). Tier rules, tolerance shrinking, brake/cap/drop, head-on vs edge collisions, and a flight-model simulation: a human-rate trimmer (1–8 frame taps every 150 ms) reaches tier V in ≥90% of runs, while hands-off flight rarely does.
- Browser playtests (Playwright, autopilot): 110–120 fps, ~130–290 draw calls, 0 frames over 34 ms after shader warm-up, 0 console errors.
