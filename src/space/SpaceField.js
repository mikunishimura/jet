// The orbital asteroid field: a World layer (see World.addLayer) that streams
// 10 km columns of tumbling asteroids, pebbles and the odd moon between
// SPACE.field.floor and .top. It only exists while you are up there: columns
// build once you climb past field.streamFrom and are all freed below
// field.dropBelow, so the planet pays nothing for it.
//
// Deterministic per (seed, column): fly back and the same rocks are there.
// Belts: a low-frequency noise field makes dense lanes and empty stretches.
import { SPACE, WORLD, WORLD_SCALE } from '../config.js';
import { chunkRng } from '../core/rng.js';
import { createNoise2D } from '../core/noise.js';
import { SpaceBuilder } from './bodies.js';

const S = WORLD_SCALE;
const key = (cx, cz) => `${cx},${cz}`;
const ROCK_GRAYS = [0x5b5f66, 0x676c73, 0x50545a, 0x72777e];

export class SpaceField {
  constructor(world, materials, library) {
    this.world = world; this.materials = materials; this.library = library;
    this.chunks = new Map();
    this.size = WORLD.chunkSize;   // base meters, same grid as the planet
    this.csize = this.size * S;
    this.stats = { built: 0 };
    this.seed = 1;
  }

  reset(seed = this.seed) {
    this.disposeAll();
    this.seed = seed;
    this.belt = createNoise2D((seed ^ 0x5eed) >>> 0);
  }

  disposeAll() {
    for (const c of this.chunks.values()) this.world.disposeChunk(c);
    this.chunks.clear();
  }

  /** 0 = empty void .. 1 = heart of a belt (base-meter coords) */
  beltAt(x, z) {
    const n = this.belt(x / 9000, z / 9000) * 0.7 + this.belt(x / 2600 + 17, z / 2600 - 5) * 0.3;
    return Math.max(0, Math.min(1, (n + 0.15) / 0.8));
  }

  buildColumn(cx, cz) {
    const F = SPACE.field, size = this.size;
    const x0 = cx * size, z0 = cz * size;
    const b = new SpaceBuilder(x0 + size / 2, z0 + size / 2);
    const rng = chunkRng(cx, cz, this.seed, 4241);
    const lo = F.floor / S, hi = F.top / S;
    const belt = this.beltAt(x0 + size / 2, z0 + size / 2);
    const n = Math.round(F.count[0] + (F.count[1] - F.count[0]) * belt * belt + rng());
    for (let i = 0; i < n; i++) {
      const radius = rng() < 0.15 ? rng.range(55, 95) : rng.range(14, 48);
      b.addBody(this.library.pick('rock', rng), {
        x: x0 + rng.range(0, size), y: rng.range(lo, hi), z: z0 + rng.range(0, size), radius,
        color: ROCK_GRAYS[Math.floor(rng() * ROCK_GRAYS.length)],
        spin: [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), rng.range(0.04, 0.3)], rng,
      });
    }
    // dust-sized pebbles: speed parallax only, never collide
    const pebbles = Math.round(1 + 4 * belt);
    for (let i = 0; i < pebbles; i++) {
      b.addBody(this.library.pick('pebble', rng), {
        x: x0 + rng.range(0, size), y: rng.range(lo, hi), z: z0 + rng.range(0, size), radius: rng.range(1.5, 5),
        color: 0x7d828a, spin: [rng.range(-1, 1), 1, rng.range(-1, 1), rng.range(0.3, 1.2)], collide: false, rng,
      });
    }
    if (rng() < F.moonChance) {
      const radius = rng.range(230, 480);
      b.addBody(this.library.pick('moon', rng), {
        x: x0 + size / 2, y: rng.range(lo + radius, hi - radius), z: z0 + size / 2, radius,
        color: 0xc3c8ce, spin: [rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3), rng.range(0.01, 0.035)], tag: 'moon', rng,
      });
    }
    const chunk = { cx, cz, ...this.world.finalize(b, this.materials) };
    this.chunks.set(key(cx, cz), chunk);
    this.stats.built++;
    return chunk;
  }

  /** World layer hook: called every frame from World.update */
  update(absX, y, absZ, fx, fz, tier) {
    const F = SPACE.field;
    if (y < F.dropBelow) { if (this.chunks.size) this.disposeAll(); return; }
    if (y < F.streamFrom && !this.chunks.size) return;
    const size = this.csize, view = this.world.viewDistance(tier);
    const pcx = Math.floor(absX / size), pcz = Math.floor(absZ / size);
    const R = Math.ceil(view / size) + 1;
    const wanted = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const cx = pcx + dx, cz = pcz + dz;
      const mx = (cx + 0.5) * size - absX, mz = (cz + 0.5) * size - absZ;
      const d = Math.hypot(mx, mz);
      if (d > view) continue;
      const ahead = (mx * fx + mz * fz) / (d || 1);
      if (d > 1100 * S && ahead < 0.25) continue;
      wanted.push({ cx, cz, score: d * (1.6 - ahead) });
    }
    const want = new Set(wanted.map((w) => key(w.cx, w.cz)));
    for (const [k, c] of this.chunks) {
      if (want.has(k)) continue;
      const d = Math.hypot(c.centerX - absX, c.centerZ - absZ);
      const ahead = ((c.centerX - absX) * fx + (c.centerZ - absZ) * fz) / (d || 1);
      if (d > view + 700 * S || (d > 1500 * S && ahead < 0)) { this.world.disposeChunk(c); this.chunks.delete(k); }
    }
    const missing = wanted.filter((w) => !this.chunks.has(key(w.cx, w.cz))).sort((a, b) => a.score - b.score);
    const t0 = performance.now();
    for (const w of missing) {
      this.buildColumn(w.cx, w.cz);
      if (performance.now() - t0 > WORLD.genBudgetMs) break;
    }
  }

  forEachNear(absX, absZ, fn) {
    if (!this.chunks.size) return;
    const size = this.csize;
    const pcx = Math.floor(absX / size), pcz = Math.floor(absZ / size);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.chunks.get(key(pcx + dx, pcz + dz));
      if (c) fn(c);
    }
  }

  rebase(origin) {
    for (const c of this.chunks.values()) c.group.position.set(c.centerX - origin.x, 0, c.centerZ - origin.z);
  }
}
