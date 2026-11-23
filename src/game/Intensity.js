// Intensity director: build -> peak -> breather cycles plus a dead-time guard
// (INTENSITY in config.js). Pure: Game feeds it whether anything is going on;
// it answers with the current rate multipliers and when to force an event.
import { INTENSITY } from '../config.js';

const R = (rng, [a, b]) => a + (b - a) * rng();
const NEXT = { build: 'peak', peak: 'breather', breather: 'build' };

export class Intensity {
  constructor(cfg = INTENSITY, rng = Math.random) { this.cfg = cfg; this.rng = rng; this.reset(); }

  reset() {
    this.phase = 'build';
    this.left = this.cfg.firstPeak;  // s until the phase ends
    this.idle = 0;                   // s with nothing to react to
    this.t = 0;
  }

  get rates() { return this.cfg.rates[this.phase]; }

  /**
   * busy: anything to react to right now (enemy in sight, obstacle coming,
   * missile, breaker). Returns { changed: new phase name | null, force: bool }.
   */
  update(dt, busy) {
    this.t += dt;
    let changed = null;
    this.left -= dt;
    if (this.left <= 0) {
      this.phase = NEXT[this.phase];
      this.left = R(this.rng, this.cfg[this.phase]);
      changed = this.phase;
    }
    this.idle = busy ? 0 : this.idle + dt;
    let force = false;
    if (this.phase !== 'breather' && this.t >= this.cfg.guardFrom && this.idle >= this.cfg.maxIdle) { force = true; this.idle = 0; }
    return { changed, force };
  }
}
