// Autopilot: probes headings for clear air, holds the line to climb tiers,
// trims turbulence with micro-taps and shoots whatever it locks.
// Used for the attract mode behind the menu and for automated playtests.
import { DEG, FLIGHT, WORLD_SCALE } from '../config.js';

const PROBES = [0, 5, -5, 10, -10, 18, -18, 28, -28, 42, -42, 60, -60];

export class Autopilot {
  constructor(game) { this.game = game; this.cruise = FLIGHT.altitude; this.commit = 0; this.commitDir = 0; this.missileT = 3; this.tapW = true; }
  control(dt) {
    const g = this.game, p = g.player, s = p.speedSys, w = g.world;
    const ox = w.origin.x, oz = w.origin.z;
    const ax = p.pos.x + ox, az = p.pos.z + oz;
    const look = Math.max(900, Math.min(4200 * WORLD_SCALE, s.speed * 4));
    const clear = (offDeg) => {
      const h = p.heading - offDeg * DEG; // positive offset = right
      return w.raycast(ax, p.pos.y, az, -Math.sin(h), -Math.cos(h), look, p.radius + 26, p.radius + 3);
    };
    const ctl = { left: false, right: false, throttle: true, throttleTap: false, brake: false, gun: false, missiles: false };
    if (this.tapW) { ctl.throttleTap = true; this.tapW = false; }
    const ahead = clear(0);
    this.commit -= dt;
    if (ahead < look) {
      // score each side; commit to one escape side until the path clears
      let bestL = 0, bestR = 0;
      for (const o of PROBES) {
        if (o === 0) continue;
        const sc = Math.min(clear(o), look) - Math.abs(o) * 5;
        if (o > 0) bestR = Math.max(bestR, sc); else bestL = Math.max(bestL, sc);
      }
      const pick = bestR >= bestL ? 1 : -1;
      if (this.commit <= 0 || this.commitDir === 0) this.commitDir = pick;
      else if (pick !== this.commitDir && Math.max(bestL, bestR) > Math.min(bestL, bestR) + 900) this.commitDir = pick;
      this.commit = 0.4;
      if (ahead < s.speed * 1.2 && s.tier > 1) ctl.brake = true;
    }
    if (this.commit > 0) {
      if (this.commitDir > 0) ctl.right = true; else ctl.left = true;
      ctl.throttle = !ctl.brake;
      if (ahead >= look) this.commit = Math.min(this.commit, 0.08);
    } else {
      // seek repair beacons when hurt
      const pk = g.pickups.list[0];
      if (pk && p.health < 70) {
        const dx = pk.pos.x - p.pos.x, dz = pk.pos.z - p.pos.z;
        const side = dx * p.right.x + dz * p.right.z;
        if (Math.abs(side) > 10) { if (side > 0) ctl.right = true; else ctl.left = true; }
      } else {
        // trim: hold the reference line with micro-taps
        const dev = s.deviation, tol = s.tolerance;
        if (Math.abs(dev) > tol * 0.25 && Math.abs(p.steer) < 0.15) {
          if (dev > 0) ctl.right = true; else ctl.left = true;
        }
      }
    }
    // hold cruise altitude: aim for a climb angle proportional to the error,
    // scaled by speed so it doesn't overshoot into the floor at Mach 5
    const targetPitch = Math.max(-0.06, Math.min(0.06, (this.cruise - p.pos.y) / Math.max(150, s.speed * 1.2)));
    if (p.pitch < targetPitch - 0.004) ctl.up = true;
    else if (p.pitch > targetPitch + 0.004) ctl.down = true;
    ctl.gun = !!g.weapons.primary && g.weapons.heat < 0.85;
    this.missileT -= dt;
    if (this.missileT <= 0 && g.weapons.locks.length && g.weapons.missiles >= 4) { ctl.missiles = true; this.missileT = 2.5 + Math.random() * 3; }
    return ctl;
  }
}
