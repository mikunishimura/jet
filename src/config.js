// Central tuning table. Every gameplay number lives here so balancing never
// requires touching system code.

export const DEG = Math.PI / 180;

// Speed scale: every tier flies 20x faster than the original tuning.
// The FAR field (obstacles, terrain, view distance, fog, event spacing) scales
// by WORLD_SCALE so time-to-contact stays human; the NEAR field (altitude,
// ground grid, camera) stays the same size, so speed *feels* 20x.
// Combat happens in the player's moving frame and is not scaled.
export const SPEED_SCALE = 20;
export const WORLD_SCALE = 20;

// Speed tiers. To ENTER tier n you must stay within tiers[n].tolerance degrees
// of a reference heading for tiers[n].hold seconds while holding W. Tier II
// charges on its own right after launch (SPEED.autoFirstBarrier), so the first
// Mach change comes ~0.5 s into the run.
export const TIERS = [
  { id: 1, roman: 'I',   name: 'HYPERSONIC',   speed: 150 * SPEED_SCALE, tolerance: Infinity, hold: 0,   turbulence: 0.0,   yawRate: 1.05 },
  { id: 2, roman: 'II',  name: 'SCRAMJET',     speed: 260 * SPEED_SCALE, tolerance: 10,       hold: 0.5, turbulence: 0.006, yawRate: 0.95 },
  { id: 3, roman: 'III', name: 'ORBITAL',      speed: 400 * SPEED_SCALE, tolerance: 4.5,      hold: 2.0, turbulence: 0.012, yawRate: 0.85 },
  { id: 4, roman: 'IV',  name: 'ESCAPE',       speed: 620 * SPEED_SCALE, tolerance: 1.8,      hold: 2.6, turbulence: 0.020, yawRate: 0.74 },
  // V: same window as IV, a shorter hold, and a slip only bleeds the charge
  // slowly (missDecay), so dodging one rock doesn't restart the barrier.
  { id: 5, roman: 'V',   name: 'INTERSTELLAR', speed: 950 * SPEED_SCALE, tolerance: 1.8,      hold: 2.2, turbulence: 0.020, yawRate: 0.62, missDecay: 0.6 },
];

/** Feel intensity of a tier on the original 1..5 scale, independent of how many
 *  tiers exist: view distance, damage, buffet, fog, flames and pitch use this. */
export function tierLevel(tier) { return 1 + (tier - 1) * 4 / (TIERS.length - 1); }

// Display: m/s → Mach readout (tier I ≈ M16 … tier V ≈ M101, i.e. 20x the old M0.8 … M5).
export const MACH_FACTOR = 0.8 / 150;

// Field of view grows continuously with Mach (log scale), not in tier steps.
export const FOV = { min: 66, max: 112, machLow: 8, machHigh: 110, charge: 5, brake: -4, chaseOffset: -4 };
export function fovForMach(mach) {
  const t = Math.min(1, Math.max(0, Math.log(mach / FOV.machLow) / Math.log(FOV.machHigh / FOV.machLow)));
  return FOV.min + (FOV.max - FOV.min) * t;
}

export const SPEED = {
  chargeOverspeed: 0.14,   // speed bonus (fraction) as the barrier charge fills
  chargeDecayIdle: 0.35,   // charge/s lost when W released while straight
  chargeDecayMiss: 2.6,    // charge/s lost when outside the tolerance window
  brakeDrain: 1.6,         // charge/s drained while holding S
  brakeDropTime: 0.75,     // seconds of S at zero charge to drop one tier
  brakeSpeedCut: 0.18,     // fraction of speed shed while braking
  accel: 2.2,              // speed response rate (1/s) when speeding up
  decel: 1.6,              // speed response rate when slowing down
  autoFirstBarrier: true,  // tier II charges by itself after launch: the first Mach change comes within ~1 s
};

// Feature flags. Read them only through the systems they gate; Game latches
// them at the start of each flight (see core/flags.js for the URL / settings
// overrides). `space`: the ceiling opens up into orbit (asteroids, rings).
export const FLAGS = { space: true };

export const FLIGHT = {
  minAltitude: 6,       // ground contact below this
  earthCeiling: 24000,  // containment ceiling on "earth" (space flag off): far above the cloud deck (8 km)
  /** active containment ceiling: the orbit ceiling when space flight is on */
  get ceiling() { return FLAGS.space ? SPACE.ceiling : this.earthCeiling; },
  obstacleBand: 1500,   // terrain/path obstacles live below ~this; the sky above is open but radar-exposed
  // spawn: midway in the obstacle band (where the gameplay is), not midway to the 24 km ceiling
  get altitude() { return (this.minAltitude + this.obstacleBand) / 2; },
  pitchRate: 0.75,      // rad/s at full vertical stick
  pitchRamp: 0.22,      // seconds to full vertical stick (Space / Shift)
  pitchCurve: 1.3,
  maxPitch: 32 * DEG,
  autoLevel: 2.2,       // 1/s: nose returns to level when you let go
  levelSnap: 8,         // 1/s: W tap levels this fast
  steerRamp: 0.26,      // seconds to reach full stick when holding A/D
  steerCurve: 1.3,      // stick→yaw exponent (>1 = finer taps)
  gustTau: 3.0,         // seconds a crosswind gust persists
  steerRelease: 0.10,   // seconds for stick to return to center
  stabilizeTime: 0.25,  // W tap: time to null residual yaw
  bankAngle: 0.42,      // radians of camera roll at full stick
  playerRadius: 7,
};

// Space flight (FLAGS.space). Altitudes in absolute meters. Everything up here
// lives in src/space/; with the flag off none of it is created and the world
// ends at FLIGHT.earthCeiling exactly as before.
export const SPACE = {
  skyFrom: 24000,        // the sky starts turning to space (== earth ceiling: nothing changes below it)
  edge: 60000,           // Kármán line: black sky, stars; the 'space' band starts here
  ceiling: 150000,       // orbit ceiling
  hazardFloor: 64000,    // above: obstacles down your path are asteroids, moons and rings
  field: {               // static asteroid field (scenery + the odd obstacle), streamed in columns
    floor: 70000, top: 146000,
    streamFrom: 38000, dropBelow: 30000, // build columns above streamFrom, free them all below dropBelow
    count: [0, 4],       // asteroids per 10 km column (sparse .. inside a belt)
    moonChance: 0.025,   // a big drifting moon in this column
  },
  turbulence: 0.35,      // gusts in vacuum (solar wind): fraction of the tier's turbulence
  chargeRate: 1.0,       // barrier charge multiplier in orbit (no radar penalty)
  interval: [8, 4.5],    // seconds between path events, easy .. max difficulty
  inPathChance: 0.5,
  patterns: { asteroid: 2.5, pair: 2.5, ring: 2.2, ringRun: 1.2, swarm: 1.4, moonlet: 1, belt: 0.7, moon: 1.3 },
  curveRadius: 110e3,    // effective planet radius at the orbit ceiling (round planet below)
  far: 700e3,            // camera far plane at the ceiling (sees the whole limb)
  airFade: [24000, 60000], // air -> vacuum: fog, wind noise and gusts fade over this range
  colors: { space: 0x04060c, planetshine: 0x5d8fd8 },
};

// The hostile band: the empty sky between the weather and orbit. There is
// nothing to do up there, so it must not be a place to cruise. From `floor`
// (just over the 8 km cloud deck) to the top (the Kármán line with space
// flight, the containment ceiling without) gravity drags you back down, the
// airframe and camera are buffeted and the screen boils (PostFX uHostile).
// The longer you stay, the harder it pulls. With space flight on, past
// `capture` (80% of the way up) orbit takes over and pulls you into space.
export const HOSTILE = {
  floor: 10000,          // m: starts just over the cloud deck (DECK_ALTITUDE 8 km)
  ramp: 0.1,             // fraction of the band over which it fades in from the floor
  floorPull: 0.35,       // gravity share left right at the floor, so it carries you out of the band
  capture: 0.8,          // space flight: above this fraction of the band, space pulls you up
  sink: 0.24,            // gravity: sink rate at full pull, as a fraction of airspeed
  sinkStart: 0.45,       // share of the pull felt on entry; the rest builds with exposure
  climbRelief: 0.5,      // a committed climb (full pitch up) cuts the sink by this much
  noseDrop: 9 * DEG,     // hands off, the nose settles this far below level (fully exposed)
  lift: 0.32,            // orbit capture: climb rate at full pull, fraction of airspeed
  noseRise: 12 * DEG,    // hands off in the capture zone, the nose lifts toward space
  driftTau: 0.6,         // s: the vertical pull eases in and out (no jolts at the borders)
  buildUp: 6,            // s inside the band to reach full exposure
  calm: 2.5,             // s outside to shed it
  yawJolt: 0.07,         // rad/s std of buffet yaw at full hostility (breaks the barrier line)
  pitchJolt: 0.09,       // rad/s std of buffet pitch
  joltTau: 0.45,         // s: buffet correlation time
  captureCalm: 0.75,     // hostility drops by this much as orbit pulls you up to the edge
};

// How the jet model rides rough air in the hostile band (src/render/turbulence.js).
// Visual only: the flight path is buffeted by HOSTILE.yawJolt / pitchJolt.
// chop: smooth random motion (rad, m); bump: kicks from random air pockets
// (spring velocity, rad/s and m/s), which settle on an under-damped mount.
export const TURBULENCE = {
  chopHz: [1.7, 6.5],     // noise rates of the two octaves (points per second)
  chop: { roll: 0.05, pitch: 0.022, yaw: 0.012, heave: 0.35, sway: 0.2 },
  gustHz: 0.35,           // the rough air comes and goes in waves this slow
  bumpRate: [0.6, 1.8],   // air pockets per second, entering .. fully exposed
  doubleChance: 0.3,      // a second smaller pocket right after the first
  dropShare: 0.7,         // most pockets drop the jet, the rest lift it
  bump: { heave: 16, pitch: 0.55, roll: 1.4, yaw: 0.35, sway: 5 },
  springHz: 1.5,          // the mount's natural frequency
  damping: 0.32,          // under-damped: a drop overshoots once, then settles
};

// Altitude bands: low flying is risky but rewarded; high flying is safe from
// rocks but exposes you to radar and slows barrier charging.
export const ALTITUDE = {
  groundEffect: 60,       // below: barrier charges faster, under the radar
  groundEffectCharge: 1.3,
  radar: 1000,            // above: radar exposed
  radarCharge: 0.75,
  waveIntervalLow: 1.4,   // director multipliers
  waveIntervalHigh: 0.6,
  extraEnemiesHigh: 2,
  groundHardThreshold: 0.35, // dive steeper than ~20° into the floor = hard hit
};

export const HEALTH = {
  max: 100,
  // Velocity is never taken away by damage: no hull cap, no serious-hit drop.
  // Damage only costs hull (and the run, at 0).
  tierDropCooldown: 2.0,
};

export const COLLISION = {
  centerThreshold: 0.72, // dot(forward, -normal) above this = head-on hit
  hardDamageBase: 16,
  hardDamagePerTier: 7,
  hardSpeedKeep: 0.45,
  edgeDeflect: 0.65,     // how strongly heading is pulled to tangent on edge hits
  invuln: 0.6,
  tierLossOnHeadOn: true, // a head-on terrain crash costs one tier (your mistake, not an attack)
};

// Speed streaks follow the flight path, not the camera: within `deadzone` (rad) of
// looking straight they are the classic camera tunnel, by `full` they stream along the
// velocity. tail: extra travel behind the lens when looking away; sideShorten: streak
// length cut when seen side-on; relax: 1/s pull of the tube's roll back to camera-up.
export const SPEED_LINES = { deadzone: 0.14, full: 0.45, tail: 400, sideShorten: 0.5, relax: 3 };

// Near misses: pass an obstacle close without touching it and the barrier
// charges. Clearance is surface-to-hull, in meters; the window widens with speed
// (constant reaction time). Closer = more charge.
// Intensity director (src/game/Intensity.js): the run breathes in cycles
// instead of a flat drip. build -> peak -> breather -> build ...
//   build:    normal rates
//   peak:     waves come twice as fast (+1 enemy), path events 1.6x, breakers sooner
//   breather: a few seconds with nothing new (what's already there stays)
// Outside a breather, `maxIdle` seconds with nothing to react to (no enemy in
// sight, no obstacle coming, no missile, no breaker) forces an event.
export const INTENSITY = {
  firstPeak: 18,               // s of flight before the first peak
  build: [8, 12],              // s
  peak: [12, 18],
  breather: [3, 4.5],
  rates: {
    build:    { wave: 1,   events: 1,   patience: 1,   extraEnemies: 0 },
    peak:     { wave: 2,   events: 1.6, patience: 0.7, extraEnemies: 1 },
    breather: { wave: 0,   events: 0,   patience: Infinity, extraEnemies: 0 },
  },
  maxIdle: 3,                  // s with nothing to react to before the director forces something
  forcedLead: 3.5,             // s ahead a forced obstacle event lands (it rises out of the ground)
  guardFrom: 5,                // s after launch before the dead-time guard kicks in
};

// Combo (src/game/Combo.js): skill chains into a score multiplier. Kills, near
// misses (and threaded forks), gates, missiles out-turned and line breakers
// dodged each add a stack. `window` seconds with nothing and the chain is
// gone; any hit on you (enemy fire or terrain) breaks it at once.
export const COMBO = {
  window: 4,                   // s an event keeps the chain alive
  step: 0.2,                   // multiplier per stack: x1, x1.2, x1.4 ...
  max: 4,                      // multiplier cap
  // stacks per event: the harder the skill, the more it adds (drones fly into your gun: half)
  weights: { kill: 1, droneKill: 0.5, nearMiss: 1, gate: 1, breaker: 2, beat: 2 },
  charge: 0.08,                // barrier charge per combo event (x multiplier), on top of gates / near misses
  announce: [2, 3, 4],         // multipliers that get a call-out
};

export const NEAR_MISS = {
  base: 90 * WORLD_SCALE,  // 1.8 km
  perSpeed: 0.05,          // + 50 ms of travel
  charge: [0.12, 0.35],    // barrier charge at the edge of the window .. at zero clearance
  cooldown: 0.25,          // s between rewards
};

export const WORLD = {
  chunkSize: 500,          // in base (unscaled) meters; real size = chunkSize * WORLD_SCALE
  viewDistBase: 3400 * WORLD_SCALE,
  viewDistPerTier: 420 * WORLD_SCALE,
  rebaseDistance: 3000,
  genBudgetMs: 4,
  spawnClearRadius: 700,
  launchCorridor: { length: 3200, halfWidth: 260 },
  fogDensityBase: 0.00034 / WORLD_SCALE,
  fogDensityPerTier: -0.000025 / WORLD_SCALE,
};

// Static world density: mostly open plains for long straight runs.
export const WORLD_DENSITY = {
  regionThreshold: 0.36,  // higher = rarer mountain regions
  rockfieldMax: 7,        // tall rocks per chunk at the heart of a region
  loneRockChance: 0.05,   // per 500 m chunk on open plains
  rubble: [2, 6],         // low rubble per chunk (plains .. region)
};

// Obstacle events spawned DOWN THE PLAYER'S PATH (along the current heading).
export const PATH = {
  firstAfter: 1800 * WORLD_SCALE, // meters flown before the first event
  interval: [9, 5],       // seconds between events, easy .. max difficulty
  jitter: 0.35,           // ± fraction of the interval
  inPathChance: 0.45,     // chance a single rock sits on your line (else it's a near miss)
  patterns: { pair: 3, spire: 2.5, boulder: 1.5, mesa: 1, gate: 1.4, cluster: 1, wall: 0.6, vista: 1.6 },
};

// Line breakers: you can't hold one course forever. A watcher tracks your
// course (heading, turn rate, climb angle). When you've kept the same one,
// straight or a steady left / right turn, for `patience` seconds, an
// obstacle rises (or materializes, off the ground) right where that course
// takes you `lead` seconds from now. Any real course change (a turn of
// `breakYaw` away from where the old course would point, or a climb / dive of
// `breakPitch`) resets the watch. Sized to cover `coverDeg` of the approach,
// so a trim never clears it: you have to commit to a dodge.
export const BREAKER = {
  firstAfter: 7,           // s of flight before the first breaker
  patience: [6.5, 3.6],    // s on one course before a breaker, easy .. max difficulty
  lead: [3.0, 2.3],        // s from spawn to contact
  breakYaw: 12 * DEG,      // a course change: heading this far from the held course's prediction
  breakPitch: 7 * DEG,     //   ... or the climb angle this far from the held one
  rateTau: 0.35,           // s: turn-rate smoothing (gusts and trims don't count)
  straightRate: 0.05,      // rad/s: a smoothed turn rate under this is "straight"
  coverDeg: 4.5,           // obstacle radius = this angle of the approach distance
  radius: [450, 3600],     // m clamp
  rise: 0.45,              // s for the obstacle to rise / materialize (masks the pop-in)
  patterns: { block: 3, fork: 2, curtain: 1.2 }, // curtain: floating only (go over / under)
  forkGap: 0.45,           // fork: gap between the two rocks, in radii (thread it for a near miss)
};

// Mouse look / aim. The mouse never steers the jet: it aims the camera and
// the guns. Aim is an offset relative to the jet's flight direction.
// Player airframe skins (built in render/skins.js). The first one is the default.
export const SKIN_IDS = ['b2-spirit', 'lab-interceptor'];

export const AIM = {
  sensitivity: 0.0022,      // rad per mouse pixel
  invertY: false,
  maxYaw: 150 * DEG,        // look left/right (can check your six)
  maxPitchUp: 70 * DEG,
  maxPitchDown: 55 * DEG,
  recenterDelay: 1.6,       // s without mouse movement or firing before easing back to forward
  recenterRate: 1.8,        // 1/s exponential ease back
  convergence: 1500,        // m: gun streams meet the crosshair ray here when nothing is assisted
  assistCone: 14 * DEG,     // minigun leads a target only this close to the crosshair (set from autoCone / manualCone)
  autoAim: true,            // settings: controls.autoAim
  autoFire: true,           // settings: controls.autoFire. Gun, lock-on missiles and flares fire by themselves
  autoCone: 20 * DEG,       // auto-fire: the gun opens up on enemies this far from the crosshair (tracking them is your job)
  manualCone: 14 * DEG,     // auto-aim off: classic assist
};

export const WEAPONS = {
  // heavier, slower rounds (was 26/s × 6 dmg); the barrels cool and unjam fast
  minigun: { rate: 11, speed: 6500, damage: 14, spread: 0.004, heatPerShot: 0.011, cool: 1.9, coolDelay: 0.08, overheatLock: 0.5, range: 1900 },
  missiles: { salvo: 4, stagger: 0.07, max: 8, reload: 1.4, speed: 750, accel: 900, turnRate: 4.2, damage: 70, splash: 70, life: 6 },
  // a hard lock is a kill: one hypersonic missile per locked target, out in a quick ripple
  lockedMissile: { speed: 5200, accel: 60000, turnRate: 40, stagger: 0.035, prox: 30, life: 3 },
  // enemies on station sidestep at random moments, so the crosshair never just
  // sits on them: tracking is the aim skill. Offsets (m) on top of each
  // enemy's weave, re-rolled every `every` seconds; scaled up with difficulty.
  jink: { every: [0.7, 1.7], side: 240, up: 70, difficulty: [0.7, 1.15] },
  // loose lock: chance the target jinks out of the missile's way at the last moment
  evade: { DRONE: 0.25, UFO: 0.5, FIGHTER: 0.75 },
  lockCone: 42 * DEG,      // detection: red boxes, gun aim-assist candidates
  lockRange: 2400,
  // aim quality: gun damage by crosshair error (beyond the target's own size).
  // On center is a critical hit; it falls off to `edge` at the gun cone.
  aimQuality: { crit: 2 * DEG, critMult: 2, full: 1, edge: 0.3 },
  // missile lock-on: hold RMB / K, keep the crosshair on an enemy, release to fire
  lock: {
    time: 0.75,            // s of tracking per target
    margin: 5 * DEG,       // aim error allowed around the target's own angular size (auto-aim off)
    autoMargin: 6 * DEG,   // ... with auto-aim on: keep the enemy inside this ring while it moves
    noseCone: 45 * DEG,    // locks only build on targets this close to the NOSE: commit your flight path
    precise: 2.5 * DEG,    // mean tracking error under this: a kill missile; above: a missile it can dodge
    grace: 0.3,            // s the crosshair may slip off before progress drains
    drain: 1.2,            // progress / s lost after the grace period
    maxTargets: 4,
    displayK: 3,           // lock ring fill: slow at first, fast at the end (display only)
    dumbfire: 2,           // missiles on a release with nothing locked
  },
};

// Incoming enemy missiles: a warning that sharpens as the impact gets closer
// (time to impact, s), and flares that decoy what's inside their window.
export const THREATS = {
  warnFrom: 5,             // s to impact: the warning starts
  breakAt: 1.3,            // s: "break now" (== breakWindow[1])
  flares: { charges: 2, recharge: 9, life: 1.3, window: 3.2, eject: 160 }, // manual only (F / touch button); window: s-to-impact a flare can still pull a missile off
  // break turn: start a hard turn (or climb / dive) while a missile is inside
  // the window and it overshoots. Too early and it re-acquires; holding a turn
  // you were already in doesn't count (the break has to be fresh).
  breakWindow: [0.15, 1.3], // s to impact
  breakRate: 0.3,           // rad/s the flight direction must swing (smoothed)
  breakFresh: 0.55,         // s: the turn must have started this recently
  breakDeflect: 0.6,        // how far the beaten missile is thrown off its line
};

export const DIRECTOR = {
  firstWave: 9,
  intervalStart: 15,
  intervalEnd: 5.5,
  rampTime: 240,           // seconds to reach max difficulty from time
  rampDistance: 120000 * WORLD_SCALE, // meters from spawn to reach max difficulty from distance
  maxEnemiesStart: 3,
  maxEnemiesEnd: 10,
  pickupInterval: [18, 32],
  pickupIntervalLow: [8, 14], // when hull < 40
};

// Event juice, ported from game-shader-style.md (a Beat Stomper teardown) into the
// lab palette: every effect is an INVERSION MASK, so it reads ink-on-white over the
// world and white-on-ink over rocks, never a new color. Timings are the measured ones.
export const JUICE = {
  beat: 0.445,               // s per negative flip at tier I (≈135 BPM); faster with Mach (see beatMin)
  beatMin: 0.34,             // never faster than 2.94 flips/s (WCAG 2.3.1: <= 3 flashes/s)
  gate: {                    // "landing": survey gate pass
    hold: 0.10, fade: 0.50,  // instant attack, 100 ms hold, linear fade (measured: back to rest in ~0.5 s)
    ring: { from: 0.12, to: 1.35, grow: 0.6, alpha: 0.9 }, // hollow ring radius in screen heights
    beam: 0.9, line: 0.6,    // inverted vertical beam / horizontal hairline peak strength
    ghost: 0.35,             // giant ghost number peak strength
    smear: { stretch: [0.8, 1.6], squash: [1.25, 0.85], smearFor: 0.05, squashFor: 0.1, settle: 0.18 },
    shards: 16,
  },
  boost: {                   // barrier break
    swirl: { duration: 1.25, intensity: 0.1, endRadius: 1.4 }, // vortex refraction (DistortionWave: 0.1 / 1.25 s)
    flood: { from: 0.3, amount: 0.45 },     // wash toward paper-white before the cut, kept clear at the center
    cut: 1.10,               // s after the break: one white frame, then a hard cut into the negative
    whiteFrame: 1 / 30,
    milestones: [3, 4, 5],   // full boost (vortex -> white -> negative) here; tier II (right after launch) pops
    beatsBase: 2,            // negative phase: beatsBase + milestone index beats (2, 3, 4)
    ghost: 0.3,
    smear: { stretch: [0.7, 2.2], smearFor: 0.06, settle: 0.25 },
  },
  pop: {                     // every non-milestone Mach change: a landing-style hit around the jet
    hold: 0.08, fade: 0.45,
    ring: { from: 0.08, to: 1.6, grow: 0.5, alpha: 0.95 },
    beam: 0, line: 0.7, ghost: 0.32,
    smear: { stretch: [0.75, 1.9], squash: [1.2, 0.88], smearFor: 0.05, squashFor: 0.08, settle: 0.2 },
  },
  near: {                    // near miss: small, fast, around the jet
    hold: 0.05, fade: 0.35,
    ring: { from: 0.05, to: 0.7, grow: 0.35, alpha: 0.8 },
    beam: 0, line: 0.5, ghost: 0.22,
    smear: { stretch: [0.9, 1.3], squash: [1.08, 0.95], smearFor: 0.04, squashFor: 0.06, settle: 0.12 },
  },
};

// Ambient layer: always-on, Beat Stomper-style background motion driven by
// speed, barrier charge, the engine's own sound and a beat clock whose tempo
// rises with Mach. Subtle by design: it fades out during the boost negative,
// follows the fx.intensity / fx.flashes settings, and master: 0 turns it off.
export const AMBIENT = {
  master: 1,
  fade: 4,                                  // 1/s: how fast the layer fades in/out
  eq: { bands: 32, smooth: 0.25 },          // engine spectrum (drives the breathing)
  pulse: { amp: 0.35, decay: 4.5, far: 9000 },  // beat wave down the floor grid (darkens lines only)
  space: { zenith: 0x060914, stars: 0.9 },      // sky drifts toward space with tier
  numerals: { spacing: 10000, ahead: 7000, width: 2400, alpha: 0.18, pool: 4 }, // km markers on the floor
  machGhost: { alpha: 0.075 },                  // live Mach number painted in the far sky
  ring: { alpha: 0.3, radius: 1900, dist: [5200, 3900], spin: 0.012, segments: 160 }, // megastructure, rising over the horizon
  breathe: { vignette: 0.07, blur: 0.06 },      // post breathes with engine loudness
  shafts: { alpha: 0.07, count: 7 },            // distant light shafts sliding past
  dust: { rate: 40, life: 1.1 },                // near-field ink dust
  halos: { strength: 0.32, max: 8, range: 6000 }, // dark auras on threats, pulsing on the beat
};

export const PALETTE = {
  // Restricted palette: white world, ink/dark-gray outlines, ONE accent (red)
  // reserved for hostiles, damage and warnings.
  ground: 0xffffff,
  rock: 0x1a1c1f,     // obstacles: near-black with a white silhouette rim
  rockDark: 0x141619,
  ink: 0x15171a,
  inkSoft: 0x3a3e44,
  gray: 0x9aa0a6,
  fog: 0xe8f4ff,   // == sky horizon: distant terrain melts into the sky
  signal: 0x15171a,
  hazard: 0x15171a,
  enemy: 0xff3b30,
  heal: 0x15171a,
};
