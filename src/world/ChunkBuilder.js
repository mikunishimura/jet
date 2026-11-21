// Accumulates everything a chunk contains, then bakes it into as few draw calls
// as possible: one merged faceted mesh + its silhouette-outline pass, plus any
// bespoke Object3Ds a feature wants (animated things, transparent things).
//
// Coordinates: features work in ABSOLUTE world meters (doubles). Geometry is
// stored relative to the chunk center so float32 precision holds anywhere.
// Colliders/triggers stay absolute and are never rebased.
import * as THREE from 'three';
import { circle } from '../game/Collision.js';

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Smoothed (position-averaged) normals for a non-indexed triangle soup.
 * Used by the silhouette outline pass: extruding along smooth normals keeps
 * the white rim continuous across hard facet edges. Cached per source array.
 */
const smoothCache = new WeakMap();
function smoothNormals(position, normal) {
  let s = smoothCache.get(position);
  if (s) return s;
  const acc = new Map();
  const key = (i) => `${position[i].toFixed(4)},${position[i + 1].toFixed(4)},${position[i + 2].toFixed(4)}`;
  for (let i = 0; i < position.length; i += 3) {
    const k = key(i);
    const a = acc.get(k) || [0, 0, 0];
    a[0] += normal[i]; a[1] += normal[i + 1]; a[2] += normal[i + 2];
    acc.set(k, a);
  }
  s = new Float32Array(position.length);
  for (let i = 0; i < position.length; i += 3) {
    const a = acc.get(key(i));
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    s[i] = a[0] / l; s[i + 1] = a[1] / l; s[i + 2] = a[2] / l;
  }
  smoothCache.set(position, s);
  return s;
}

class Growable {
  constructor(n = 4096) { this.a = new Float32Array(n); this.len = 0; }
  reserve(k) {
    if (this.len + k <= this.a.length) return;
    let n = this.a.length * 2; while (n < this.len + k) n *= 2;
    const b = new Float32Array(n); b.set(this.a.subarray(0, this.len)); this.a = b;
  }
  view() { return this.a.slice(0, this.len); }
}

export class ChunkBuilder {
  constructor(cx, cz, size) {
    this.cx = cx; this.cz = cz; this.size = size;
    this.centerX = (cx + 0.5) * size;
    this.centerZ = (cz + 0.5) * size;
    this.pos = new Growable(); this.nor = new Growable(); this.col = new Growable(); this.snor = new Growable();
    this.colliders = [];
    this.triggers = [];
    this.objects = [];
    this.footprints = []; // {x,z,r} of tall things, for overlap avoidance
    this.animated = [];
  }

  /** Merge a non-indexed geometry (arrays) with a transform and color. */
  /** `edges` / `edgeColor` are accepted for API compatibility but unused:
   *  obstacles get a silhouette outline instead of facet lines. */
  addArrays(position, normal, edges, matrix, color, edgeColor = null) {
    _n.getNormalMatrix(matrix);
    const P = this.pos, N = this.nor, C = this.col, SN = this.snor;
    const smooth = smoothNormals(position, normal);
    const count = position.length / 3;
    P.reserve(count * 3); N.reserve(count * 3); C.reserve(count * 3); SN.reserve(count * 3);
    _c.set(color);
    for (let i = 0; i < count; i++) {
      _v.set(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]).applyMatrix4(matrix);
      P.a[P.len++] = _v.x - this.centerX; P.a[P.len++] = _v.y; P.a[P.len++] = _v.z - this.centerZ;
      // darken toward the base: cheap ambient occlusion, reads as weight
      const k = 0.8 + 0.2 * Math.min(1, _v.y / 70);
      _v.set(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]).applyMatrix3(_n).normalize();
      N.a[N.len++] = _v.x; N.a[N.len++] = _v.y; N.a[N.len++] = _v.z;
      _v.set(smooth[i * 3], smooth[i * 3 + 1], smooth[i * 3 + 2]).applyMatrix3(_n).normalize();
      SN.a[SN.len++] = _v.x; SN.a[SN.len++] = _v.y; SN.a[SN.len++] = _v.z;
      C.a[C.len++] = _c.r * k; C.a[C.len++] = _c.g * k; C.a[C.len++] = _c.b * k;
    }
  }

  /** Merge any three.js geometry (converted to non-indexed) in absolute coords. */
  addGeometry(geometry, matrix, color, { edges = true, edgeAngle = 20, edgeColor = null } = {}) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (!g.attributes.normal) g.computeVertexNormals();
    this.addArrays(g.attributes.position.array, g.attributes.normal.array, null, matrix, color);
  }

  /**
   * Stamp a rock archetype. Returns the collider (or null if the rock is low
   * enough to fly over).
   */
  addRock(arch, { x, z, radius, height, rotY = 0, color = 0xd8d5ce, collide = true, tag = 'rock', tiltX = 0, tiltZ = 0 }) {
    const sy = height / arch.height;
    _p.set(x, 0, z);
    _q.setFromEuler(new THREE.Euler(tiltX, rotY, tiltZ));
    _s.set(radius, sy, radius);
    _m.compose(_p, _q, _s);
    this.addArrays(arch.position, arch.normal, arch.edges, _m, color);
    if (!collide || height < 1.5) return null;
    // collider follows the rock's real silhouette at every height (88%: forgiving)
    const k = radius * 0.88;
    const rAt = (y) => arch.radiusAt(y / height) * k;
    let rmax = 0;
    for (let i = 0; i < arch.profile.length; i++) rmax = Math.max(rmax, arch.profile[i]);
    const c = circle(x, z, rmax * k, height, -Infinity, tag, rAt);
    c.radius = radius; c.height = height;
    this.colliders.push(c);
    this.footprints.push({ x, z, r: radius });
    return c;
  }

  addCollider(c) { this.colliders.push(c); return c; }
  addTrigger(t) { this.triggers.push(t); return t; }
  /** Add a standalone object at absolute (x, y, z). `update(dt, time)` optional for animation. */
  addObject(obj, x, y, z, update) {
    obj.position.set(x - this.centerX, y, z - this.centerZ);
    this.objects.push(obj);
    if (update) this.animated.push(update);
    return obj;
  }
  overlaps(x, z, r) {
    for (const f of this.footprints) if (Math.hypot(f.x - x, f.z - z) < f.r + r) return true;
    return false;
  }

  bake(materials) {
    const group = new THREE.Group();
    if (this.pos.len) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(this.nor.view(), 3));
      g.setAttribute('color', new THREE.BufferAttribute(this.col.view(), 3));
      g.setAttribute('aSmooth', new THREE.BufferAttribute(this.snor.view(), 3));
      g.computeBoundingSphere();
      g.boundingSphere.radius *= 1.05; // room for the outline rim
      group.add(new THREE.Mesh(g, materials.solid));
      // silhouette: back faces pushed out ~2 px in screen space, drawn white
      group.add(new THREE.Mesh(g, materials.outline));
    }
    for (const o of this.objects) group.add(o);
    return group;
  }
}
export { UP };
