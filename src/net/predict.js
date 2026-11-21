// Remote jets: dead reckoning with error blending (pure, unit-tested).
//
// Why not interpolation: buffering 100 ms of snapshots and interpolating
// shows a teammate where they were 100 ms ago = 1.9 km behind at Mach 100.
// Flight here is smooth and its inputs are known (velocity, turn rates), so
// each frame we PREDICT where the jet is now from its newest snapshot:
//   position: velocity integrated along the arc of the current turn
//   heading / pitch: current rates
// When a new snapshot arrives, the jump between the old and the new
// prediction becomes an error offset that decays over `tau`
// ("projective velocity blending"): no pops, converges in ~2 tau.
import { SQUAD } from '../config.js';

export class RemoteTrack {
  constructor(cfg = SQUAD.predict) {
    this.cfg = cfg;
    this.s = null;                          // newest snapshot (copy)
    this.ex = 0; this.ey = 0; this.ez = 0;  // error offset being blended out
    this.eh = 0; this.ep = 0;
    this.out = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
    this.lastSeq = -1;
    this.stats = { samples: 0, dropped: 0, lastError: 0 };
  }
  get has() { return !!this.s; }

  /** pure prediction of the snapshot `s` at server time `t` */
  static predict(s, t, maxExtrap, out) {
    const dt = Math.max(0, Math.min(maxExtrap, t - s.t));
    const w = s.yawRate, q = s.pitchRate;
    // horizontal velocity rotates about +Y at the yaw rate: integrate the arc exactly
    let S1 = dt, S2 = 0;
    if (Math.abs(w) > 1e-6) { S1 = Math.sin(w * dt) / w; S2 = (1 - Math.cos(w * dt)) / w; }
    out.x = s.x + s.vx * S1 + s.vz * S2;
    out.z = s.z - s.vx * S2 + s.vz * S1;
    // vertical: climb rate follows the pitch rate (first order)
    out.y = s.y + s.vy * dt + 0.5 * s.speed * Math.cos(s.pitch) * q * dt * dt;
    out.heading = s.heading + w * dt;
    out.pitch = s.pitch + q * dt;
    return out;
  }

  /** new snapshot. `now` = current server time (what was being rendered) */
  push(s, now) {
    if (this.s && ((s.seq - this.s.seq) & 0xffff) > 0x8000) { this.stats.dropped++; return false; } // stale / reordered
    const a = this.s ? RemoteTrack.predict(this.s, now, this.cfg.maxExtrap, {}) : null;
    this.s = Object.assign(this.s || {}, s);
    this.stats.samples++;
    if (a) {
      const b = RemoteTrack.predict(this.s, now, this.cfg.maxExtrap, {});
      this.ex += a.x - b.x; this.ey += a.y - b.y; this.ez += a.z - b.z;
      this.eh += angle(a.heading - b.heading); this.ep += a.pitch - b.pitch;
      this.stats.lastError = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (Math.hypot(this.ex, this.ey, this.ez) > this.cfg.snap) this.ex = this.ey = this.ez = this.eh = this.ep = 0; // respawn / teleport
    }
    return true;
  }

  /** render pose at server time `now`; dt = real frame time (blends the error out) */
  update(now, dt) {
    const o = this.out;
    if (!this.s) return o;
    RemoteTrack.predict(this.s, now, this.cfg.maxExtrap, o);
    const k = Math.exp(-dt / this.cfg.tau);
    this.ex *= k; this.ey *= k; this.ez *= k; this.eh *= k; this.ep *= k;
    o.x += this.ex; o.y += this.ey; o.z += this.ez; o.heading += this.eh; o.pitch += this.ep;
    return o;
  }
}

const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
