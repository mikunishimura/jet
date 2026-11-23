// Reticle bloom: how steady the gun platform is (BLOOM in config.js).
// 0 = rock steady, 1 = all over the place. Speed, turning, banking, climbing,
// turbulence, recoil and hits widen it; steady flight lets it settle. It sets
// the real bullet spread (Weapons) and the reticle draws exactly that (HUD), so
// what you see is what the gun does. Pure: no three.js, unit-tested.
import { BLOOM } from '../config.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export class Bloom {
  constructor(cfg = BLOOM) { this.cfg = cfg; this.reset(); }
  reset() { this.value = 0; this.recoil = 0; this.kickV = 0; this.prev = null; this.rate = 0; }

  /** a round left the barrel */
  shot() { this.recoil = Math.min(this.cfg.recoilMax, this.recoil + this.cfg.shot); }
  /** something hit you: amount = damage points (impact: terrain contact) */
  hit(amount, impact = false) { this.kickV = Math.min(1, this.kickV + (impact ? this.cfg.impact : amount * this.cfg.hit)); }

  /**
   * s: { forward: {x,y,z} unit flight direction, speed01, bank (-1..1 stick),
   *      pitch (-1..1 stick), hostility (0..1) }. Returns the bloom 0..1.
   */
  update(dt, s) {
    const c = this.cfg, f = s.forward;
    if (this.prev && dt > 0) {
      const dot = this.prev.x * f.x + this.prev.y * f.y + this.prev.z * f.z;
      const inst = Math.acos(Math.max(-1, Math.min(1, dot))) / dt;
      this.rate += (inst - this.rate) * (1 - Math.exp(-dt / 0.08));
    }
    this.prev = { x: f.x, y: f.y, z: f.z };
    const steadyTarget = c.speed * clamp01(s.speed01 || 0)
      + c.turn * clamp01(this.rate / c.turnFull)
      + c.bank * Math.abs(s.bank || 0)
      + c.pitch * Math.abs(s.pitch || 0)
      + c.hostile * clamp01(s.hostility || 0);
    const target = clamp01(steadyTarget + this.recoil + this.kickV);
    const k = target > this.value ? c.rise : c.settle;
    this.value += (target - this.value) * (1 - Math.exp(-k * dt));
    this.recoil *= Math.exp(-c.recoilDecay * dt);
    this.kickV *= Math.exp(-c.settle * dt);
    return this.value;
  }

  /** gun dispersion (rad) at this bloom */
  spread(base) { return base * (1 + this.cfg.spreadK * this.value); }
}
