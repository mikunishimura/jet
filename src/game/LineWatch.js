// Watches the course you hold and says when you've held it too long (see
// BREAKER in config.js). A course is a heading that moves at a steady turn
// rate (0 = straight, or a constant left / right turn) plus a climb angle,
// independent of which way you are pointing. Pure: Game feeds it, the tests too.
import { BREAKER } from '../config.js';
import { angleDiff } from './SpeedSystem.js';

export class LineWatch {
  constructor(cfg = BREAKER) { this.cfg = cfg; this.reset(); }

  reset() {
    this.h0 = null;       // heading when the course was taken
    this.w0 = 0;          // turn rate of the course (rad/s)
    this.p0 = 0;          // climb angle of the course
    this.held = 0;        // s on this course
    this.rate = 0;        // smoothed turn rate
    this.lastH = null;
    this.flown = 0;       // s of flight (the first breaker waits for firstAfter)
  }

  /** start a new course from the current state */
  anchor(heading, pitch) { this.h0 = heading; this.w0 = this.rate; this.p0 = pitch; this.held = 0; }

  /** what the held course looks like: 'straight' | 'left' | 'right' */
  get kind() { return Math.abs(this.w0) < this.cfg.straightRate ? 'straight' : this.w0 > 0 ? 'left' : 'right'; }

  /**
   * Feed one frame. Returns the held course { kind, rate, pitch } once it has
   * been held for `patience` seconds (then starts watching afresh), else null.
   */
  update(dt, heading, pitch, patience) {
    const c = this.cfg;
    this.flown += dt;
    if (this.lastH === null) { this.lastH = heading; this.anchor(heading, pitch); return null; }
    const inst = angleDiff(heading, this.lastH) / Math.max(dt, 1e-4);
    this.lastH = heading;
    this.rate += (inst - this.rate) * (1 - Math.exp(-dt / c.rateTau));
    this.held += dt;
    const predicted = this.h0 + this.w0 * this.held;
    if (Math.abs(angleDiff(heading, predicted)) > c.breakYaw || Math.abs(pitch - this.p0) > c.breakPitch) {
      this.anchor(heading, pitch);      // a real course change: the watch starts over
      return null;
    }
    if (this.held >= patience && this.flown >= c.firstAfter) {
      const out = { kind: this.kind, rate: this.w0, pitch: this.p0 };
      this.anchor(heading, pitch);
      return out;
    }
    return null;
  }
}

/**
 * Where a course takes the jet in `t` seconds: constant turn rate `rate`,
 * climb angle `pitch`, airspeed `speed`, vertical pull `drift` (m/s), altitude
 * clamped to [lo, hi]. Returns [x, y, z, heading] (same frame as x, y, z in).
 */
export function predictCourse(x, y, z, heading, pitch, rate, speed, drift, t, lo, hi, steps = 24) {
  const dt = t / steps, cp = Math.cos(pitch), sp = Math.sin(pitch);
  let h = heading;
  for (let i = 0; i < steps; i++) {
    h += rate * dt * 0.5;
    x += -Math.sin(h) * cp * speed * dt;
    z += -Math.cos(h) * cp * speed * dt;
    h += rate * dt * 0.5;
    y = Math.min(hi, Math.max(lo, y + (sp * speed + drift) * dt));
  }
  return [x, y, z, h];
}
