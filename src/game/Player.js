// The player jet: stick model, turbulence, speed tiers, hull, terrain contact.
// Emits gameplay events through `emit(type, payload)`.
import * as THREE from 'three';
import { FLIGHT, HEALTH, COLLISION, TIERS, ALTITUDE, FLAGS, SPACE } from '../config.js';
import { airDensity } from '../space/orbit.js';
import { SpeedSystem } from './SpeedSystem.js';
import { deflect3, centrality, SPHERE } from './Collision.js';
import { mulberry32 } from '../core/rng.js';
import { NearMiss } from './NearMiss.js';

export class Player {
  constructor(emit) {
    this.emit = emit;
    this.speedSys = new SpeedSystem();
    this.pos = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.flatForward = new THREE.Vector3(0, 0, -1); // horizontal heading (enemy stations, spawns)
    this.radius = FLIGHT.playerRadius;
    this.nearMiss = new NearMiss();
    this.reset();
  }

  reset() {
    this.pos.set(0, FLIGHT.altitude, 0);
    this.prevPos.copy(this.pos);
    this.heading = 0;
    this.steer = 0;          // -1 left .. +1 right (stick position)
    this.pitch = 0;          // flight-path angle (rad), + = climbing
    this.vstick = 0;         // -1 dive .. +1 climb (Space / Shift)
    this.levelSnap = 0;      // seconds of fast auto-level after a W tap
    this.health = HEALTH.max;
    this.alive = true;
    this.invuln = 0;
    this.dropCooldown = 0;
    this.nearMiss.reset();
    this.throttle = false;
    this.braking = false;
    this.seedTurbulence((Math.random() * 1e9) | 0);
    this.scrapeCooldown = 0;
    this.traveled = 0;
    this.speedSys.reset(0);
    this.updateBasis();
  }

  seedTurbulence(seed) { this.rng = mulberry32(seed); this.gust = 0; }
  gauss() {
    const u = Math.max(1e-9, this.rng()), v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  get speed() { return this.speedSys.speed; }
  get tierDef() { return TIERS[this.speedSys.tier - 1]; }

  updateBasis() {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.forward.set(-s * cp, sp, -c * cp);
    this.flatForward.set(-s, 0, -c);
    this.right.set(c, 0, -s);
  }

  /** Altitude band: 'low' (ground effect, under radar), 'mid', 'high' (radar exposed),
   *  'space' (above the Kármán line, only with FLAGS.space). */
  get band() {
    const y = this.pos.y;
    if (FLAGS.space && y > SPACE.edge) return 'space';
    return y < ALTITUDE.groundEffect ? 'low' : y > ALTITUDE.radar ? 'high' : 'mid';
  }
  get chargeRate() {
    const b = this.band;
    return b === 'low' ? ALTITUDE.groundEffectCharge : b === 'high' ? ALTITUDE.radarCharge : b === 'space' ? SPACE.chargeRate : 1;
  }

  /** Stick model shared by both axes: ramp while held, fast return when released. */
  static stick(v, input, dt, ramp, release) {
    if (input !== 0) {
      // ramp toward the input (keys: ±1; analog sticks: anything in between); reversing is fast
      const rate = Math.sign(v) !== Math.sign(input) && v !== 0 ? 1 / release : 1 / ramp;
      v = v < input ? Math.min(input, v + rate * dt) : Math.max(input, v - rate * dt);
      return Math.max(-1, Math.min(1, v));
    }
    const d = dt / release;
    return Math.abs(v) <= d ? 0 : v - Math.sign(v) * d;
  }

  heal(n) { this.health = Math.min(HEALTH.max, this.health + n); }

  forward_events(evts) { for (const e of evts) this.emit(e.type, e); }

  /** Apply damage from any source. Damage costs hull only, never velocity. */
  takeDamage(amount, source) {
    if (!this.alive || this.invincible) return;
    this.health -= amount;
    this.emit('damage', { amount, source });
    if (this.health <= 0) {
      this.health = 0; this.alive = false;
      this.emit('death', { source });
    }
  }

  update(dt, ctl, world) {
    if (!this.alive) {
      // tumble down after death
      this.vel.y -= 30 * dt;
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y < 3) { this.pos.y = 3; this.vel.multiplyScalar(0.9); }
      return;
    }
    this.invuln -= dt; this.dropCooldown -= dt; this.scrapeCooldown -= dt;
    const sys = this.speedSys;
    const tier = this.tierDef;

    // --- sticks
    // digital keys, or an analog stick (touch) when the controller provides axes
    const input = ctl.steerAxis ?? ((ctl.right ? 1 : 0) - (ctl.left ? 1 : 0));
    const vin = ctl.pitchAxis ?? ((ctl.up ? 1 : 0) - (ctl.down ? 1 : 0));
    if (ctl.throttleTap) { this.steer = 0; this.vstick = 0; this.levelSnap = 0.6; } // W tap: snap straight & level
    this.steer = Player.stick(this.steer, input, dt, FLIGHT.steerRamp, FLIGHT.steerRelease);
    this.vstick = Player.stick(this.vstick, vin, dt, FLIGHT.pitchRamp, FLIGHT.steerRelease);
    this.levelSnap -= dt;
    if (vin !== 0) this.levelSnap = 0;
    // pitch: stick drives the flight-path angle; release and the nose auto-levels
    this.pitch += Math.sign(this.vstick) * Math.pow(Math.abs(this.vstick), FLIGHT.pitchCurve) * FLIGHT.pitchRate * dt;
    if (vin === 0) this.pitch *= Math.exp(-(this.levelSnap > 0 ? FLIGHT.levelSnap : FLIGHT.autoLevel) * dt);
    this.pitch = Math.max(-FLIGHT.maxPitch, Math.min(FLIGHT.maxPitch, this.pitch));
    // pinned against a boundary: the nose can't keep pointing into it. Otherwise
    // the flight direction (and the velocity every player-frame object rides on)
    // keeps climbing/diving while the position is clamped -> enemies drift.
    if (this.pos.y >= FLIGHT.ceiling - 0.01 && this.pitch > 0) this.pitch = 0;
    if (this.pos.y <= FLIGHT.minAltitude + 0.01 && this.pitch < 0) this.pitch = 0;
    // curved response: short taps trim fractions of a degree, holds are hard turns
    const yawRate = -Math.sign(this.steer) * Math.pow(Math.abs(this.steer), FLIGHT.steerCurve) * tier.yawRate;

    // --- turbulence: gusts as an Ornstein-Uhlenbeck yaw-rate process (no
    // predictable calm spots), std = tier.turbulence rad/s; you must trim it
    const tau = FLIGHT.gustTau;
    const g = this.gauss();
    this.gust += (-this.gust / tau) * dt + Math.sqrt((2 * dt) / tau) * g;
    // thinner air, weaker gusts: in vacuum only a little 'solar wind' is left
    const air = FLAGS.space ? SPACE.turbulence + (1 - SPACE.turbulence) * airDensity(this.pos.y) : 1;
    const turbRate = sys.engaged ? this.gust * tier.turbulence * (1 + 0.5 * sys.charge) * air : 0;

    this.heading += (yawRate + turbRate) * dt;
    this.throttle = ctl.throttle;
    this.braking = ctl.brake;

    const evts = sys.update(dt, { heading: this.heading, pitch: this.pitch, throttle: ctl.throttle, brake: ctl.brake, chargeRate: this.chargeRate });
    this.forward_events(evts);
    this.updateBasis();

    // --- move with substeps + terrain contact
    this.prevPos.copy(this.pos);
    const dist = sys.speed * dt;
    const steps = Math.max(1, Math.ceil(dist / 20)); // 20 m: thinner than any scaled obstacle
    const h = dist / steps;
    const ox = world.origin.x, oz = world.origin.z;
    for (let i = 0; i < steps; i++) {
      this.pos.addScaledVector(this.forward, h);
      if (this.pos.y > FLIGHT.ceiling) {
        if (this.pos.y > FLIGHT.ceiling + 0.5 && !this.atCeiling) this.emit('ceiling', {});
        this.atCeiling = true;
        this.pos.y = FLIGHT.ceiling;
      } else if (this.pos.y < FLIGHT.ceiling - 20) this.atCeiling = false;
      if (this.pos.y < FLIGHT.minAltitude) {
        this.resolveContact({ nx: 0, ny: 1, nz: 0, depth: 0, ground: FLIGHT.minAltitude - this.pos.y, collider: { tag: 'ground' } });
        if (!this.alive) break;
      }
      const hit = world.collide(this.pos.x + ox, this.pos.y, this.pos.z + oz, this.radius);
      if (hit) { this.resolveContact(hit); if (!this.alive) break; }
    }
    this.traveled += dist;
    this.vel.copy(this.forward).multiplyScalar(sys.speed);
    // never report vertical motion into a boundary we're pressed against
    if (this.pos.y >= FLIGHT.ceiling - 0.01 && this.vel.y > 0) this.vel.y = 0;
    if (this.pos.y <= FLIGHT.minAltitude + 0.01 && this.vel.y < 0) this.vel.y = 0;

    // near misses: obstacles passed close without contact charge the barrier
    if (world.forEachNear && sys.engaged) {
      const ax = this.pos.x + ox, az = this.pos.z + oz;
      const misses = this.nearMiss.update(ax, this.pos.y, az, this.flatForward.x, this.flatForward.z, sys.speed,
        (fn) => world.forEachNear(ax, az, (c) => { for (const col of c.colliders) fn(col); }));
      for (const m of misses) this.emit('nearMiss', m);
    }

    // gates / triggers
    const crossed = world.crossedTriggers(this.prevPos.x + ox, this.prevPos.z + oz, this.pos.x + ox, this.pos.z + oz, [], this.pos.y, this.prevPos.y);
    for (const tr of crossed) this.emit('trigger', tr);
  }

  /** Set heading + pitch from a 3D unit direction. */
  setDirection(dx, dy, dz) {
    this.heading = Math.atan2(-dx, -dz);
    this.pitch = Math.max(-FLIGHT.maxPitch, Math.min(FLIGHT.maxPitch, Math.asin(Math.max(-1, Math.min(1, dy)))));
    this.updateBasis();
  }

  resolveContact(hit) {
    const { nx, ny, nz, depth } = hit;
    const isGround = hit.collider.tag === 'ground';
    if (!isGround) this.nearMiss.touch(hit.collider);
    // push out of the obstacle
    if (isGround) this.pos.y += hit.ground;
    else if (hit.collider.kind === SPHERE) {
      // floating obstacle: out along the full 3D normal (over, under or around it)
      this.pos.x += nx * (depth + 0.5); this.pos.y += ny * (depth + 0.5); this.pos.z += nz * (depth + 0.5);
    } else {
      // depth is horizontal penetration: push out along the horizontal normal
      const hl = Math.hypot(nx, nz) || 1;
      this.pos.x += (nx / hl) * (depth + 0.5); this.pos.z += (nz / hl) * (depth + 0.5);
    }
    const f = this.forward;
    const c = centrality(f.x, f.z, nx, nz, f.y, ny);
    const hard = c >= (isGround ? ALTITUDE.groundHardThreshold : COLLISION.centerThreshold);
    if (hard && this.invuln <= 0) {
      this.invuln = COLLISION.invuln;
      const [dx, dy, dz] = deflect3(f.x, f.y, f.z, nx, ny, nz, 1);
      this.setDirection(dx, isGround ? Math.max(0.05, dy) : dy, dz);
      const dmg = (COLLISION.hardDamageBase + COLLISION.hardDamagePerTier * this.speedSys.level) * (0.6 + 0.4 * c);
      this.speedSys.knock(COLLISION.hardSpeedKeep);
      this.emit('impact', { hard: true, damage: dmg, tag: hit.collider.tag });
      // a head-on crash costs a tier (your mistake, not an attack)
      if (COLLISION.tierLossOnHeadOn && this.dropCooldown <= 0) { this.dropCooldown = HEALTH.tierDropCooldown; this.forward_events(this.speedSys.drop('impact')); }
      this.takeDamage(dmg, 'impact');
    } else {
      // glancing: slide along the surface (over a flank, along the floor)
      const [dx, dy, dz] = deflect3(f.x, f.y, f.z, nx, ny, nz);
      // floor: level out onto it (no bounce -> no porpoising while holding dive)
      this.setDirection(dx, isGround ? 0 : dy, dz);
      this.speedSys.knock(0.995);
      if (this.scrapeCooldown <= 0) { this.scrapeCooldown = 0.25; this.emit('impact', { hard: false, damage: 0, tag: hit.collider.tag }); }
    }
  }
}
