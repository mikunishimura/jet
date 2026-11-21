// Player armament + target acquisition ("detection system").
//   J / LMB : minigun. Fires along the CROSSHAIR (mouse aim): both guns
//             converge on the crosshair ray. Aim assist leads a target only
//             when it is within AIM.assistCone of the crosshair.
//   K / RMB : salvo of homing missiles spread over up to 4 locks near the
//             crosshair; with no lock they fly straight down the crosshair.
import * as THREE from 'three';
import { WEAPONS, AIM } from '../config.js';
import { HARDPOINTS } from '../render/JetModel.js';

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class Weapons {
  constructor(game) {
    this.game = game;
    this.reset();
  }
  reset() {
    this.heat = 0;
    this.overheated = 0;
    this.gunCooldown = 0;
    this.missiles = WEAPONS.missiles.max;
    this.reload = 0;
    this.salvoQueue = [];
    this.salvoTimer = 0;
    this.locks = [];       // enemies inside the lock cone, best first
    this.detected = [];    // every tracked enemy
    this.primary = null;
    this.assisted = false;  // gun is leading the primary (crosshair close enough)
    this.firing = false;
    this.muzzleSide = 0;
  }

  /** Where the crosshair points (world unit vector) and a point far down that ray. */
  aimDir() { return this.game.rig?.aimDir || this.game.player.forward; }
  aimPoint(out) {
    const g = this.game, p = g.player, off = g.rig?.aimOffset;
    out.copy(p.pos);
    if (off) out.add(off);
    return out.addScaledVector(this.aimDir(), AIM.convergence);
  }

  /** Rank enemies: angle from the CROSSHAIR weighted by distance. */
  acquire() {
    const g = this.game, p = g.player;
    const f = this.aimDir();
    this.detected.length = 0; this.locks.length = 0;
    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      _v.subVectors(e.pos, p.pos);
      const d = _v.length();
      if (d > 6000) continue;
      this.detected.push(e);
      const ang = Math.acos(Math.max(-1, Math.min(1, _v.dot(f) / (d || 1))));
      e.lockAngle = ang; e.dist = d;
      if (ang < WEAPONS.lockCone && d < WEAPONS.lockRange) this.locks.push(e);
    }
    this.locks.sort((a, b) => (a.lockAngle + a.dist / 8000) - (b.lockAngle + b.dist / 8000));
    // sticky primary: keep the current target unless it leaves the cone
    if (!this.primary || !this.primary.alive || !this.locks.includes(this.primary)) this.primary = this.locks[0] || null;
    else if (this.locks[0] && this.locks[0] !== this.primary && this.locks[0].lockAngle < this.primary.lockAngle * 0.4) this.primary = this.locks[0];
    this.assisted = !!this.primary && this.primary.lockAngle < AIM.assistCone;
  }

  retarget(missile) {
    return this.locks.find((e) => e.alive) || null;
  }

  /** muzzle on the actual airframe: side -1 = left, +1 = right */
  muzzle(side, kind = 'gun') {
    const hp = HARDPOINTS[kind][side < 0 ? 0 : 1];
    return this.game.jet.hardpoint(hp, this.game.player, new THREE.Vector3());
  }

  update(dt, ctl) {
    const g = this.game, p = g.player;
    this.acquire();
    if (!p.alive) return;
    const W = WEAPONS.minigun;
    // --- minigun
    if (this.overheated > 0) this.overheated -= dt;
    this.gunCooldown -= dt;
    this.firing = ctl.gun && this.overheated <= 0;
    // barrels only cool when you let go of the trigger
    this.sinceFire = this.firing ? 0 : (this.sinceFire || 0) + dt;
    if (this.sinceFire > W.coolDelay) this.heat = Math.max(0, this.heat - W.cool * dt * (this.overheated > 0 ? 1.6 : 1));
    if (this.firing) {
      while (this.gunCooldown <= 0) {
        this.gunCooldown += 1 / W.rate;
        this.fireBullet();
        this.heat += W.heatPerShot;
        if (this.heat >= 1) { this.heat = 1; this.overheated = W.overheatLock; g.audio.overheat(); g.hud.toast('GUN OVERHEAT', 'warn'); break; }
      }
    } else this.gunCooldown = Math.max(this.gunCooldown, 0);

    // --- missiles
    const M = WEAPONS.missiles;
    if (this.missiles < M.max) {
      this.reload += dt;
      if (this.reload >= M.reload) { this.reload = 0; this.missiles++; }
    }
    if (ctl.missiles) {
      if (this.missiles <= 0) { g.audio.click(); }
      else {
        const n = Math.min(M.salvo, this.missiles);
        for (let i = 0; i < n; i++) this.salvoQueue.push(this.locks.length ? this.locks[i % this.locks.length] : null);
        this.missiles -= n;
      }
    }
    if (this.salvoQueue.length) {
      this.salvoTimer -= dt;
      if (this.salvoTimer <= 0) {
        this.salvoTimer = M.stagger;
        this.fireMissile(this.salvoQueue.shift());
      }
    }
  }

  fireBullet() {
    const g = this.game, p = g.player, W = WEAPONS.minigun;
    this.muzzleSide = this.muzzleSide === 1 ? -1 : 1;
    const origin = this.muzzle(this.muzzleSide);
    const t = this.assisted ? this.primary : null;
    if (t) {
      // solve intercept: |T + Vt*τ - O - Vp*τ| = s*τ in the player's frame
      const rel = _v.subVectors(t.pos, origin);
      const rv = _a.subVectors(t.vel, p.vel);
      const s = W.speed;
      const A = rv.dot(rv) - s * s, B = 2 * rel.dot(rv), C = rel.dot(rel);
      let tau = rel.length() / s;
      const disc = B * B - 4 * A * C;
      if (Math.abs(A) > 1e-6 && disc >= 0) {
        const r1 = (-B - Math.sqrt(disc)) / (2 * A), r2 = (-B + Math.sqrt(disc)) / (2 * A);
        const cand = [r1, r2].filter((x) => x > 0);
        if (cand.length) tau = Math.min(...cand);
      }
      _dir.copy(rel).addScaledVector(rv, tau).normalize();
    } else {
      // no assist: converge on the crosshair ray
      _dir.copy(this.aimPoint(_v)).sub(origin).normalize();
    }
    _dir.x += (Math.random() - 0.5) * W.spread * 2; _dir.y += (Math.random() - 0.5) * W.spread * 2; _dir.z += (Math.random() - 0.5) * W.spread * 2;
    _dir.normalize();
    const vel = _dir.clone().multiplyScalar(W.speed).add(p.vel);
    g.projectiles.bullet('player', origin, vel, W.damage, 0x2a2d31, W.range / W.speed);
    g.audio.gunshot();
    // muzzle flash
    g.particles.normal.emit({ x: origin.x, y: origin.y, z: origin.z, rel: true, life: 0.05, size: 2.4, color: 0x15171a, shape: 1 });
  }

  fireMissile(target) {
    const g = this.game, p = g.player, M = WEAPONS.missiles;
    this.muzzleSide = this.muzzleSide === 1 ? -1 : 1;
    const origin = this.muzzle(this.muzzleSide, 'rail');
    // launched down the crosshair (plus a little side ejection), relative to the jet
    const vel = this.aimDir().clone().multiplyScalar(60).add(p.vel)
      .addScaledVector(p.right, this.muzzleSide * 55).add(_v.set(0, -10, 0));
    g.projectiles.missile('player', origin, vel, target, {
      relSpeed: M.speed, accel: M.accel, turnRate: M.turnRate, damage: M.damage, splash: M.splash,
      prox: 14, life: M.life, armDelay: 0.18, dir: this.aimDir().clone(),
    });
    g.audio.missileLaunch();
  }
}
