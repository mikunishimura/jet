// Tall standalone rocks: spires, shards, mesas and boulders. Density follows
// the `rocky` field so open plains alternate with slalom fields.
import { registerFeature } from './registry.js';
import { WORLD_DENSITY } from '../../config.js';

const KINDS = [['spire', 3], ['shard', 2], ['mesa', 2], ['boulder', 3]];
function weightedKind(rng) {
  let t = rng() * KINDS.reduce((s, k) => s + k[1], 0);
  for (const [k, w] of KINDS) { if ((t -= w) <= 0) return k; }
  return 'boulder';
}
const DIMS = {
  spire:   { r: [16, 45],  h: [90, 260] },
  shard:   { r: [18, 50],  h: [60, 180] },
  mesa:    { r: [60, 150], h: [45, 120] },
  boulder: { r: [30, 90],  h: [40, 110] },
};

registerFeature({
  id: 'rockfield',
  order: 1,
  generate(ctx) {
    const { rng, biomes, x0, z0, size } = ctx;
    const cx = x0 + size / 2, cz = z0 + size / 2;
    const rocky = biomes.rocky(cx, cz) * biomes.region(cx, cz);
    // dense fields only inside mountain regions; the occasional lone rock elsewhere
    const count = Math.round(rocky * rocky * WORLD_DENSITY.rockfieldMax + (rng.chance(WORLD_DENSITY.loneRockChance) ? 1 : 0));
    for (let i = 0; i < count; i++) {
      const kind = weightedKind(rng);
      const d = DIMS[kind];
      const radius = rng.range(d.r[0], d.r[1]);
      const x = x0 + rng.range(0, size), z = z0 + rng.range(0, size);
      if (ctx.isReserved(x, z, radius) || ctx.builder.overlaps(x, z, radius * 0.6)) continue;
      const height = rng.range(d.h[0], d.h[1]);
      const warm = rng.chance(0.15);
      const color = warm ? 0x202226 : rng.chance(0.5) ? 0x1a1c1f : 0x16181b; // near-black, neutral
      ctx.builder.addRock(ctx.rocks.pick(kind, rng), {
        x, z, radius, height, rotY: rng.range(0, 6.28), color,
        tiltX: kind === 'shard' ? rng.range(-0.25, 0.25) : 0, tiltZ: kind === 'shard' ? rng.range(-0.25, 0.25) : 0,
      });
    }
  },
});
