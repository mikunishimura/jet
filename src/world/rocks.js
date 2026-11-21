// Procedural rock archetypes. Built once at startup; chunks stamp transformed
// copies into merged buffers. Each archetype carries a radial profile so the
// collider at flight altitude matches the actual silhouette.
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

const PROFILE_BINS = 24;

function displaceNoise(rng) {
  const terms = [];
  for (let i = 0; i < 4; i++) {
    terms.push({
      a: rng.range(1.2, 3.8) * (i + 1) * 0.7, b: rng.range(1.2, 3.8) * (i + 1) * 0.7, c: rng.range(1.2, 3.8) * (i + 1) * 0.7,
      pa: rng.range(0, 6.28), pb: rng.range(0, 6.28), pc: rng.range(0, 6.28), amp: 1 / (i + 1.3),
    });
  }
  return (x, y, z) => {
    let s = 0;
    for (const t of terms) s += t.amp * Math.sin(x * t.a + t.pa) * Math.sin(y * t.b + t.pb) * Math.sin(z * t.c + t.pc);
    return s;
  };
}

function buildArchetype(seed, opt) {
  const rng = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(1, opt.detail); // non-indexed
  const pos = geo.attributes.position;
  const n3 = displaceNoise(rng);
  const v = new THREE.Vector3();
  const tilt = rng.range(-0.15, 0.15);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const len = 1 + opt.jag * n3(v.x * 1.3, v.y * 1.3, v.z * 1.3);
    v.multiplyScalar(len);
    v.y *= opt.stretch;
    if (opt.cone) {
      const h = (v.y / opt.stretch + 1) / 2; // 0 bottom .. 1 top
      const k = 1 - h * opt.cone;
      v.x *= k; v.z *= k;
    }
    v.x += v.y * tilt;
    if (opt.mesa && v.y > opt.mesa * opt.stretch) v.y = opt.mesa * opt.stretch + (v.y - opt.mesa * opt.stretch) * 0.05;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  // sink base into the ground: shift so bottom-cut sits at y = 0
  geo.computeBoundingBox();
  const minY = geo.boundingBox.min.y, cut = minY * (opt.sink ?? 0.55);
  for (let i = 0; i < pos.count; i++) {
    let y = pos.getY(i);
    if (y < cut) y = cut;
    pos.setY(i, y - cut);
  }
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const height = geo.boundingBox.max.y;

  // radial profile: max horizontal extent per height bin (normalized 0..1)
  const profile = new Float32Array(PROFILE_BINS);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / height;
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    const b = Math.min(PROFILE_BINS - 1, Math.floor(y * PROFILE_BINS));
    profile[b] = Math.max(profile[b], r);
  }
  // fill holes from neighbors
  for (let b = 1; b < PROFILE_BINS; b++) if (profile[b] === 0) profile[b] = profile[b - 1];

  const edges = new THREE.EdgesGeometry(geo, opt.edgeAngle ?? 16);
  return {
    kind: opt.kind,
    position: geo.attributes.position.array,
    normal: geo.attributes.normal.array,
    edges: edges.attributes.position.array,
    height,
    profile,
    /** horizontal radius (unit scale) at normalized height h */
    radiusAt(h) {
      if (h < 0 || h > 1) return 0;
      return profile[Math.min(PROFILE_BINS - 1, Math.floor(h * PROFILE_BINS))];
    },
  };
}

const KINDS = {
  boulder: { detail: 1, jag: 0.22, stretch: 0.85, sink: 0.4 },
  spire:   { detail: 1, jag: 0.18, stretch: 3.2, cone: 0.55, sink: 0.6 },
  shard:   { detail: 0, jag: 0.34, stretch: 2.1, cone: 0.35, sink: 0.6, edgeAngle: 8 },
  mesa:    { detail: 1, jag: 0.14, stretch: 1.3, mesa: 0.45, sink: 0.55 },
  peak:    { detail: 2, jag: 0.26, stretch: 1.5, cone: 0.72, sink: 0.62, edgeAngle: 22 },
};

export class RockLibrary {
  constructor(seed = 1, variants = 4) {
    this.byKind = {};
    let s = seed * 31;
    for (const [kind, opt] of Object.entries(KINDS)) {
      this.byKind[kind] = [];
      for (let i = 0; i < variants; i++) this.byKind[kind].push(buildArchetype(++s * 7717, { ...opt, kind }));
    }
  }
  pick(kind, rng) { const list = this.byKind[kind]; return list[Math.floor(rng() * list.length)]; }
}
