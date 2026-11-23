// Incoming-missile threat tracking + flares.
//
// Threats: every enemy missile homing on you gets a time to impact (distance /
// closing speed, in the player's frame). The HUD and the warning tone read
// `threats` (closest impact first): the closer the impact, the louder, faster
// and bigger the warning.
//
// Break turn (the main defence, all flying): start a hard turn, climb or dive
// while a missile is inside THREATS.breakWindow seconds of impact and it
// overshoots, thrown off to the outside of your turn. Too early and it simply
// re-acquires; a turn you were already holding doesn't count (it must be a
// fresh break, see breakFresh). `breakState` is the pure part (unit-tested).
//
// Flares (F, manual only): eject decoys behind the jet. Any missile whose impact is within
// THREATS.flares.window seconds while a flare burns is pulled off onto it and
// detonates there, harmlessly. Fire too early and the flare is wasted: timing
// is the skill. Charges recharge one at a time.
import * as THREE from 'three';
import { THREATS } from '../config.js';
import { SHAPE } from '../render/Particles.js';

const _r = new THREE.Vector3();
const _t = new THREE.Vector3();

/**
 * Pure break-turn detector. Feed the flight direction (unit vector) every
 * frame; returns whether a FRESH hard break is happening now.
 * state: { prev: Vector3|null, rate (rad/s, smoothed), hardT (s since the rate crossed breakRate) }
 */
export function breakState(state, forward, dt, cfg = THREATS) {
  if (!state.prev) { state.prev = forward.clone(); state.rate = 0; state.hardT = Infinity; state.turn = new THREE.Vector3(); return false; }
  const ang = Math.acos(Math.max(-1, Math.min(1, state.prev.dot(forward))));
  const inst = ang / Math.max(dt, 1e-4);
  state.turn.subVectors(forward, state.prev);              // which way the nose is swinging
  state.rate += (inst - state.rate) * (1 - Math.exp(-dt / 0.06));
  state.prev.copy(forward);
  if (state.rate >= cfg.breakRate) state.hardT = state.hardT === Infinity ? 0 : state.hardT + dt;
  else state.hardT = Infinity;
  return state.hardT <= cfg.breakFresh;
}

/** seconds until missile m reaches the player (Infinity if it isn't closing) */
export function timeToImpact(m, player) {
  _r.subVectors(m.p, player.pos);
  const dist = _r.length();
  if (dist < 1e-3) return 0;
  const closing = -_r.dot(m.rv) / dist; // rv is already relative to the player
  return closing > 1 ? dist / closing : Infinity;
}

/** 0 = no concern .. 1 = impact now */
export const threatLevel = (tti, from = THREATS.warnFrom) => (tti >= from ? 0 : 1 - tti / from);

export class Countermeasures {
  constructor(game) { this.game = game; this.reset(); }

  reset() {
    this.charges = THREATS.flares.charges;
    this.recharge = 0;
    this.flares = [];
    this.threats = [];   // [{ m, tti, level, dist }] closest impact first
    this.beepT = 0;
    this.brk = { prev: null };
    this.breaking = false;
  }

  get worst() { return this.threats[0] || null; }

  /** a missile is inside the break window right now (HUD: "BREAK") */
  get breakCall() { const w = this.worst; return !!w && w.tti >= THREATS.breakWindow[0] && w.tti <= THREATS.breakWindow[1]; }

  /** a fresh hard break beats every missile inside the window: it overshoots to the outside of the turn */
  beat() {
    const g = this.game, [lo, hi] = THREATS.breakWindow;
    let n = 0;
    for (const t of this.threats) {
      if (t.tti < lo || t.tti > hi || t.m.beaten) continue;
      t.m.beaten = true;
      const sp = t.m.rv.length();
      _t.copy(this.brk.turn).normalize().multiplyScalar(-THREATS.breakDeflect);
      t.m.rv.normalize().add(_t).normalize().multiplyScalar(sp);
      n++;
    }
    if (n) g.onMissileBeaten?.(n);
    return n;
  }

  deploy() {
    const g = this.game, p = g.player, F = THREATS.flares;
    if (!p.alive) return 0;
    if (this.charges <= 0) { g.audio.click(); g.hud.toast('NO FLARES · RECHARGING', 'warn'); return 0; }
    this.charges--;
    for (let i = 0; i < 3; i++) {
      const side = (i - 1) * 0.6 + (Math.random() - 0.5) * 0.3;
      const rv = p.forward.clone().multiplyScalar(-F.eject * (0.8 + Math.random() * 0.4))
        .addScaledVector(p.right, side * F.eject * 0.5).add(new THREE.Vector3(0, -40 - Math.random() * 40, 0));
      this.flares.push({ p: p.pos.clone().addScaledVector(p.forward, -12), rv, life: F.life, age: 0, born: g.frame });
    }
    const pulled = this.decoy();
    g.audio.flares();
    g.hud.toast(pulled ? `FLARES · ${pulled} MISSILE${pulled > 1 ? 'S' : ''} DECOYED` : 'FLARES', pulled ? 'good' : 'info');
    return pulled;
  }

  /** pull every threat inside the flare window onto a burning flare */
  decoy() {
    const live = this.flares.filter((f) => f.life > 0.15);
    if (!live.length) return 0;
    let n = 0;
    for (const t of this.threats) {
      if (t.m.decoy || t.tti > THREATS.flares.window) continue;
      t.m.decoy = live[n % live.length];
      n++;
    }
    return n;
  }

  update(dt) {
    const g = this.game, p = g.player, F = THREATS.flares;
    if (this.charges < F.charges) {
      this.recharge += dt;
      if (this.recharge >= F.recharge) { this.recharge = 0; this.charges++; }
    } else this.recharge = 0;

    // flares ride in the player's frame (like everything else), slowed by drag
    const pv = p.vel, dark = (g.space?.env.orbit || 0) > 0.5;
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life -= dt; f.age += dt;
      const k = f.born === g.frame ? 0 : 1;
      f.p.x += (pv.x * k + f.rv.x) * dt; f.p.y += (pv.y * k + f.rv.y) * dt; f.p.z += (pv.z * k + f.rv.z) * dt;
      f.rv.multiplyScalar(Math.exp(-0.6 * dt));
      if (f.life > 0) {
        g.particles.normal.emit({ x: f.p.x, y: f.p.y, z: f.p.z, rel: true, life: 0.35, size: 3.4 - f.age, color: dark ? 0xffffff : 0x15171a, shape: (g.frame + i) % 2 ? SHAPE.PLUS : SHAPE.SQUARE, drag: 1 });
      }
      if (f.life < -2) this.flares.splice(i, 1); // decoyed missiles keep homing on the spot a little longer
    }

    // threats, closest impact first
    this.threats.length = 0;
    if (p.alive) {
      for (const m of g.projectiles.missiles) {
        if (m.owner !== 'enemy' || m.decoy || m.beaten) continue;
        const tti = timeToImpact(m, p);
        if (!Number.isFinite(tti)) continue;
        this.threats.push({ m, tti, level: threatLevel(tti), dist: m.p.distanceTo(p.pos) });
      }
      this.threats.sort((a, b) => a.tti - b.tti);
      if (this.flares.some((f) => f.life > 0)) this.decoy(); // a burning flare keeps catching
      this.breaking = breakState(this.brk, p.forward, dt);
      if (this.breaking && this.threats.length) this.beat();
    } else this.brk.prev = null;

    // break call: one sweep the moment the closest missile enters the window
    const call = p.alive && this.breakCall;
    if (call && !this.called && !g.attract) g.audio.breakCall?.();
    this.called = call;
    // warning tone: beeps quicken and rise as the impact closes in
    const w = this.worst;
    if (w && w.level > 0 && !g.attract) {
      this.beepT -= dt;
      if (this.beepT <= 0) {
        this.beepT = 0.55 - 0.48 * w.level;
        g.audio.missileWarning(w.level);
      }
    } else this.beepT = 0;
  }
}
