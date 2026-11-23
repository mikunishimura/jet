// Missile lock-on (hold / track / release), incoming-missile threat timing, flares.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { stepLocks, lockDisplay, aimDamage } from '../src/combat/Weapons.js';
import { timeToImpact, threatLevel, Countermeasures, breakState } from '../src/combat/Countermeasures.js';
import { WEAPONS, THREATS, DEG, AIM } from '../src/config.js';

const L = WEAPONS.lock, DT = 1 / 60;
const run = (locks, cands, secs, cap = 8) => { const ev = []; for (let t = 0; t < secs - 1e-9; t += DT) ev.push(...stepLocks(locks, cands(), DT, cap)); return ev; };

test('lock: tracking one enemy for lock.time locks it, not before', () => {
  const a = { id: 'a' }, locks = new Map();
  run(locks, () => [{ e: a, err: 1 * DEG }], L.time - 0.1);
  assert.equal(locks.get(a).locked, false);
  const ev = run(locks, () => [{ e: a, err: 1 * DEG }], 0.15);
  assert.ok(locks.get(a).locked && ev.some((x) => x.type === 'locked' && x.e === a));
});

test('lock: outside the aim margin nothing charges', () => {
  const a = {}, locks = new Map();
  run(locks, () => [{ e: a, err: L.margin * 1.5 }], 3);
  assert.equal(locks.size, 0);
});

test('lock: one target at a time, each takes its own lock.time', () => {
  const a = {}, b = {}, locks = new Map();
  const both = () => [{ e: a, err: 0.5 * DEG }, { e: b, err: 2 * DEG }];
  run(locks, both, L.time + 0.05);
  assert.ok(locks.get(a).locked);
  assert.ok((locks.get(b)?.p ?? 0) < 0.1, 'b waited while a was tracked');
  run(locks, both, L.time + 0.05);
  assert.ok(locks.get(b).locked, 'then b, with the crosshair still on both');
});

test('lock: the tracked target stays tracked when another drifts closer to the crosshair', () => {
  const a = {}, b = {}, locks = new Map();
  let t = 0;
  // a starts best; then b becomes marginally closer, back and forth (two targets close together)
  run(locks, () => { t++; return [{ e: a, err: (t % 2 ? 1 : 2) * DEG }, { e: b, err: (t % 2 ? 2 : 1) * DEG }]; }, L.time + 0.05);
  assert.ok(locks.get(a).locked, 'a locked in lock.time, not slowed by b');
});

test('lock: a short slip keeps the progress (grace), a long one drains it', () => {
  const a = {}, locks = new Map();
  run(locks, () => [{ e: a, err: 0 }], L.time * 0.6);
  const p = locks.get(a).p;
  run(locks, () => [], L.grace * 0.8);
  assert.equal(locks.get(a).p, p, 'held through the grace period');
  run(locks, () => [], 3);
  assert.ok(!locks.has(a), 'drained away');
});

test('lock: never more locks than missiles left (or maxTargets)', () => {
  const es = Array.from({ length: 6 }, () => ({})), locks = new Map();
  run(locks, () => es.map((e, i) => ({ e, err: i * 0.1 * DEG })), L.time * 7, 2);
  assert.equal([...locks.values()].filter((s) => s.locked).length, 2);
  const many = new Map();
  run(many, () => es.map((e, i) => ({ e, err: i * 0.1 * DEG })), L.time * 7, 99);
  assert.equal([...many.values()].filter((s) => s.locked).length, L.maxTargets);
});

test('lock ring display: slow at first, fast at the end, 0 -> 1', () => {
  assert.equal(lockDisplay(0), 0);
  assert.ok(Math.abs(lockDisplay(1) - 1) < 1e-12);
  assert.ok(lockDisplay(0.5) < 0.3, `half the time shows ${lockDisplay(0.5).toFixed(2)}`);
  assert.ok(lockDisplay(1) - lockDisplay(0.9) > lockDisplay(0.1) - lockDisplay(0) * 1 + 0.1, 'the last tenth fills more than the first');
});

test('threat: time to impact from distance and closing speed; level rises as it closes', () => {
  const player = { pos: new THREE.Vector3() };
  const m = { p: new THREE.Vector3(0, 0, -800), rv: new THREE.Vector3(0, 0, 400) };
  assert.ok(Math.abs(timeToImpact(m, player) - 2) < 1e-9);
  m.rv.set(0, 0, -400);
  assert.equal(timeToImpact(m, player), Infinity, 'flying away');
  assert.equal(threatLevel(THREATS.warnFrom + 1), 0);
  assert.ok(threatLevel(1) > threatLevel(3));
});

function stubGame(missiles) {
  const p = { alive: true, pos: new THREE.Vector3(), vel: new THREE.Vector3(0, 0, -1000), forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0) };
  const toasts = [];
  return {
    toasts, frame: 0, attract: false, player: p, projectiles: { missiles },
    particles: { normal: { emit() {} } }, audio: { click() {}, flares() {}, missileWarning() {}, breakCall() {} }, hud: { toast: (t) => toasts.push(t) },
  };
}
const incoming = (tti) => ({ owner: 'enemy', p: new THREE.Vector3(0, 0, -400 * tti), rv: new THREE.Vector3(0, 0, 400) });

test('flares: decoy missiles inside the window, miss the ones fired too early, use charges', () => {
  const near = incoming(THREATS.flares.window * 0.5), far = incoming(THREATS.flares.window + 1.5);
  const g = stubGame([near, far]);
  const cm = new Countermeasures(g);
  cm.update(DT);
  assert.equal(cm.worst.m, near);
  assert.equal(cm.deploy(), 1);
  assert.ok(near.decoy && !far.decoy, 'only the close one is pulled off');
  assert.equal(cm.charges, THREATS.flares.charges - 1);
  cm.update(DT);
  assert.ok(!cm.threats.some((t) => t.m === near), 'a decoyed missile is no longer a threat');
  // the far one arrives while a flare still burns: caught too
  far.p.set(0, 0, -400 * (THREATS.flares.window - 0.5));
  cm.update(DT);
  assert.ok(far.decoy, 'a burning flare keeps catching');
  for (let i = 0; i < THREATS.flares.charges; i++) cm.deploy();
  assert.equal(cm.charges, 0);
  assert.equal(cm.deploy(), 0, 'empty');
  for (let t = 0; t < THREATS.flares.recharge + 0.1; t += DT) cm.update(DT);
  assert.equal(cm.charges, 1, 'recharges one at a time');
});

test('release: one kill missile per hard lock; nothing locked -> a regular dumbfire pair', async () => {
  const { Weapons } = await import('../src/combat/Weapons.js');
  const g = { audio: { click() {} }, hud: { toast() {} }, enemies: { list: [] }, player: {} };
  const w = new Weapons(g);
  const a = { alive: true }, b = { alive: true }, c = { alive: true };
  w.lockState.set(a, { p: 1, locked: true, out: 0 });
  w.lockState.set(b, { p: 1, locked: true, out: 0 });
  w.lockState.set(c, { p: 0.6, locked: false, out: 0 }); // half-tracked: no missile
  w.release();
  assert.deepEqual(w.salvoQueue.map((s) => [s.target, s.locked]), [[a, true], [b, true]]);
  assert.equal(w.missiles, WEAPONS.missiles.max - 2);
  assert.equal(w.lockState.size, 0);
  w.salvoQueue.length = 0;
  w.release();
  assert.equal(w.salvoQueue.length, 0, 'a plain gun burst (left click) fires no missile');
  w.missileKey = true; // the hold came from RMB / K
  w.release();
  assert.equal(w.salvoQueue.length, WEAPONS.lock.dumbfire);
  assert.ok(w.salvoQueue.every((s) => !s.locked && !s.target));
});

test('flares are manual only: no auto-deploy hook left', () => {
  const cm = new Countermeasures(stubGame([incoming(0.5)]));
  assert.equal(cm.wantsAutoFlare, undefined);
  assert.equal(THREATS.flares.charges, 2);
});

/** swing the stub player's nose at `rate` rad/s (yaw) starting at `from` s; returns the swing helper */
function swing(g, cm, secs, rate, from = 0, onFrame = () => {}) {
  let h = 0;
  for (let t = 0; t < secs; t += DT) {
    if (t >= from) h += rate * DT;
    g.player.forward.set(-Math.sin(h), 0, -Math.cos(h));
    cm.update(DT); g.frame++;
    onFrame(t);
  }
}

test('break turn: a fresh hard turn inside the window makes the missile overshoot', () => {
  const m = incoming(1.0), g = stubGame([m]);
  let beaten = 0; g.onMissileBeaten = (n) => { beaten += n; };
  const cm = new Countermeasures(g);
  swing(g, cm, 0.3, 0.6, 0.05);
  assert.ok(m.beaten, 'out-turned');
  assert.equal(beaten, 1);
  assert.ok(m.rv.x !== 0, 'thrown off its line (to the outside of the turn)');
  assert.ok(m.rv.x > 0, `turning left (heading +) throws it right: ${m.rv.x}`);
  assert.ok(!cm.threats.some((t) => t.m === m), 'no longer a threat');
});

test('break turn: too early does nothing, and a turn you were already holding does not count', () => {
  const early = incoming(THREATS.breakWindow[1] + 1.5), g = stubGame([early]);
  const cm = new Countermeasures(g);
  swing(g, cm, 0.4, 0.6, 0.05);
  assert.ok(!early.beaten, 'outside the window: the missile just re-acquires');
  // already circling for 2 s when the missile reaches the window: not a fresh break
  const m = incoming(3), g2 = stubGame([m]);
  const cm2 = new Countermeasures(g2);
  swing(g2, cm2, 2, 0.6, 0, () => { m.p.z += 400 * DT; }); // the missile closes in meanwhile
  assert.ok(m.p.z > -400 * THREATS.breakWindow[1], 'it is inside the window now');
  assert.ok(!m.beaten, 'holding a turn is not a break');
  // gentle trims never count
  const t = incoming(0.8), g3 = stubGame([t]);
  const cm3 = new Countermeasures(g3);
  swing(g3, cm3, 0.4, THREATS.breakRate * 0.5, 0.05);
  assert.ok(!t.beaten);
});

test('breakState: fresh only for breakFresh seconds after the turn starts', () => {
  const st = {}, f = new THREE.Vector3(0, 0, -1);
  breakState(st, f, DT);
  let h = 0, fresh = 0;
  for (let t = 0; t < 2; t += DT) { h += 0.8 * DT; if (breakState(st, f.set(-Math.sin(h), 0, -Math.cos(h)), DT)) fresh += DT; }
  assert.ok(fresh > THREATS.breakFresh * 0.7 && fresh <= THREATS.breakFresh + 2 * DT, `fresh for ${fresh.toFixed(2)} s`);
});

test('aim quality: 2x on center, falling to 0.3x at the 12 deg cone', () => {
  const Q = WEAPONS.aimQuality, cone = AIM.autoCone;
  assert.equal(cone, 12 * DEG);
  assert.equal(aimDamage(0), Q.critMult);
  assert.equal(aimDamage(Q.crit), Q.critMult);
  assert.ok(Math.abs(aimDamage(Q.crit + 1e-6) - Q.full) < 1e-3, 'just off center: full damage');
  assert.ok(Math.abs(aimDamage(cone) - 0.3) < 1e-9);
  assert.ok(aimDamage(5 * DEG) > aimDamage(12 * DEG));
});

test('lock: the mean tracking error decides precise (kill) vs loose', () => {
  const a = {}, b = {}, locks = new Map();
  const ev = run(locks, () => [{ e: a, err: 0.5 * DEG }], L.time + 0.05);
  const la = ev.find((x) => x.type === 'locked');
  assert.ok(la.meanErr <= L.precise);
  const locks2 = new Map();
  const ev2 = run(locks2, () => [{ e: b, err: 4.5 * DEG }], L.time + 0.05);
  const lb = ev2.find((x) => x.type === 'locked');
  assert.ok(lb && lb.meanErr > L.precise, 'inside the 6 deg ring but sloppy');
});

test('lock: aim alone locks, wherever the nose points', async () => {
  const { Weapons } = await import('../src/combat/Weapons.js');
  const player = { alive: true, pos: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1), vel: new THREE.Vector3() };
  const side = { alive: true, pos: new THREE.Vector3(800, 0, -200), radius: 6, name: 'DRONE' };   // ~76 deg off the nose
  const g = { player, audio: { lockOn() {}, lockTick() {}, click() {} }, hud: { toast() {} }, enemies: { list: [side] },
    rig: { aimDir: new THREE.Vector3(800, 0, -200).normalize(), aimOffset: new THREE.Vector3() } };
  const w = new Weapons(g);
  for (let t = 0; t < L.time + 0.1; t += DT) { w.acquire(); w.updateLocks(DT); }
  assert.ok(w.doomed.has(side) || w.lockState.get(side)?.locked, 'crosshair on it: locks');
});

test('analog sticks (touch): half deflection settles at half bank, keys still go full', async () => {
  const { Player } = await import('../src/game/Player.js');
  let v = 0;
  for (let t = 0; t < 1; t += DT) v = Player.stick(v, 0.5, DT, 0.26, 0.1);
  assert.ok(Math.abs(v - 0.5) < 1e-9);
  for (let t = 0; t < 1; t += DT) v = Player.stick(v, 1, DT, 0.26, 0.1);
  assert.equal(v, 1);
  for (let t = 0; t < 1; t += DT) v = Player.stick(v, -0.3, DT, 0.26, 0.1);
  assert.ok(Math.abs(v + 0.3) < 1e-9, 'reverses onto the new deflection');
});

test('spread fire: every enemy in the aimed area, best aimed first, minus the locked-in ones', async () => {
  const { gunTargets } = await import('../src/combat/Weapons.js');
  const mk = (aimErr, dist = 800, alive = true) => ({ aimErr: aimErr * DEG, dist, alive });
  const a = mk(1), b = mk(12), c = mk(6), far = mk(2, 5000), out = mk(30), doomedOne = mk(0.5), dead = mk(3, 800, false);
  const t = gunTargets([a, b, c, far, out, doomedOne, dead], new Set([doomedOne]));
  assert.deepEqual(t, [a, c, b]);
});

test('spread fire: more targets, faster fire, capped', async () => {
  const { gunRate } = await import('../src/combat/Weapons.js');
  const W = WEAPONS.minigun;
  assert.equal(gunRate(0), 1); assert.equal(gunRate(1), 1);
  assert.ok(gunRate(3) > gunRate(2) && gunRate(2) > 1);
  assert.equal(gunRate(10), gunRate(W.multiMax));
});

test('the gun hits where you aim, wherever the nose points (real frame order, hypersonic)', async () => {
  const { Weapons } = await import('../src/combat/Weapons.js');
  const { Projectiles } = await import('../src/combat/Projectiles.js');
  const { Player } = await import('../src/game/Player.js');
  const { TIERS } = await import('../src/config.js');
  const hitRate = (offNoseDeg) => {
    const player = new Player(() => {}); player.seedTurbulence(1);
    const s = player.speedSys; s.engaged = true; s.tier = 3; s.speed = TIERS[2].speed; // 8 km/s
    const W0 = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
    let hits = 0;
    const a = offNoseDeg * DEG;  // enemy sits this far off the nose, 900 m out, holding station
    const e = { alive: true, name: 'UFO', radius: 17, hp: 1e9, maxHp: 1e9, rv: new THREE.Vector3(), vel: new THREE.Vector3(), acc: new THREE.Vector3(),
      pos: new THREE.Vector3(-Math.sin(a) * 900, player.pos.y, -Math.cos(a) * 900), damage() { hits++; } };
    const g = { frame: 0, attract: false, player, scene: new THREE.Scene(), enemies: { list: [e] }, world: { origin: { x: 0, z: 0 }, collide: () => null },
      particles: { normal: { emit() {}, burst() {} }, vector: { ring() {} } }, audio: { gunshot() {}, lockOn() {}, lockTick() {}, click() {}, explosion() {} },
      hud: { toast() {} }, fx: { explosionNear() {} }, onEnemyHit() {},
      jet: { hardpoints: { gun: [{}, {}], rail: [{}, {}] }, hardpoint: (hp, p, out) => out.copy(p.pos) },
      rig: { aimDir: new THREE.Vector3(), aimOffset: new THREE.Vector3() } };
    g.weapons = new Weapons(g); g.projectiles = new Projectiles(g);
    const W = g.weapons; let fired = 0;
    const fb = W.fireBullet.bind(W); W.fireBullet = () => { fired++; fb(); };
    for (let i = 0; i < 90; i++) {           // 1.5 s, in Game.loop order
      g.frame++;
      player.update(DT, base2, W0);
      e.vel.copy(player.vel).add(e.rv); e.pos.addScaledVector(e.vel, DT);   // enemies.update
      g.rig.aimDir.subVectors(e.pos, player.pos).normalize();             // perfect mouse aim
      W.doomed.clear(); W.lockState.clear();
      W.update(DT, {});
      g.projectiles.update(DT);
    }
    return hits / Math.max(1, fired);
  };
  const base2 = { left: false, right: false, throttle: true, throttleTap: false, brake: false, up: false, down: false };
  // straight ahead, off to the side, square on your left / right, behind your shoulder
  for (const deg of [0, 60, 90, -90, 135]) {
    const r = hitRate(deg);
    assert.ok(r > 0.9, `enemy ${deg} deg off the nose: ${(r * 100).toFixed(0)}% hit`);
  }
});

test('flank waves: they come in from your left / right, ahead waves from the front', async () => {
  const { EnemyManager } = await import('../src/enemies/Enemies.js');
  const { Player } = await import('../src/game/Player.js');
  const player = new Player(() => {}); player.heading = 0.8; player.updateBasis();
  const g = { player, scene: new THREE.Scene(), hud: { toast() {} }, audio: { alarm() {} }, difficulty: 0 };
  g.enemies = new EnemyManager(g);
  const bearing = (e) => {   // deg from the nose, + = right
    const d = e.pos.clone().sub(player.pos);
    return Math.atan2(d.dot(player.right), d.dot(player.flatForward)) / DEG;
  };
  for (const [side, lo, hi] of [['left', -120, -60], ['right', 60, 120], ['front', -20, 20]]) {
    g.enemies.reset();
    assert.equal(g.enemies.spawnWave('drones', 0.5, side), side);
    for (const e of g.enemies.list) {
      const b = bearing(e);
      assert.ok(b > lo && b < hi, `${side}: drone at ${b.toFixed(0)} deg`);
      // closing in from that side
      const closing = -e.rv.dot(e.pos.clone().sub(player.pos).normalize());
      assert.ok(closing > 300, `${side}: closing at ${closing.toFixed(0)} m/s`);
    }
  }
});
