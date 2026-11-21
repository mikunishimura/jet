// The ambient conductor: Beat Stomper's ThemeManager for a game without music.
// Every frame it turns speed, barrier charge, the engine's sound (or a model of
// it before audio starts) and a beat clock whose tempo rises with Mach into a
// handful of numbers the always-on background layer reads. Pure: unit-tested.
import { AMBIENT } from '../config.js';
import { beatFor } from './Juice.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class AmbientConductor {
  constructor(cfg = AMBIENT) {
    this.cfg = cfg;
    this.phase = 0;          // 0..1 within the current beat
    this.beat = 0;           // beats since start
    this.gate = 0;           // overall ambient strength 0..1 (fades in/out)
    this.space = 0;          // sky progression toward space 0..1
    this.time = 0;
    this.bands = new Float32Array(cfg.eq.bands);
    this.out = { phase: 0, beat: 0, pulse: 0, gate: 0, space: 0, bands: this.bands, loud: 0 };
  }

  /**
   * @param s { speed01, level (1..5), tier, charge, throttle, braking, boosting, alive,
   *            bands: Float32Array|null (0..1 per band from the audio analyser), prefs: {intensity, flashes} }
   */
  update(dt, s) {
    const c = this.cfg, o = this.out;
    this.time += dt;
    // beat clock: phase advances at the current tempo, so a tempo change never skips a beat
    const period = beatFor(s.tier);
    this.phase += dt / period;
    while (this.phase >= 1) { this.phase -= 1; this.beat++; }

    // overall gate: off during the boost negative (events stay the loudest thing), when dead,
    // at fx intensity 0, or with the master switch off
    const intensity = s.prefs ? s.prefs.intensity : 1;
    const target = c.master * intensity * (s.alive ? 1 : 0) * (s.boosting ? 0 : 1);
    this.gate += (target - this.gate) * (1 - Math.exp(-c.fade * dt));

    // sky drifts toward space as you climb tiers (smooth, eased)
    const t = clamp01((s.level - 1) / 4);
    this.space += (t * t * (3 - 2 * t) - this.space) * (1 - Math.exp(-2 * dt));

    // engine "spectrum": real analyser bands when audio runs, else a model of the engine bed
    const n = this.bands.length, k = c.eq.smooth;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let v;
      if (s.bands) v = s.bands[i] || 0;
      else {
        const f = i / n;
        const engine = (s.throttle ? 0.55 : 0.22) * (0.35 + 0.65 * s.speed01) * Math.pow(1 - f, 1.5);
        const wind = s.speed01 * s.speed01 * 0.5 * f;
        const riser = s.charge * 0.7 * Math.exp(-((f - 0.25 - 0.5 * s.charge) ** 2) / 0.012);
        const wobble = 0.07 * (0.5 + 0.5 * Math.sin(this.time * 7.3 + i * 1.7)) * (0.3 + s.speed01);
        v = engine + wind + riser + wobble - (s.braking ? 0.15 : 0);
      }
      this.bands[i] += (clamp01(v) - this.bands[i]) * k;
      sum += this.bands[i];
    }

    o.phase = this.phase;
    o.beat = this.beat;
    // a soft swell right after each beat; none at all when the player turned flashes off
    o.pulse = s.prefs && s.prefs.flashes === false ? 0 : c.pulse.amp * Math.exp(-this.phase * period * c.pulse.decay);
    o.gate = this.gate;
    o.space = this.space;
    o.loud = sum / n;
    return o;
  }
}
