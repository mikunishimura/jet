// Missile lock-on (hold / track / release), incoming-missile threat timing, flares.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { stepLocks, lockDisplay } from '../src/combat/Weapons.js';
import { timeToImpact, threatLevel, Countermeasures } from '../src/combat/Countermeasures.js';
import { WEAPONS, THREATS, DEG } from '../src/config.js';

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
    particles: { normal: { emit() {} } }, audio: { click() {}, flares() {}, missileWarning() {} }, hud: { toast: (t) => toasts.push(t) },
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

test('auto-fire: flares go out by themselves only when a missile is about to land', () => {
  const near = incoming(THREATS.autoFlareAt * 0.5), far = incoming(THREATS.autoFlareAt + 2);
  const g = stubGame([far]);
  const cm = new Countermeasures(g);
  cm.update(DT);
  assert.equal(cm.wantsAutoFlare(), false, 'not yet');
  g.projectiles.missiles.push(near);
  cm.update(DT);
  assert.equal(cm.wantsAutoFlare(), true);
  cm.charges = 0;
  assert.equal(cm.wantsAutoFlare(), false, 'nothing to drop');
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
