// Orbital bodies: procedural asteroid / moon archetypes and the SpaceBuilder
// that stamps them (plus boost rings) into one spinning, outlined mesh per
// column or path event. Same contract as ChunkBuilder (base meters, centerX/Z,
// colliders, triggers, animated, bake), so World.finalize/addDynamic take it.
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';
import { smoothNormals } from '../world/ChunkBuilder.js';
import { sphere } from '../game/Collision.js';
import { ringMaterial } from './materials.js';

const lump = (rng, octaves = 4) => {
  const t = [];
  for (let i = 0; i < octaves; i++) {
    const f = (i + 1) * rng.range(1.1, 1.9);
    t.push({ a: f * rng.range(0.7, 1.3), b: f * rng.range(0.7, 1.3), c: f * rng.range(0.7, 1.3), pa: rng.range(0, 6.28), pb: rng.range(0, 6.28), pc: rng.range(0, 6.28), amp: 1 / (i + 1) ** 1.2 });
  }
  return (x, y, z) => { let s = 0; for (const k of t) s += k.amp * Math.sin(x * k.a + k.pa) * Math.sin(y * k.b + k.pb) * Math.sin(z * k.c + k.pc); return s; };
};

function finish(geo) {
  geo.computeVertexNormals(); // non-indexed: flat facets
  const position = geo.attributes.position.array, normal = geo.attributes.normal.array;
  return { position, normal, smooth: smoothNormals(position, normal) };
}

/** potato: a lumpy, stretched icosphere (vertices displaced by position, so it stays watertight) */
function asteroidArchetype(seed, detail) {
  const rng = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position, v = new THREE.Vector3();
  const n = lump(rng), jag = rng.range(0.18, 0.32);
  const sx = 1, sy = rng.range(0.62, 0.9), sz = rng.range(0.55, 0.85);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + jag * n(v.x * 1.6, v.y * 1.6, v.z * 1.6));
    pos.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  return { kind: 'rock', ...finish(geo), extent: (sx + Math.min(sy, sz)) / 2 };
}

/** moon: a round body pocked with craters (bowl + raised rim) */
function moonArchetype(seed, detail = 3) {
  const rng = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position, v = new THREE.Vector3();
  const craters = Array.from({ length: rng.int(9, 16) }, () => ({
    c: new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize(),
    r: rng.range(0.12, 0.42), depth: rng.range(0.03, 0.08),
  }));
  const n = lump(rng, 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let h = 0.025 * n(v.x * 2.2, v.y * 2.2, v.z * 2.2);
    for (const k of craters) {
      const d = v.angleTo(k.c) / k.r;              // 0 at the crater center, 1 at its rim
      if (d < 1) h -= k.depth * (1 - d * d);       // bowl
      else if (d < 1.45) h += k.depth * 0.45 * Math.sin(((d - 1) / 0.45) * Math.PI); // rim wall
    }
    v.multiplyScalar(1 + h);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return { kind: 'moon', ...finish(geo), extent: 0.97 };
}

export class BodyLibrary {
  constructor(seed = 11) {
    const rng = mulberry32(seed);
    this.sets = {
      rock: Array.from({ length: 8 }, (_, i) => asteroidArchetype((rng() * 1e9) | 0, i < 5 ? 1 : 2)),
      pebble: Array.from({ length: 3 }, () => asteroidArchetype((rng() * 1e9) | 0, 0)),
      moon: Array.from({ length: 3 }, () => moonArchetype((rng() * 1e9) | 0, 3)),
    };
  }
  pick(kind, rng = Math.random) { const s = this.sets[kind]; return s[Math.floor(rng() * s.length)]; }
}

class Grow {
  constructor(n = 8192) { this.a = new Float32Array(n); this.len = 0; }
  reserve(k) {
    if (this.len + k <= this.a.length) return;
    let n = this.a.length * 2; while (n < this.len + k) n *= 2;
    const b = new Float32Array(n); b.set(this.a.subarray(0, this.len)); this.a = b;
  }
  push3(x, y, z) { const a = this.a; a[this.len++] = x; a[this.len++] = y; a[this.len++] = z; }
  view() { return this.a.slice(0, this.len); }
}

const _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _ax = new THREE.Vector3();

export class SpaceBuilder {
  /** centerX/centerZ: base-meter center of this column / event (positions are stored relative to it) */
  constructor(centerX, centerZ) {
    this.centerX = centerX; this.centerZ = centerZ;
    this.pos = new Grow(); this.nor = new Grow(); this.snor = new Grow(); this.col = new Grow(); this.cen = new Grow();
    this.spin = new Grow(); // 4 floats per vertex
    this.colliders = []; this.triggers = []; this.objects = []; this.animated = [];
    this.bodies = 0;
  }

  /**
   * Stamp a body (base meters). spin: [ax, ay, az, rad/s]. Returns its sphere
   * collider (forgiving: a bit inside the lumpy surface) or null.
   */
  addBody(arch, { x, y, z, radius, color = 0x6b7077, rot = null, spin = [0, 1, 0, 0], collide = true, tag = 'asteroid', rng = Math.random }) {
    _e.set(rot ? rot[0] : rng() * 6.28, rot ? rot[1] : rng() * 6.28, rot ? rot[2] : rng() * 6.28);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _s.setScalar(radius));
    _n.getNormalMatrix(_m);
    const { position, normal, smooth } = arch;
    const count = position.length / 3;
    for (const g of [this.pos, this.nor, this.snor, this.col, this.cen]) g.reserve(count * 3);
    this.spin.reserve(count * 4);
    _ax.set(spin[0], spin[1], spin[2]).normalize();
    const cx = x - this.centerX, cz = z - this.centerZ;
    _c.set(color);
    const sa = this.spin.a;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      _v.set(position[k], position[k + 1], position[k + 2]).applyMatrix4(_m);
      this.pos.push3(_v.x - this.centerX, _v.y, _v.z - this.centerZ);
      _v.set(normal[k], normal[k + 1], normal[k + 2]).applyMatrix3(_n).normalize();
      this.nor.push3(_v.x, _v.y, _v.z);
      _v.set(smooth[k], smooth[k + 1], smooth[k + 2]).applyMatrix3(_n).normalize();
      this.snor.push3(_v.x, _v.y, _v.z);
      // facets vary a touch in value: reads as rock, stays neutral gray
      const f = 0.9 + 0.1 * Math.sin(Math.floor(i / 3) * 12.9898 + x) ** 2;
      this.col.push3(_c.r * f, _c.g * f, _c.b * f);
      this.cen.push3(cx, y, cz);
      sa[this.spin.len++] = _ax.x; sa[this.spin.len++] = _ax.y; sa[this.spin.len++] = _ax.z; sa[this.spin.len++] = spin[3];
    }
    this.bodies++;
    if (!collide) return null;
    const c = sphere(x, y, z, radius * arch.extent * 0.9, tag);
    this.colliders.push(c);
    return c;
  }

  /**
   * Boost ring (the orbital survey gate): a striped torus facing along
   * `heading` (the flight direction it was placed for), ring of sphere
   * colliders for the tube, and a 'ring' trigger disk inside it.
   */
  addRing({ x, y, z, heading, radius = 65, tube = 5, id }) {
    const mat = ringMaterial(18);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 72), mat);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, tube * 1.22, 8, 72));
    rim.userData.rim = true;            // gets the shared rim material at bake
    ring.add(rim);
    ring.rotation.y = heading;          // torus axis (+Z) -> along the flight direction
    ring.frustumCulled = false;         // the trigger flash must show even edge-on
    this.addObject(ring, x, y, z);
    const nx = -Math.sin(heading), nz = -Math.cos(heading);
    const rx = Math.cos(heading), rz = -Math.sin(heading); // ring plane: right + up
    const N = 32;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, ca = Math.cos(a) * radius, sa = Math.sin(a) * radius;
      this.colliders.push(sphere(x + rx * ca, y + sa, z + rz * ca, tube * 1.05, 'ring'));
    }
    const t = { kind: 'ring', x, y, z, nx, ny: 0, nz, r: radius - tube, id, type: 'ring', material: mat };
    this.triggers.push(t);
    return t;
  }

  addCollider(c) { this.colliders.push(c); return c; }
  addTrigger(t) { this.triggers.push(t); return t; }
  addObject(obj, x, y, z, update) {
    obj.position.set(x - this.centerX, y, z - this.centerZ);
    this.objects.push(obj);
    if (update) this.animated.push(update);
    return obj;
  }

  bake(materials) {
    const group = new THREE.Group();
    if (this.pos.len) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(this.nor.view(), 3));
      g.setAttribute('aSmooth', new THREE.BufferAttribute(this.snor.view(), 3));
      g.setAttribute('color', new THREE.BufferAttribute(this.col.view(), 3));
      g.setAttribute('aCenter', new THREE.BufferAttribute(this.cen.view(), 3));
      g.setAttribute('aSpin', new THREE.BufferAttribute(this.spin.view(), 4));
      g.computeBoundingSphere();
      g.boundingSphere.radius *= 1.15; // spinning lumps + rim
      group.add(new THREE.Mesh(g, materials.body));
      group.add(new THREE.Mesh(g, materials.outline));
    }
    for (const o of this.objects) {
      o.traverse((c) => { if (c.userData.rim) c.material = materials.ringRim; });
      group.add(o);
    }
    return group;
  }
}
