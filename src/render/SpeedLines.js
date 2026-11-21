// Camera-space streaks that sell velocity. Invisible at tier I, a blizzard at V.
//
// The streaks live in a "flow frame" (u, w, d) expressed in camera space: d is the
// direction the air comes from (the jet's velocity), u/w span the tube around it.
// Looking straight ahead, d is the camera's forward axis and the frame is the
// camera's own axes (the classic tunnel). Looking away, d is the velocity seen
// from the camera, so the air streams past along the flight path, not into your face.
// Cost: one inverse quaternion + 3 small vector ops per frame, same per-line work as before.
import * as THREE from 'three';
import { SPEED_LINES } from '../config.js';

const FWD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Pure: advance the flow frame one step. Mutates d/u/w (unit THREE.Vector3, camera space).
 * vCam: unit velocity direction in camera space. Returns the "look-away" weight 0..1.
 * Within cfg.deadzone (radians) the frame is exactly the camera's (current look);
 * by cfg.full it follows the velocity; in between it blends smoothly.
 * u is carried over from the previous frame (parallel transport, no flips at any angle)
 * and relaxed toward camera-up so the tube never slowly spins.
 */
export function stepFlowFrame(frame, vCam, dt, cfg = SPEED_LINES) {
  const { d, u, w } = frame;
  const ang = Math.acos(Math.min(1, Math.max(-1, vCam.dot(FWD))));
  const k = smooth(cfg.deadzone, cfg.full, ang);
  // target flow axis: camera forward inside the dead zone, the real velocity outside
  if (k <= 0) d.copy(FWD);
  else if (k >= 1) d.copy(vCam);
  else {
    // slerp-free blend: angles here are < cfg.full (well under 90 deg), so lerp+normalize is smooth
    d.copy(FWD).lerp(vCam, k);
    if (d.lengthSq() < 1e-8) d.copy(vCam);
    d.normalize();
  }
  // transport u onto the plane perpendicular to d, then ease it toward camera-up x d
  u.addScaledVector(d, -u.dot(d));
  // ref = normalize(cross(d, UP)): camera +X when d = FWD
  const cx = d.y * UP.z - d.z * UP.y, cy = d.z * UP.x - d.x * UP.z, cz = d.x * UP.y - d.y * UP.x;
  const cl = Math.hypot(cx, cy, cz); // ~0 only when the flight path is along the camera's up axis
  if (cl > 1e-3) {
    const relax = (1 - Math.exp(-cfg.relax * dt)) * Math.min(1, cl / 0.3);
    const ul = u.length();
    if (ul < 1e-4) u.set(cx / cl, cy / cl, cz / cl);
    else u.multiplyScalar(1 / ul).lerp(frame._r.set(cx / cl, cy / cl, cz / cl), k >= 1 ? relax : 1);
  }
  if (u.lengthSq() < 1e-8) u.set(1, 0, 0).addScaledVector(d, -d.x);
  u.normalize();
  w.crossVectors(u, d); // = camera +Y when d = FWD and u = +X
  return k;
}

export class SpeedLines {
  constructor(camera, count = 260, cfg = SPEED_LINES) {
    this.camera = camera; this.cfg = cfg;
    this.count = count;
    this.data = new Float32Array(count * 3); // (x, y) across the tube, s = distance upstream along d
    const pos = new Float32Array(count * 6);
    const g = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attr);
    this.material = new THREE.LineBasicMaterial({ color: 0x3a3e44, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    camera.add(this.lines);
    this.frame = { d: FWD.clone(), u: new THREE.Vector3(1, 0, 0), w: new THREE.Vector3(0, 1, 0), _r: new THREE.Vector3() };
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    for (let i = 0; i < count; i++) this.respawn(i, true);
  }
  respawn(i, anywhere) {
    const a = Math.random() * Math.PI * 2;
    const r = 14 + Math.pow(Math.random(), 0.7) * 90;
    this.data[i * 3] = Math.cos(a) * r;
    this.data[i * 3 + 1] = Math.sin(a) * r * 0.6;
    this.data[i * 3 + 2] = anywhere ? Math.random() * 700 : 600 + Math.random() * 100;
  }
  /** vel: the jet's world velocity (optional; without it the streaks keep the camera tunnel) */
  update(dt, speed, level, charge, vel) {
    const f = this.frame, cfg = this.cfg;
    // velocity direction in camera space (one quaternion inverse per frame)
    let away = 0;
    if (vel && vel.lengthSq() > 1) {
      this._q.copy(this.camera.quaternion).invert();
      const v = this._v.copy(vel).normalize().applyQuaternion(this._q);
      away = stepFlowFrame(f, v, dt, cfg);
    } else stepFlowFrame(f, FWD, dt, cfg);
    const { d, u, w } = f;
    // looking along the flight path the streaks die just behind the lens; looking away
    // they keep going so you watch them stream past and recede (not pop out mid-screen)
    const facing = -d.z;                       // 1 = streaming straight at the lens
    const kill = -5 - cfg.tail * (1 - Math.max(0, facing));

    const p = this.attr.array;
    // camera-space streaks can't move at 19 km/s (they'd respawn every frame):
    // compress the visual speed with a square root, keep it monotonic
    const vis = 400 + Math.sqrt(speed) * 28;
    // seen side-on a streak is its full length on screen, head-on it's foreshortened:
    // shorten it as you look away so the side view reads as air, not scratches
    const len = vis * (0.03 + 0.04 * charge) * (1 - cfg.sideShorten * away * (1 - Math.abs(facing)));
    const ux = u.x, uy = u.y, uz = u.z, wx = w.x, wy = w.y, wz = w.z, dx = d.x, dy = d.y, dz = d.z;
    for (let i = 0, j = 0; i < this.count; i++, j += 6) {
      let s = (this.data[i * 3 + 2] -= vis * dt);
      if (s < kill) { this.respawn(i, false); s = this.data[i * 3 + 2]; }
      const a = this.data[i * 3], b = this.data[i * 3 + 1];
      const x = ux * a + wx * b + dx * s, y = uy * a + wy * b + dy * s, z = uz * a + wz * b + dz * s;
      p[j] = x; p[j + 1] = y; p[j + 2] = z;
      p[j + 3] = x + dx * len; p[j + 4] = y + dy * len; p[j + 5] = z + dz * len; // tail points upstream
    }
    this.attr.needsUpdate = true;
    const target = Math.max(0, (level - 1) / 4) * 0.55 + charge * 0.3;
    this.material.opacity += (target - this.material.opacity) * Math.min(1, dt * 4);
    this.lines.visible = this.material.opacity > 0.01;
  }
}
