// Continuous world fields. Features query these at any absolute (x, z), so
// structures that span chunks (ridges, valleys) stay coherent across borders.
import { createNoise2D } from '../core/noise.js';
import { WORLD_DENSITY } from '../config.js';

export class Biomes {
  constructor(seed) {
    this.nBiome = createNoise2D(seed * 3 + 1);
    this.nRidge = createNoise2D(seed * 5 + 2);
    this.nPass = createNoise2D(seed * 7 + 3);
    this.nDetail = createNoise2D(seed * 11 + 4);
    this.nWarp = createNoise2D(seed * 13 + 5);
    this.nRegion = createNoise2D(seed * 17 + 6);
  }
  /**
   * 0..1 mountain-region mask. The world is mostly open plain; ridges and rock
   * fields only exist inside rare, large regions, never near spawn.
   */
  region(x, z) {
    const v = this.nRegion.fbm(x / 26000, z / 26000, 2);
    const k = Math.min(1, Math.max(0, (v - WORLD_DENSITY.regionThreshold) / 0.2));
    const d = Math.hypot(x, z);
    const spawnFade = Math.min(1, Math.max(0, (d - 4000) / 8000));
    return k * k * (3 - 2 * k) * spawnFade;
  }
  /** 0 = open plains (speed runs) .. 1 = dense rock country */
  rocky(x, z) {
    const v = this.nBiome.fbm(x / 9000, z / 9000, 3);
    return Math.min(1, Math.max(0, (v + 0.15) * 1.6));
  }
  /** 0..1 closeness to a mountain ridge line (zero contour of a warped noise). */
  ridge(x, z) {
    const wx = x + this.nWarp(x / 6000, z / 6000) * 900;
    const wz = z + this.nWarp(z / 6000 + 40, x / 6000 - 40) * 900;
    const n = this.nRidge(wx / 5200, wz / 5200);
    const band = 0.085;
    return Math.max(0, 1 - Math.abs(n) / band) * this.region(x, z);
  }
  /** true where a ridge has a gap you can fly through */
  pass(x, z) { return this.nPass(x / 1400, z / 1400) > 0.15; }
  detail(x, z) { return this.nDetail(x / 300, z / 300); }
  /** Summary for a chunk; features use it to scale their density. */
  sample(x, z) {
    return { rocky: this.rocky(x, z), ridge: this.ridge(x, z), pass: this.pass(x, z) };
  }
}
