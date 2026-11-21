// Pure speed-tier state machine. No three.js, no DOM: fully unit-testable.
//
// Rules:
//  * To climb from tier n to n+1 you hold W while your flight direction (yaw
//    AND pitch) stays within TIERS[n].tolerance degrees of a reference line. The barrier "charge"
//    fills over TIERS[n].hold seconds. Leave the window and the reference
//    snaps to your new heading while charge bleeds away fast.
//  * Holding S drains charge, then drops one tier per brakeDropTime seconds.
//  * The first barrier (tier II) charges on its own after launch (autoFirstBarrier).
//  * Nothing caps the top tier: damage never takes velocity away.

import { TIERS, SPEED, DEG, tierLevel } from '../config.js';

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export class SpeedSystem {
  constructor(tiers = TIERS, cfg = SPEED) {
    this.tiers = tiers;
    this.cfg = cfg;
    this.reset(0);
  }

  reset(heading = 0) {
    this.tier = 1;
    this.charge = 0;
    this.refHeading = heading;
    this.refPitch = 0;
    this.deviation = 0;       // signed yaw deviation (rad)
    this.deviationPitch = 0;  // signed pitch deviation (rad)
    this.deviationMag = 0;    // combined angular deviation (rad)
    this.inWindow = true;
    this.brakeTimer = 0;
    this.speed = this.tiers[0].speed;
    this.targetSpeed = this.speed;
    this.maxTierReached = 1;
    this.engaged = false; // W must be pressed once to launch
  }

  get maxTier() { return this.tiers.length; }
  get current() { return this.tiers[this.tier - 1]; }
  /** Feel intensity on the original 1..5 scale (see tierLevel). */
  get level() { return tierLevel(this.tier); }
  /** Tier the player is charging toward, or null at the top. */
  get next() { return this.tier < this.maxTier ? this.tiers[this.tier] : null; }
  /** Tolerance (radians) of the active window. */
  get tolerance() { const n = this.next; return n ? n.tolerance * DEG : this.current.tolerance === Infinity ? 12 * DEG : this.current.tolerance * DEG; }

  /** Force a one-tier drop (head-on terrain crash). Co-op: the squad decides (the request is sent). */
  drop(reason = 'damage') {
    if (this.follow) { this.dropRequested = true; return []; }
    if (this.tier <= 1) { this.charge = 0; return []; }
    this.tier--;
    this.charge = 0;
    return [{ type: 'tierDown', tier: this.tier, reason }];
  }

  /** Multiply current speed instantly (impacts). It recovers toward target. */
  knock(fraction) { this.speed *= fraction; }

  update(dt, inputs) {
    if (this.follow) return this.updateFollow(dt, inputs);
    return this.updateSolo(dt, inputs);
  }

  /**
   * Co-op: the squad owns the barrier (server/room.js -> SquadBarrier). `follow`
   * = { tier, charge, refHeading, refPitch } from the latest squad state. We
   * still judge OUR line against the squad's reference (HUD ring, window) and
   * fly our own speed (brake, knocks), but tiers and charge come from the squad.
   */
  updateFollow(dt, { heading, pitch = 0, throttle, brake }) {
    const events = [];
    if (!this.engaged) {
      if (throttle) { this.engaged = true; events.push({ type: 'launch' }); }
      else { this.speed = 0; this.targetSpeed = 0; return events; }
    }
    const f = this.follow, cfg = this.cfg;
    if (f.tier !== this.tier) {
      const up = f.tier > this.tier;
      this.tier = Math.max(1, Math.min(this.maxTier, f.tier));
      this.maxTierReached = Math.max(this.maxTierReached, this.tier);
      events.push({ type: up ? 'tierUp' : 'tierDown', tier: this.tier, reason: f.reason || 'squad' });
    }
    this.refHeading = f.refHeading; this.refPitch = f.refPitch;
    this.deviation = angleDiff(heading, this.refHeading);
    this.deviationPitch = pitch - this.refPitch;
    this.deviationMag = Math.hypot(this.deviation * Math.cos(pitch), this.deviationPitch);
    this.inWindow = this.deviationMag <= this.tolerance;
    this.charge = this.next ? Math.max(0, Math.min(1, f.charge)) : 0;
    const base = this.current.speed;
    this.targetSpeed = base * (1 + cfg.chargeOverspeed * this.charge) * (brake ? 1 - cfg.brakeSpeedCut : 1);
    const rate = this.targetSpeed > this.speed ? cfg.accel : cfg.decel;
    this.speed += (this.targetSpeed - this.speed) * (1 - Math.exp(-rate * dt));
    return events;
  }

  updateSolo(dt, { heading, pitch = 0, throttle, brake, chargeRate = 1 }) {
    const events = [];
    if (!this.engaged) {
      if (throttle) { this.engaged = true; events.push({ type: 'launch' }); }
      else { this.speed = 0; this.targetSpeed = 0; this.refHeading = heading; this.refPitch = pitch; return events; }
    }
    const cfg = this.cfg;
    const next = this.next;
    const tol = this.tolerance;

    this.deviation = angleDiff(heading, this.refHeading);
    this.deviationPitch = pitch - this.refPitch;
    this.deviationMag = Math.hypot(this.deviation * Math.cos(pitch), this.deviationPitch);
    this.inWindow = this.deviationMag <= tol;
    // Out of the window: the charge bleeds; you can still steer back onto the
    // line and save it. Once it is empty the line restarts from where you are.
    if (!this.inWindow && this.charge <= 0) { this.refHeading = heading; this.refPitch = pitch; }

    if (brake) {
      if (this.charge > 0) this.charge = Math.max(0, this.charge - cfg.brakeDrain * dt);
      else {
        this.brakeTimer += dt;
        if (this.brakeTimer >= cfg.brakeDropTime && this.tier > 1) {
          this.brakeTimer = 0;
          this.tier--;
          events.push({ type: 'tierDown', tier: this.tier, reason: 'brake' });
        }
      }
    } else {
      this.brakeTimer = 0;
      const autoFirst = cfg.autoFirstBarrier && this.tier === 1;
      if (next && (throttle || autoFirst) && this.inWindow) {
        this.charge += (dt / next.hold) * chargeRate;
        if (this.charge >= 1) {
          this.tier++;
          this.charge = 0;
          this.refHeading = heading;
          this.refPitch = pitch;
          this.maxTierReached = Math.max(this.maxTierReached, this.tier);
          events.push({ type: 'tierUp', tier: this.tier });
        }
      } else if (!this.inWindow) {
        this.charge = Math.max(0, this.charge - (next?.missDecay ?? cfg.chargeDecayMiss) * dt);
      } else {
        this.charge = Math.max(0, this.charge - cfg.chargeDecayIdle * dt);
      }
    }
    if (!this.next) this.charge = 0;

    const base = this.current.speed;
    this.targetSpeed = base * (1 + cfg.chargeOverspeed * this.charge) * (brake ? 1 - cfg.brakeSpeedCut : 1);
    const rate = this.targetSpeed > this.speed ? cfg.accel : cfg.decel;
    this.speed += (this.targetSpeed - this.speed) * (1 - Math.exp(-rate * dt));
    return events;
  }
}
