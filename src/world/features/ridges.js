// Mountain ridges: chains of huge faceted peaks along noise contour lines,
// with passes (gaps) you can thread at speed.
import { registerFeature } from './registry.js';

registerFeature({
  id: 'ridges',
  order: 0,
  generate(ctx) {
    const { rng, biomes, x0, z0, size } = ctx;
    const step = 170;
    for (let gx = 0; gx < size; gx += step) {
      for (let gz = 0; gz < size; gz += step) {
        const x = x0 + gx + rng.range(0, step), z = z0 + gz + rng.range(0, step);
        const s = biomes.ridge(x, z);
        if (s <= 0.05) continue;
        if (biomes.pass(x, z)) {
          // the pass floor: low rubble that still reads as part of the ridge
          if (rng.chance(0.5)) ctx.builder.addRock(ctx.rocks.pick('boulder', rng), { x, z, radius: rng.range(20, 45), height: rng.range(6, 18), rotY: rng.range(0, 6.28), color: 0x202226 });
          continue;
        }
        const r = Math.min(400, 70 + 260 * s * rng.range(0.6, 1.0));
        if (ctx.isReserved(x, z, r)) continue;
        const height = r * rng.range(1.0, 1.7) * (0.7 + 0.5 * s);
        const shade = 0.93 + 0.07 * rng();
        const v = Math.round(0x1d * shade);
        const color = (v << 16) | (v << 8) | v; // neutral white/gray, never tinted
        ctx.builder.addRock(ctx.rocks.pick('peak', rng), { x, z, radius: r, height, rotY: rng.range(0, 6.28), color, tag: 'mountain' });
      }
    }
  },
});
