// Collider primitives: vertical shapes whose horizontal cross-section can vary
// with height. Features build any shape out of circles (rocks, peaks: with a
// radius-at-height profile) and capsules (walls, pillars, beams). Contacts
// return a 3D surface normal so the jet can slide over a mountain's flank.
// Pure math, unit-testable.

import { COLLISION } from '../config.js';

export const CIRCLE = 0;
export const CAPSULE = 1;

/**
 * @param rAt optional (y) => cross-section radius at height y (surface of
 *            revolution). When given, `r` is the maximum radius (broad phase).
 */
export function circle(x, z, r, top = Infinity, bottom = -Infinity, tag = 'rock', rAt = null) {
  return { kind: CIRCLE, x, z, r, top, bottom, tag, rAt };
}

export function capsule(ax, az, bx, bz, r, top = Infinity, bottom = -Infinity, tag = 'wall') {
  return { kind: CAPSULE, ax, az, bx, bz, r, top, bottom, tag,
    // bounding circle for broad phase
    x: (ax + bx) / 2, z: (az + bz) / 2, br: Math.hypot(bx - ax, bz - az) / 2 + r };
}

/** Cross-section radius of a collider at height y (0 = nothing there). */
export function radiusAt(c, y) {
  if (y > c.top || y < c.bottom) return 0;
  return c.rAt ? c.rAt(y) : c.r;
}

/**
 * Returns contact {nx, ny, nz, depth} (normal points from obstacle to player,
 * `depth` is horizontal penetration) or null.
 */
export function contact(c, px, py, pz, pr) {
  if (py > c.top + pr || py < c.bottom - pr) return null;
  let qx, qz;
  if (c.kind === CIRCLE) { qx = c.x; qz = c.z; }
  else {
    const dx = c.bx - c.ax, dz = c.bz - c.az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((px - c.ax) * dx + (pz - c.az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    qx = c.ax + dx * t; qz = c.az + dz * t;
  }
  const ox = px - qx, oz = pz - qz;
  const d = Math.hypot(ox, oz);
  const yc = Math.min(c.top, Math.max(c.bottom, py));
  const r = c.rAt ? c.rAt(yc) : c.r;
  if (r <= 0) return null;
  const rr = r + pr;
  if (d >= rr) return null;
  let hx = d > 1e-6 ? ox / d : 1, hz = d > 1e-6 ? oz / d : 0, ny = 0;
  if (c.rAt) {
    // surface of revolution: normal ∝ (radial, -dr/dy)
    const e = 2;
    const drdy = (c.rAt(Math.min(c.top, yc + e)) - c.rAt(Math.max(c.bottom, yc - e))) / (2 * e);
    ny = -drdy;
  } else if (py > c.top) ny = 1; // brushing the top of a flat-topped wall/beam
  const nl = Math.hypot(1, ny);
  return { nx: hx / nl, ny: ny / nl, nz: hz / nl, depth: rr - d, collider: c };
}

/**
 * How head-on the impact is: 1 = flying straight into the surface,
 * 0 = grazing along it. Accepts 2D (fx, fz, nx, nz) or 3D vectors.
 */
export function centrality(fx, fz, nx, nz, fy = 0, ny = 0) {
  return Math.max(0, -(fx * nx + fy * ny + fz * nz));
}

export function isHardHit(fx, fz, nx, nz, threshold = COLLISION.centerThreshold, fy = 0, ny = 0) {
  return centrality(fx, fz, nx, nz, fy, ny) >= threshold;
}

/**
 * Deflect a forward vector along the surface tangent (the side the player was
 * already heading toward). 2D: deflect(fx, fz, nx, nz, s) → [fx, fz].
 */
export function deflect(fx, fz, nx, nz, strength = COLLISION.edgeDeflect) {
  const [x, , z] = deflect3(fx, 0, fz, nx, 0, nz, strength);
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

/** 3D deflection: slide along the surface, slightly pushed outward. */
export function deflect3(fx, fy, fz, nx, ny, nz, strength = COLLISION.edgeDeflect) {
  const dot = fx * nx + fy * ny + fz * nz;
  if (dot >= 0) return [fx, fy, fz];
  let tx = fx - nx * dot, ty = fy - ny * dot, tz = fz - nz * dot;
  let tl = Math.hypot(tx, ty, tz);
  if (tl < 1e-4) { // dead center: pick a side
    const hl = Math.hypot(nx, nz) || 1;
    tx = -nz / hl; ty = 0; tz = nx / hl; tl = 1;
  }
  tx /= tl; ty /= tl; tz /= tl;
  const rx = fx + (tx - fx) * strength + nx * 0.08;
  const ry = fy + (ty - fy) * strength + ny * 0.08;
  const rz = fz + (tz - fz) * strength + nz * 0.08;
  const rl = Math.hypot(rx, ry, rz) || 1;
  return [rx / rl, ry / rl, rz / rl];
}
