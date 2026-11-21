// Pooled point "glyphs" in the lab/terminal style: hard-edged squares, plus
// signs, hollow squares and rings. No soft gradients, no smoke; opacity fades
// in discrete steps like a terminal redraw.
//
// Frames: a particle is either world-fixed (terrain dust, trails left in the
// air) or `rel` = carried along in the player's frame (combat effects), so it
// stays readable at Mach 100.
import * as THREE from 'three';
import { CURVE, CURVE_FADE, CURVE_GLSL } from './curvature.js';

export const SHAPE = { SQUARE: 0, PLUS: 1, BOX: 2, RING: 3 };

const vert = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute float aShape;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float fogDensity;
  ${CURVE_GLSL}
  varying float vAlpha;
  varying vec3 vColor;
  varying float vShape;
  varying float vFog;
  void main() {
    vec4 mv = viewMatrix * curveWorld(modelMatrix * vec4(position, 1.0));
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(2.0, aSize * uScale / max(1.0, -mv.z));
    vAlpha = aAlpha; vColor = aColor; vShape = aShape;
    float fd = fogDensity * -mv.z;
    vFog = 1.0 - exp(-fd * fd);
  }
`;
const frag = /* glsl */`
  uniform vec3 fogColor;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vShape;
  varying float vFog;
  void main() {
    vec2 p = abs(gl_PointCoord - 0.5) * 2.0;   // 0 center .. 1 edge
    float m = max(p.x, p.y);
    bool keep;
    if (vShape < 0.5) keep = m < 0.9;                                   // filled square
    else if (vShape < 1.5) keep = min(p.x, p.y) < 0.22 && m < 0.95;     // plus
    else if (vShape < 2.5) keep = m < 0.95 && m > 0.62;                 // hollow square
    else { float r = length(gl_PointCoord - 0.5) * 2.0; keep = r < 0.95 && r > 0.66; } // ring
    if (!keep) discard;
    float a = floor(vAlpha * 4.0 + 0.5) / 4.0;  // stepped fade
    if (a <= 0.0) discard;
    gl_FragColor = vec4(mix(vColor, fogColor, vFog), a * (1.0 - vFog * 0.8));
  }
`;

export class Particles {
  constructor(scene, max = 5000) {
    this.max = max;
    this.count = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.shape = new Float32Array(max);
    this.rel = new Uint8Array(max);
    this.fresh = new Uint8Array(max); // emitted this frame: the jet already moved, skip its displacement once
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aShape = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize); g.setAttribute('aAlpha', this.aAlpha); g.setAttribute('aShape', this.aShape);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 }, fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, uCurve: CURVE, uCurveFade: CURVE_FADE },
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this._c = new THREE.Color(); this._c2 = new THREE.Color();
  }
  clear() { this.count = 0; }
  emit(o) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.p[i3] = o.x; this.p[i3 + 1] = o.y; this.p[i3 + 2] = o.z;
    this.v[i3] = o.vx || 0; this.v[i3 + 1] = o.vy || 0; this.v[i3 + 2] = o.vz || 0;
    this._c.set(o.color ?? 0x15171a); this._c2.set(o.colorEnd ?? o.color ?? 0x15171a);
    this.c0[i3] = this._c.r; this.c0[i3 + 1] = this._c.g; this.c0[i3 + 2] = this._c.b;
    this.c1[i3] = this._c2.r; this.c1[i3 + 1] = this._c2.g; this.c1[i3 + 2] = this._c2.b;
    this.life[i] = this.maxLife[i] = o.life ?? 1;
    this.s0[i] = o.size ?? 3; this.s1[i] = o.sizeEnd ?? this.s0[i];
    this.a0[i] = o.alpha ?? 1;
    this.drag[i] = o.drag ?? 0; this.grav[i] = o.gravity ?? 0;
    this.shape[i] = o.shape ?? SHAPE.SQUARE;
    this.rel[i] = o.rel ? 1 : 0;
    this.fresh[i] = 1;
  }
  burst(x, y, z, n, f) { for (let k = 0; k < n; k++) this.emit(f(x, y, z, k)); }
  rebase(dx, dz) { for (let i = 0; i < this.count; i++) { this.p[i * 3] -= dx; this.p[i * 3 + 2] -= dz; } }
  /** frameVel: the player's velocity; `rel` particles ride along with it */
  update(dt, camera, fog, viewportH, frameVel) {
    const P = this.aPos.array, C = this.aCol.array, S = this.aSize.array, A = this.aAlpha.array, SH = this.aShape.array;
    const fx = frameVel ? frameVel.x * dt : 0, fy = frameVel ? frameVel.y * dt : 0, fz = frameVel ? frameVel.z * dt : 0;
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.swapRemove(i); continue; }
      const i3 = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.v[i3] *= dr; this.v[i3 + 1] = this.v[i3 + 1] * dr - this.grav[i] * dt; this.v[i3 + 2] *= dr;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      if (this.rel[i] && !this.fresh[i]) { this.p[i3] += fx; this.p[i3 + 1] += fy; this.p[i3 + 2] += fz; }
      this.fresh[i] = 0;
      if (this.p[i3 + 1] < 0.5) { this.p[i3 + 1] = 0.5; this.v[i3 + 1] *= -0.3; }
      const t = 1 - this.life[i] / this.maxLife[i];
      P[i3] = this.p[i3]; P[i3 + 1] = this.p[i3 + 1]; P[i3 + 2] = this.p[i3 + 2];
      const ct = t < 0.5 ? 0 : 1; // colors switch, never blend
      C[i3] = ct ? this.c1[i3] : this.c0[i3]; C[i3 + 1] = ct ? this.c1[i3 + 1] : this.c0[i3 + 1]; C[i3 + 2] = ct ? this.c1[i3 + 2] : this.c0[i3 + 2];
      S[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      A[i] = this.a0[i] * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
      SH[i] = this.shape[i];
      i++;
    }
    this.points.geometry.setDrawRange(0, this.count);
    for (const a of [this.aPos, this.aCol]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.count * 3); }
    for (const a of [this.aSize, this.aAlpha, this.aShape]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.count); }
    this.material.uniforms.uScale.value = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    if (fog) { this.material.uniforms.fogColor.value.copy(fog.color); this.material.uniforms.fogDensity.value = fog.density; }
  }
  swapRemove(i) {
    const j = --this.count;
    if (i === j) return;
    const i3 = i * 3, j3 = j * 3;
    for (let k = 0; k < 3; k++) {
      this.p[i3 + k] = this.p[j3 + k]; this.v[i3 + k] = this.v[j3 + k];
      this.c0[i3 + k] = this.c0[j3 + k]; this.c1[i3 + k] = this.c1[j3 + k];
    }
    this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    this.a0[i] = this.a0[j]; this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j];
    this.shape[i] = this.shape[j]; this.rel[i] = this.rel[j]; this.fresh[i] = this.fresh[j];
  }
}

const INK = 0x15171a, RED = 0xff3b30, GRAY = 0x8d939a;
const R = Math.random;

/**
 * Explosion in the lab style: an expanding wireframe shell, two rings, and a
 * spray of hard glyphs (squares, plus signs) in ink and red. No smoke.
 * `fx` = { normal: Particles, vector: VectorFX }. Rides in the player's frame.
 */
export function explosion(fx, x, y, z, scale = 1, color = RED) {
  fx.vector?.shell(x, y, z, 2 * scale, 34 * scale, 0.42, color);
  fx.vector?.ring(x, y, z, 4 * scale, 58 * scale, 0.32, INK);
  fx.vector?.ring(x, y, z, 2 * scale, 30 * scale, 0.5, color, -0.08);
  const n = Math.round(22 * scale);
  for (let k = 0; k < n; k++) {
    const a = R() * 6.283, b = R() * 3.14 - 1.57, sp = (70 + R() * 230) * scale;
    fx.normal.emit({ x, y, z, rel: true,
      vx: Math.cos(a) * Math.cos(b) * sp, vy: Math.sin(b) * sp, vz: Math.sin(a) * Math.cos(b) * sp,
      life: 0.35 + R() * 0.55, size: (2.5 + R() * 3.5) * scale, color: R() < 0.55 ? INK : RED,
      shape: k % 3 === 0 ? SHAPE.PLUS : k % 3 === 1 ? SHAPE.SQUARE : SHAPE.BOX, drag: 2.2 });
  }
}

/** small hit marker: a few plus signs */
export function sparks(fx, x, y, z, n = 3, color = INK, rel = true) {
  for (let k = 0; k < n; k++) {
    fx.normal.emit({ x, y, z, rel, vx: (R() - 0.5) * 90, vy: (R() - 0.2) * 90, vz: (R() - 0.5) * 90,
      life: 0.22 + R() * 0.12, size: 2.2, color, shape: SHAPE.PLUS, drag: 3 });
  }
}

export const FX_COLORS = { INK, RED, GRAY };
