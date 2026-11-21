// Player armament + target acquisition ("detection system").
//   J / LMB : minigun. Heavy rounds at a steady cadence along the CROSSHAIR
//             (mouse aim): both guns converge on the crosshair ray. Aim assist
//             leads a target only when it is within AIM.assistCone of the
//             crosshair. Overheat clears fast.
//   K / RMB : missiles, HOLD then RELEASE. While held, keep the crosshair on
//             an enemy (within WEAPONS.lock.margin of it) and a ring charges
//             around it over WEAPONS.lock.time; then move on to the next one.
//             Release fires one hypersonic "kill" missile per locked target
//             (a lock guarantees the kill, almost instantly); with nothing
//             locked a regular pair flies straight down the crosshair.
import * as THREE from 'three';
import { WEAPONS, AIM } from '../config.js';

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Pure lock-on step (unit-tested). One target charges at a time: the one the
 * crosshair is closest to, inside the margin. Others keep their progress for
 * `grace` seconds, then drain. Locked targets stay locked.
 * @param locks Map(enemy -> { p: 0..1, out: s off the crosshair, locked })
 * @param cands [{ e, err }] err = crosshair error beyond the target's own angular size (rad)
 * @param capacity how many targets may be locked in total (missiles left)
 * @returns events [{ type: 'locked' | 'tracking', e, p }]
 */
export function stepLocks(locks, cands, dt, capacity, cfg = WEAPONS.lock) {
  const events = [];
  let nLocked = 0;
  for (const s of locks.values()) if (s.locked) nLocked++;
  let tracked = null, best = cfg.margin;
  if (nLocked < Math.min(capacity, cfg.maxTargets)) {
    // sticky: the target you are already tracking stays tracked while it is inside the margin
    const prev = locks.tracked, pc = prev && cands.find((c) => c.e === prev);
    if (pc && pc.err <= cfg.margin && !locks.get(prev)?.locked) tracked = prev;
    else {
      for (const c of cands) {
        if (c.err > best || locks.get(c.e)?.locked) continue;
        best = c.err; tracked = c.e;
      }
    }
  }
  locks.tracked = tracked;
  if (tracked && !locks.has(tracked)) locks.set(tracked, { p: 0, out: 0, locked: false });
  for (const [e, s] of locks) {
    if (s.locked) continue;
    if (e === tracked) {
      s.out = 0;
      s.p = Math.min(1, s.p + dt / cfg.time);
      if (s.p >= 1) { s.locked = true; events.push({ type: 'locked', e, p: 1 }); }
      else events.push({ type: 'tracking', e, p: s.p });
    } else {
      s.out += dt;
      if (s.out > cfg.grace) s.p -= cfg.drain * dt;
      if (s.p <= 0) locks.delete(e);
    }
  }
  return events;
}

/** lock ring fill as drawn: slow at first, rushing at the end (display only) */
export const lockDisplay = (p, k = WEAPONS.lock.displayK) => (Math.exp(k * Math.max(0, Math.min(1, p))) - 1) / (Math.exp(k) - 1);

export class Weapons {
  constructor(game) {
    this.game = game;
    this.lockState = new Map();
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
    this.locks = [];       // enemies inside the detection cone, best first
    this.detected = [];    // every tracked enemy
    this.primary = null;
    this.assisted = false;  // gun is leading the primary (crosshair close enough)
    this.firing = false;
    this.muzzleSide = 0;
    this.holding = false;   // missile trigger held (lock-on in progress)
    this.lockState.clear();
    this.tickT = 0;
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
    const f = this.aimDir(), off = g.rig?.aimOffset;
    this.detected.length = 0; this.locks.length = 0;
    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      _v.subVectors(e.pos, p.pos);
      const d = _v.length();
      if (d > 6000) continue;
      this.detected.push(e);
      // angle seen from the crosshair ray's origin (the camera side of the jet)
      if (off) _v.sub(off);
      const dv = _v.length() || 1;
      const ang = Math.acos(Math.max(-1, Math.min(1, _v.dot(f) / dv)));
      e.lockAngle = ang; e.dist = d;
      e.angRadius = Math.atan((e.radius * 1.2) / dv);
      if (ang < WEAPONS.lockCone && d < WEAPONS.lockRange) this.locks.push(e);
    }
    this.locks.sort((a, b) => (a.lockAngle + a.dist / 8000) - (b.lockAngle + b.dist / 8000));
    // sticky primary: keep the current target unless it leaves the cone
    if (!this.primary || !this.primary.alive || !this.locks.includes(this.primary)) this.primary = this.locks[0] || null;
    else if (this.locks[0] && this.locks[0] !== this.primary && this.locks[0].lockAngle < this.primary.lockAngle * 0.4) this.primary = this.locks[0];
    this.assisted = !!this.primary && this.primary.lockAngle < AIM.assistCone;
  }

  /** a homing missile lost its target: next hard lock, else the best detected one */
  retarget() {
    for (const [e, s] of this.lockState) if (s.locked && e.alive) return e;
    return this.locks.find((e) => e.alive) || null;
  }

  /** hard-locked targets (alive), in lock order */
  lockedTargets() {
    const out = [];
    for (const [e, s] of this.lockState) if (s.locked && e.alive) out.push(e);
    return out;
  }

  /** muzzle on the actual airframe: side -1 = left, +1 = right */
  muzzle(side, kind = 'gun') {
    const hp = this.game.jet.hardpoints[kind][side < 0 ? 0 : 1]; // from the active skin
    return this.game.jet.hardpoint(hp, this.game.player, new THREE.Vector3());
  }

  update(dt, ctl) {
    const g = this.game, p = g.player;
    this.acquire();
    if (!p.alive) { this.holding = false; this.lockState.clear(); return; }
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

    // --- missiles: reload, hold to lock, release to fire
    const M = WEAPONS.missiles;
    if (this.missiles < M.max) {
      this.reload += dt;
      if (this.reload >= M.reload) { this.reload = 0; this.missiles++; }
    }
    const hold = !!ctl.missileHold;
    if (hold) {
      if (!this.holding) { this.holding = true; this.lockState.clear(); }
      this.updateLocks(dt);
    } else if (this.holding) {
      this.holding = false;
      this.release();
    }
    if (this.salvoQueue.length) {
      this.salvoTimer -= dt;
      if (this.salvoTimer <= 0) {
        const next = this.salvoQueue.shift();
        this.salvoTimer = next?.locked ? WEAPONS.lockedMissile.stagger : M.stagger;
        this.fireMissile(next);
      }
    }
  }

  updateLocks(dt) {
    const g = this.game, L = WEAPONS.lock;
    // targets that died or left missile range drop out
    for (const e of this.lockState.keys()) if (!e.alive || e.dist > WEAPONS.lockRange) this.lockState.delete(e);
    const cands = [];
    for (const e of this.detected) {
      if (e.dist > WEAPONS.lockRange) continue;
      cands.push({ e, err: Math.max(0, e.lockAngle - e.angRadius) });
    }
    const events = stepLocks(this.lockState, cands, dt, this.missiles, L);
    this.tickT -= dt;
    for (const ev of events) {
      if (ev.type === 'locked') { g.audio.lockOn(); g.hud.toast(`LOCK ${ev.e.name} · ${this.lockedTargets().length}`, 'good'); }
      else if (this.tickT <= 0) { this.tickT = 0.16 - 0.1 * ev.p; g.audio.lockTick(lockDisplay(ev.p)); }
    }
  }

  /** trigger released: missiles at every hard lock, or a dumbfire pair */
  release() {
    const g = this.game, M = WEAPONS.missiles;
    const targets = this.lockedTargets();
    this.lockState.clear();
    if (this.missiles <= 0) { g.audio.click(); return; }
    if (targets.length) {
      // one kill missile per lock (locks never exceed the missiles you had)
      for (const e of targets) if (this.missiles > 0) { this.salvoQueue.push({ target: e, locked: true }); this.missiles--; }
      this.salvoTimer = 0;
    } else {
      const n = Math.min(WEAPONS.lock.dumbfire, this.missiles);
      for (let i = 0; i < n; i++) this.salvoQueue.push({ target: null, locked: false });
      this.missiles -= n;
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
    // muzzle flash: bigger now that every round counts
    g.particles.normal.emit({ x: origin.x, y: origin.y, z: origin.z, rel: true, life: 0.06, size: 3.4, color: 0x15171a, shape: 1 });
  }

  fireMissile(shot) {
    const g = this.game, p = g.player, M = WEAPONS.missiles;
    const target = shot?.target || null;
    this.muzzleSide = this.muzzleSide === 1 ? -1 : 1;
    const origin = this.muzzle(this.muzzleSide, 'rail');
    if (shot?.locked && target?.alive) {
      // kill missile: straight at the target at hypersonic speed, lethal on arrival
      const K = WEAPONS.lockedMissile;
      const vel = _v.subVectors(target.pos, origin).normalize().multiplyScalar(K.speed * 0.5).add(p.vel);
      g.projectiles.missile('player', origin, vel, target, {
        relSpeed: K.speed, accel: K.accel, turnRate: K.turnRate, damage: M.damage, splash: M.splash,
        prox: K.prox, life: K.life, armDelay: 0, kill: true,
      });
      g.audio.missileLaunch(true);
      return;
    }
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
