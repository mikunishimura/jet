// Engine surge envelope (ENGINE_SURGE in config.js). Pure: Audio feeds it the
// speed every frame and pings it on Mach increases; it returns the relative
// engine gain (floor .. 1). Loud while accelerating, then a smooth glide down to
// a quieter cruise; accelerate again and it comes back up.
import { ENGINE_SURGE } from '../config.js';

export class EngineSurge {
  constructor(cfg = ENGINE_SURGE) { this.cfg = cfg; this.reset(); }
  reset() { this.level = 1; this.holdT = this.cfg.hold; this.prev = null; this.accel = 0; }

  /** a Mach increase or a launch: full engine, held for a moment */
  kick() { this.level = 1; this.holdT = this.cfg.hold; }

  /** speed: m/s (any unit, only ratios matter); charge 0..1. Returns the gain. */
  update(dt, speed, charge = 0) {
    const c = this.cfg;
    if (dt <= 0) return this.gain;
    // relative acceleration, smoothed (ignores the jitter of a steady cruise)
    const inst = this.prev && speed > 1 ? Math.max(0, (speed - this.prev) / dt / speed) : 0;
    this.prev = speed;
    this.accel += (inst - this.accel) * (1 - Math.exp(-dt / 0.15));
    // charging builds mostly at the end: a crescendo into the next Mach, quiet cruise before it
    const want = Math.min(1, this.accel / c.accelFull + c.charge * charge * charge);
    if (this.holdT > 0) { this.holdT -= dt; this.level = Math.max(this.level, 1); }
    else if (want > this.level) this.level += (want - this.level) * (1 - Math.exp(-dt / c.rise));
    else this.level += (want - this.level) * (1 - Math.exp(-dt / c.settle));
    return this.gain;
  }

  get gain() { return this.cfg.floor + (1 - this.cfg.floor) * this.level; }
  /** the wind follows the same curve, gentler */
  get windGain() { return this.cfg.windFloor + (1 - this.cfg.windFloor) * this.level; }
}
