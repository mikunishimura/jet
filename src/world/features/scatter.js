// Low rubble and lab survey markers. They sell speed when you cruise above
// them, and they are solid: skimming the floor for ground effect is a slalom.
import * as THREE from 'three';
import { registerFeature } from './registry.js';
import { PALETTE, WORLD_DENSITY } from '../../config.js';
import { capsule } from '../../game/Collision.js';

const pole = new THREE.BoxGeometry(1.6, 1, 1.6).toNonIndexed();
const cap = new THREE.BoxGeometry(4, 4, 4).toNonIndexed();
const _m = new THREE.Matrix4();

registerFeature({
  id: 'scatter',
  order: 5,
  generate(ctx) {
    const { rng, x0, z0, size, biomes } = ctx;
    const k = biomes.region(x0 + size / 2, z0 + size / 2);
    const [lo, hi] = WORLD_DENSITY.rubble;
    const n = Math.round(lo + (hi - lo) * k);
    for (let i = 0; i < n; i++) {
      const x = x0 + rng.range(0, size), z = z0 + rng.range(0, size);
      const r = rng.range(3, 14);
      ctx.builder.addRock(ctx.rocks.pick(rng.chance(0.7) ? 'boulder' : 'shard', rng), {
        x, z, radius: r, height: r * rng.range(0.5, 1.4), rotY: rng.range(0, 6.28), color: 0x1e2023, tag: 'rubble',
      });
    }
    // survey markers: striped posts with an orange head
    if (rng.chance(0.25)) {
      const x = x0 + rng.range(0, size), z = z0 + rng.range(0, size);
      const h = rng.range(8, 16);
      _m.makeScale(1, h, 1).setPosition(x, h / 2, z);
      ctx.builder.addGeometry(pole, _m, 0x2a2e33, { edges: false });
      _m.makeRotationY(rng.range(0, 3)).setPosition(x, h + 2, z);
      ctx.builder.addGeometry(cap, _m, PALETTE.hazard, { edgeAngle: 30 });
      ctx.builder.addCollider(capsule(x, z, x + 0.01, z, 2.5, h + 4, -Infinity, 'marker'));
    }
  },
});
