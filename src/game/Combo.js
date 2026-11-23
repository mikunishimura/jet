// Combo multiplier (COMBO in config.js). Pure: Game reports skill events and
// hits; the multiplier scales the points those events give.
import { COMBO } from '../config.js';

export class Combo {
  constructor(cfg = COMBO) { this.cfg = cfg; this.reset(); }
  reset() { this.stacks = 0; this.timer = 0; this.best = 1; }

  get mult() { return Math.round(Math.min(this.cfg.max, 1 + this.cfg.step * this.stacks) * 100) / 100; }
  /** 0..1: how much of the window is left (HUD bar) */
  get fill() { return this.stacks ? Math.max(0, this.timer / this.cfg.window) : 0; }

  /** a skill event: returns the multiplier it scores at and any milestone crossed */
  add(n = 1) {
    const before = this.mult;
    this.stacks += n;
    this.timer = this.cfg.window;
    const m = this.mult;
    this.best = Math.max(this.best, m);
    const milestone = this.cfg.announce.find((a) => before < a && m >= a) ?? null;
    return { mult: m, milestone };
  }

  /** you got hit: the chain breaks. Returns the multiplier lost (1 = nothing to lose). */
  break() { const m = this.mult; this.stacks = 0; this.timer = 0; return m; }

  /** returns true when the chain just ran out */
  update(dt) {
    if (!this.stacks) return false;
    this.timer -= dt;
    if (this.timer <= 0) { this.stacks = 0; this.timer = 0; return true; }
    return false;
  }
}
