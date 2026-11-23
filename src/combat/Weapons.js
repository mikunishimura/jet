// Player armament + target acquisition ("detection system").
//
// AUTO-FIRE (AIM.autoFire, default): you fly and aim, the jet pulls the trigger.
//   * the minigun opens up on any enemy within AIM.autoCone (20°) of the
//     crosshair and in gun range, leading its motion, in bursts that never
//     overheat. How hard it hits is up to your aim: on center is a critical
//     hit (2×), the edge of the cone does 0.3× (aimDamage, WEAPONS.aimQuality)
//   * keep an enemy inside the lock ring (lock.autoMargin) for lock.time and
//     the lock lands (aim only, the nose doesn't matter). A precise lock (mean error under lock.precise) sends a kill missile; a
//     sloppy one sends a missile the enemy may dodge (WEAPONS.evade)
//   * flares are manual (F): defence is flying (break turns, Countermeasures)
// MANUAL (setting off): LMB / J hold = gun + lock-on, release = kill missiles;
//   RMB / K = lock-on without the gun (released empty: a dumbfire pair).
// LMB / J also forces the gun in auto mode (shoot at nothing in particular).
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
      // tracking quality: mean crosshair error while this lock built
      const err = cands.find((c) => c.e === e)?.err ?? 0;
      s.errSum = (s.errSum || 0) + err * dt; s.tTrack = (s.tTrack || 0) + dt;
      s.meanErr = s.errSum / s.tTrack;
      if (s.p >= 1) { s.locked = true; events.push({ type: 'locked', e, p: 1, meanErr: s.meanErr }); }
      else events.push({ type: 'tracking', e, p: s.p });
    } else {
      s.out += dt;
      if (s.out > cfg.grace) s.p -= cfg.drain * dt;
      if (s.p <= 0) locks.delete(e);
    }
  }
  return events;
}

/**
 * Gun damage multiplier for a crosshair error `err` (rad, beyond the target's
 * own angular size): critMult on center, then from `full` down to `edge` at
 * the cone. Pure (unit-tested).
 */
export function aimDamage(err, cone = AIM.autoCone, q = WEAPONS.aimQuality) {
  if (err <= q.crit) return q.critMult;
  const t = Math.min(1, (err - q.crit) / Math.max(1e-6, cone - q.crit));
  return q.full + (q.edge - q.full) * t;
}

/**
 * Spread fire: every enemy in the aimed area the gun can reach, best aimed
 * first. Including ones a kill missile is chasing: if you aim at an enemy,
 * you always hit it and see the damage. Pure.
 */
export function gunTargets(enemies, cone = AIM.assistCone, range = WEAPONS.minigun.range * 1.05) {
  return enemies.filter((e) => e.alive && e.aimErr < cone && e.dist < range).sort((a, b) => a.aimErr - b.aimErr);
}

/**
 * Which target round number i goes to: every other round to targets[0] (the one
 * closest to the crosshair), the rest in turn over the others. Pure.
 */
export function pickTarget(targets, i) {
  const n = targets.length;
  if (!n) return null;
  return n === 1 || i % 2 === 0 ? targets[0] : targets[1 + ((i >> 1) % (n - 1))];
}

/** fire-rate multiplier for n targets in the aimed area */
export const gunRate = (n, W = WEAPONS.minigun) => 1 + W.multiRate * (Math.min(Math.max(n, 1), W.multiMax) - 1);

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
    this.targets = [];      // spread fire: everything in the aimed area the gun is working on
    this.rr = 0;            // round-robin over `targets`
    this.firing = false;
    this.muzzleSide = 0;
    this.holding = false;   // trigger held (lock-on in progress)
    this.missileKey = false; // RMB / K was part of this hold (allows a dumbfire release)
    this.doomed = new Set(); // auto mode: targets with a kill missile already on the way
    this.rest = false;       // auto gun: cooling between bursts
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
      e.aimErr = Math.max(0, ang - e.angRadius);                       // aim quality: error beyond its own size
      if (ang < WEAPONS.lockCone && d < WEAPONS.lockRange) this.locks.push(e);
    }
    // what you aim at is what you're working on (a missile chasing it changes nothing)
    const rank = (e) => e.lockAngle + e.dist / 8000;
    this.locks.sort((a, b) => rank(a) - rank(b));
    // sticky primary: keep the current target unless it leaves the cone
    if (!this.primary || !this.primary.alive || !this.locks.includes(this.primary)) this.primary = this.locks[0] || null;
    else if (this.locks[0] && this.locks[0] !== this.primary && this.locks[0].lockAngle < this.primary.lockAngle * 0.4) this.primary = this.locks[0];
    // while locking, the gun works on what you're locking, then on what isn't locked yet
    if (this.holding) {
      const tr = this.lockState.tracked;
      if (tr && tr.alive && this.locks.includes(tr)) this.primary = tr;
      else if (this.primary && this.lockState.get(this.primary)?.locked) this.primary = this.locks.find((e) => !this.lockState.get(e)?.locked) || this.primary;
    }
    this.assisted = !!this.primary && this.primary.aimErr < AIM.assistCone;
    this.targets = gunTargets(this.detected);
  }

  /** fighting right now: the gun is firing, a lock is building, or missiles are leaving */
  get engaged() {
    if (this.firing || this.salvoQueue.length) return true;
    for (const s of this.lockState.values()) if (s.p > 0) return true;
    return false;
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
    // auto: fire at whatever is in the aimed area and in range, without pauses: aim at an
    // enemy and the damage never stops (no heat, no rest between bursts in auto-fire)
    const auto = AIM.autoFire;
    const inRange = this.targets.length > 0;
    this.rest = false;
    const autoGun = auto && inRange;
    this.firing = (ctl.gun || autoGun) && this.overheated <= 0;
    // manual: barrels only cool when you let go of the trigger
    this.sinceFire = this.firing ? 0 : (this.sinceFire || 0) + dt;
    if (auto) this.heat = Math.max(0, this.heat - W.cool * dt);
    else if (this.sinceFire > W.coolDelay) this.heat = Math.max(0, this.heat - W.cool * dt * (this.overheated > 0 ? 1.6 : 1));
    if (this.firing) {
      const k = gunRate(this.targets.length);   // more targets in the aimed area: the barrels spin faster
      while (this.gunCooldown <= 0) {
        this.gunCooldown += 1 / (W.rate * k);
        this.fireBullet();
        if (auto) continue;                     // auto-fire never overheats
        this.heat += W.heatPerShot / k;
        if (this.heat >= 1) { this.heat = 1; this.overheated = W.overheatLock; g.audio.overheat(); g.hud.toast('GUN OVERHEAT', 'warn'); break; }
      }
    } else this.gunCooldown = Math.max(this.gunCooldown, 0);

    // --- missiles: reload, hold to lock, release to fire
    const M = WEAPONS.missiles;
    if (this.missiles < M.max) {
      this.reload += dt;
      if (this.reload >= M.reload) { this.reload = 0; this.missiles++; }
    }
    // a target stays "locked-in" (the gun leaves it alone) only while its kill missile is still flying
    for (const e of this.doomed) {
      const flying = g.projectiles?.missiles.some((m) => m.kill && m.owner === 'player' && m.target === e);
      const queued = this.salvoQueue.some((q) => q.target === e);
      if (!e.alive || (!flying && !queued)) this.doomed.delete(e);
    }
    // auto: always tracking, every completed lock fires at once.
    // manual: holding the gun (or the missile key) builds locks, releasing fires them.
    const hold = auto || !!(ctl.gun || ctl.missileHold);
    if (hold) {
      if (!this.holding) { this.holding = true; this.missileKey = false; this.lockState.clear(); this.lockState.tracked = null; }
      if (ctl.missileHold) this.missileKey = true;
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
      if (e.dist > WEAPONS.lockRange || this.doomed.has(e)) continue;
      cands.push({ e, err: e.aimErr });
    }
    const cfg = AIM.autoAim ? { ...L, margin: L.autoMargin } : L;
    const events = stepLocks(this.lockState, cands, dt, this.missiles, cfg);
    this.tickT -= dt;
    for (const ev of events) {
      if (ev.type === 'locked') {
        g.audio.lockOn();
        const kill = ev.meanErr <= L.precise;
        if (AIM.autoFire && this.missiles > 0) {
          // auto: the missile leaves the moment the lock lands; a precise lock is a kill
          this.lockState.delete(ev.e); if (kill) this.doomed.add(ev.e);
          this.salvoQueue.push({ target: ev.e, locked: true, kill }); this.missiles--;
          if (this.salvoQueue.length === 1) this.salvoTimer = 0;
          g.hud.toast(kill ? `PRECISE LOCK ${ev.e.name} · KILL MISSILE` : `LOOSE LOCK ${ev.e.name} · IT MAY DODGE`, kill ? 'good' : 'warn');
        } else g.hud.toast(`${kill ? 'PRECISE' : 'LOOSE'} LOCK ${ev.e.name} · ${this.lockedTargets().length}`, kill ? 'good' : 'warn');
      }
      else if (this.tickT <= 0) { this.tickT = 0.16 - 0.1 * ev.p; g.audio.lockTick(lockDisplay(ev.p)); }
    }
  }

  /** trigger released: a kill missile at every hard lock (or a dumbfire pair from RMB / K) */
  release() {
    const g = this.game, M = WEAPONS.missiles;
    const targets = this.lockedTargets();
    this.lockMeanErr = new Map(targets.map((e) => [e, this.lockState.get(e)?.meanErr ?? 0]));
    this.lockState.clear(); this.lockState.tracked = null;
    if (!targets.length && !this.missileKey) return; // a plain gun burst: nothing else to do
    if (this.missiles <= 0) { g.audio.click(); return; }
    if (targets.length) {
      // one kill missile per lock (locks never exceed the missiles you had)
      for (const e of targets) if (this.missiles > 0) { this.salvoQueue.push({ target: e, locked: true, kill: (this.lockMeanErr.get(e) ?? 0) <= WEAPONS.lock.precise }); this.missiles--; }
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
    // spread fire: every other round goes to the enemy you're aiming at (closest to the
    // crosshair: its damage never stalls), the rest take turns over the others in the area
    const t = pickTarget(this.targets, this.rr++);
    // aim quality: the closer the crosshair is to the target, the harder each round hits
    const mult = t ? aimDamage(t.aimErr, AIM.assistCone) : 1;
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
      // lead with velocity AND acceleration (sidesteps), so rounds meet the target where it will be
      _dir.copy(rel).addScaledVector(rv, tau);
      if (t.acc) _dir.addScaledVector(t.acc, 0.5 * tau * tau);
      _dir.normalize();
    } else {
      // no assist: converge on the crosshair ray
      _dir.copy(this.aimPoint(_v)).sub(origin).normalize();
    }
    // dispersion: tight when the jet is steady, wide when it's turning, buffeted or hit (Bloom; the reticle shows it)
    const sp = g.bloom ? g.bloom.spread(W.spread) : W.spread;
    g.bloom?.shot();
    _dir.x += (Math.random() - 0.5) * sp * 2; _dir.y += (Math.random() - 0.5) * sp * 2; _dir.z += (Math.random() - 0.5) * sp * 2;
    _dir.normalize();
    const vel = _dir.clone().multiplyScalar(W.speed).add(p.vel);
    const b = g.projectiles.bullet('player', origin, vel, W.damage * mult, 0x2a2d31, W.range / W.speed);
    b.crit = mult > WEAPONS.aimQuality.full;
    b.splash = W.splash; b.splashShare = W.splashShare; b.fuse = W.fuse;
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
      // locked: straight at the target at hypersonic speed. A precise lock is a
      // kill missile (lethal on arrival); a loose one does missile damage and
      // the target may jink out of its way at the last moment (WEAPONS.evade)
      const K = WEAPONS.lockedMissile, kill = shot.kill !== false;
      const vel = _v.subVectors(target.pos, origin).normalize().multiplyScalar(K.speed * 0.5).add(p.vel);
      g.projectiles.missile('player', origin, vel, target, {
        relSpeed: K.speed, accel: K.accel, turnRate: K.turnRate, damage: M.damage, splash: M.splash,
        prox: K.prox, life: K.life, armDelay: 0, kill, evade: kill ? 0 : WEAPONS.evade[target.name] ?? 0.5,
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
