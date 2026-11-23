// Airframe turbulence for the hostile band: what the jet model does when the
// air gets rough. Built so it never reads as a loop:
//  * chop: smooth value noise (random lattice, smoothstep between points) on
//    every axis, two octaves at unrelated rates, so nothing repeats
//  * bumps: air pockets at random (Poisson) moments. Each one kicks a springy,
//    under-damped mount, so the jet drops (or lifts), rolls, then settles
//  * gusts: a slow envelope makes the rough air come and go in waves
// Pure (no three.js) and seedable, for the tests.
import { mulberry32 } from '../core/rng.js';
import { TURBULENCE as T } from '../config.js';

/** 1D value noise in -1..1: random points, eased between, never periodic */
class Noise {
  constructor(rng) { this.rng = rng; this.a = rng() * 2 - 1; this.b = rng() * 2 - 1; this.p = rng(); }
  step(dt, hz) {
    this.p += dt * hz;
    while (this.p >= 1) { this.p -= 1; this.a = this.b; this.b = this.rng() * 2 - 1; }
    const s = this.p * this.p * (3 - 2 * this.p);
    return this.a + (this.b - this.a) * s;
  }
}

/** under-damped spring: x'' = -w^2 x - 2 zeta w x' (kicked through v) */
class Spring {
  constructor() { this.x = 0; this.v = 0; }
  step(dt, w, zeta) {
    this.v += (-w * w * this.x - 2 * zeta * w * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

const AXES = ['roll', 'pitch', 'yaw', 'heave', 'sway'];

export class Turbulence {
  constructor(seed = (Math.random() * 1e9) | 0) {
    const rng = this.rng = mulberry32(seed);
    this.lo = {}; this.hi = {}; this.spring = {};
    for (const k of AXES) { this.lo[k] = new Noise(rng); this.hi[k] = new Noise(rng); this.spring[k] = new Spring(); }
    this.gust = new Noise(rng);
    this.nextBump = this.wait(1);
    this.out = { roll: 0, pitch: 0, yaw: 0, heave: 0, sway: 0 };
  }

  /** seconds until the next air pocket (exponential: no rhythm to read) */
  wait(rate) { return -Math.log(Math.max(1e-6, this.rng())) / Math.max(1e-3, rate); }

  /** advance by dt at intensity 0..1; returns radians (roll/pitch/yaw) and meters (heave/sway) */
  update(dt, intensity) {
    const rng = this.rng, o = this.out;
    // rough air comes in waves: a slow envelope between ~35% and 100%
    const env = intensity * (0.675 + 0.325 * this.gust.step(dt, T.gustHz));
    // air pockets: random kicks, mostly drops, with a matching roll/pitch jolt
    if (intensity > 0) {
      this.nextBump -= dt;
      if (this.nextBump <= 0) {
        const k = env * (0.5 + rng());                       // some barely felt, some hard
        const drop = rng() < T.dropShare ? -1 : 1;
        this.spring.heave.v += drop * T.bump.heave * k;
        this.spring.pitch.v += -drop * T.bump.pitch * k * (0.5 + rng());
        this.spring.roll.v += (rng() * 2 - 1) * T.bump.roll * k;
        this.spring.yaw.v += (rng() * 2 - 1) * T.bump.yaw * k;
        this.spring.sway.v += (rng() * 2 - 1) * T.bump.sway * k;
        // sometimes a second, smaller pocket right after the first
        this.nextBump = rng() < T.doubleChance ? 0.08 + rng() * 0.15 : this.wait(T.bumpRate[0] + (T.bumpRate[1] - T.bumpRate[0]) * intensity);
      }
    } else this.nextBump = Math.max(this.nextBump, 0.3);
    for (const k of AXES) {
      const chop = this.lo[k].step(dt, T.chopHz[0]) + 0.45 * this.hi[k].step(dt, T.chopHz[1]);
      const kick = this.spring[k].step(dt, T.springHz * 2 * Math.PI, T.damping);
      o[k] = chop * T.chop[k] * env + kick;
    }
    return o;
  }
}
