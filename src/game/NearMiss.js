// Near misses: an obstacle you pass close to without touching charges the
// barrier. Pure (no three.js): unit-tested. Clearance is measured from the hull
// to the collider's surface at your altitude, tracked while the obstacle is
// ahead or abreast, and judged once it falls behind.
import { CIRCLE, radiusAt } from './Collision.js';
import { NEAR_MISS, FLIGHT } from '../config.js';

/** Near-miss window (m of clearance) at a given speed: constant reaction time. */
export function nearMissThreshold(speed) { return NEAR_MISS.base + NEAR_MISS.perSpeed * speed; }

/** Hull-to-surface clearance (m) at height y, or Infinity when the obstacle isn't at that height. */
export function clearance(c, px, py, pz, pr = FLIGHT.playerRadius) {
  const yc = Math.min(c.top, Math.max(c.bottom, py));
  if (py > c.top + pr || py < c.bottom - pr) return Infinity;
  const r = radiusAt(c, yc);
  if (r <= 0) return Infinity;
  let qx, qz;
  if (c.kind === CIRCLE) { qx = c.x; qz = c.z; }
  else {
    const dx = c.bx - c.ax, dz = c.bz - c.az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((px - c.ax) * dx + (pz - c.az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    qx = c.ax + dx * t; qz = c.az + dz * t;
  }
  return Math.max(0, Math.hypot(px - qx, pz - qz) - r - pr);
}

export class NearMiss {
  constructor() { this.track = new Map(); this.touched = new WeakSet(); }
  reset() { this.track.clear(); this.touched = new WeakSet(); }
  /** Mark a collider as hit: it can't be a near miss. */
  touch(c) { this.touched.add(c); }

  /**
   * @param each (fn) => calls fn(collider) for every collider near the player
   * @returns near-miss events for obstacles that just fell behind: {clearance, closeness, x, z, tag}
   */
  update(px, py, pz, fx, fz, speed, each) {
    const th = nearMissThreshold(speed);
    const out = [];
    const seen = new Set();
    each((c) => {
      const ahead = (c.x - px) * fx + (c.z - pz) * fz;
      let rec = this.track.get(c);
      if (!rec) {
        if (ahead <= 0) return;                    // only judge obstacles you approach
        const cl = clearance(c, px, py, pz);
        if (cl > th * 3) return;                   // not in play
        rec = { min: cl, done: false };
        this.track.set(c, rec);
      }
      seen.add(c);
      if (rec.done) return;
      rec.min = Math.min(rec.min, clearance(c, px, py, pz));
      if (ahead < 0) {                             // passed it
        rec.done = true;
        if (rec.min < th && !this.touched.has(c)) {
          out.push({ clearance: rec.min, closeness: 1 - rec.min / th, x: c.x, z: c.z, tag: c.tag });
        }
      }
    });
    for (const c of this.track.keys()) if (!seen.has(c)) this.track.delete(c);
    return out;
  }
}
