// Survey gates: ink/white striped arches. Flying between the pillars triggers a
// bonus (barrier charge + score). Demonstrates multi-part structures, capsule
// colliders and pass-through triggers — the same recipe a tunnel would use.
import * as THREE from 'three';
import { registerFeature } from './registry.js';
import { capsule } from '../../game/Collision.js';
import { PALETTE } from '../../config.js';

const box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function boxAt(builder, x, y, z, sx, sy, sz, yaw, color) {
  _q.setFromAxisAngle(UP, yaw);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  builder.addGeometry(box, _m, color, { edgeAngle: 30 });
}

/**
 * Build a survey gate centered at (x, z). `yaw` orients the pillar axis;
 * flying between the pillars (under the beam) fires the 'gate' trigger.
 */
export function buildGate(builder, x, z, yaw, span, id) {
  const ux = Math.cos(yaw), uz = -Math.sin(yaw); // axis between pillars
  const H = 95, W = 16;
  const ax = x - ux * span / 2, az = z - uz * span / 2;
  const bx = x + ux * span / 2, bz = z + uz * span / 2;
  const bands = 7;
  for (const [px, pz] of [[ax, az], [bx, bz]]) {
    for (let i = 0; i < bands; i++) {
      const h = H / bands;
      boxAt(builder, px, h * i + h / 2, pz, W, h, W, yaw, i % 2 ? 0x15171a : 0x34383e);
    }
    builder.addCollider(capsule(px, pz, px + 0.01, pz, W * 0.75, H, -Infinity, 'pillar'));
  }
  boxAt(builder, x, H + 7, z, span + W, 14, W * 0.9, yaw, 0x15171a);
  builder.addCollider(capsule(ax, az, bx, bz, W * 0.45, H + 14, H - 5, 'beam'));
  boxAt(builder, x, H - 4, z, span - W, 3, 3, yaw, 0xffffff); // white strip: marks a bonus gate
  builder.footprints.push({ x, z, r: span / 2 + W });
  builder.addTrigger({ kind: 'segment', ax, az, bx, bz, top: H - 5, id, type: 'gate' });
}

registerFeature({
  id: 'gates',
  order: 3,
  generate(ctx) {
    const { rng, x0, z0, size, biomes } = ctx;
    const cxm = x0 + size / 2, czm = z0 + size / 2;
    if (biomes.ridge(cxm, czm) > 0.05) return;
    if (!rng.chance(0.015)) return; // most gates now come from PathHazards, on your line
    const x = x0 + rng.range(100, size - 100), z = z0 + rng.range(100, size - 100);
    const span = rng.range(110, 160);
    if (ctx.isReserved(x, z, span) || ctx.builder.overlaps(x, z, span)) return;
    buildGate(ctx.builder, x, z, rng.range(0, Math.PI), span, `gate:${ctx.cx}:${ctx.cz}`);
  },
});
