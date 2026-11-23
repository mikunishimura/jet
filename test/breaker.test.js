// Line breakers: hold one course (straight, or a steady left / right turn) for
// too long and an obstacle appears right where that course takes you.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BREAKER, TIERS, FLAGS, DEG } from '../src/config.js';
import { LineWatch, predictCourse } from '../src/game/LineWatch.js';
import { World } from '../src/world/World.js';
import { PathHazards } from '../src/world/PathHazards.js';
import { Player } from '../src/game/Player.js';

const DT = 1 / 60;
const base = { left: false, right: false, throttle: false, throttleTap: false, brake: false, up: false, down: false };
const PATIENCE = 5;

/** feed a watcher a course: heading(t), pitch(t); returns the first trigger and when */
function watch(secs, heading, pitch = () => 0, w = new LineWatch()) {
  w.flown = BREAKER.firstAfter; // past the warm-up
  for (let t = 0; t < secs; t += DT) {
    const c = w.update(DT, heading(t), pitch(t), PATIENCE);
    if (c) return { ...c, t };
  }
  return null;
}

test('holding straight triggers after `patience`, whatever the heading', () => {
  for (const h0 of [0, 1.3, -2.4, 3.1]) {
    const c = watch(10, () => h0);
    assert.ok(c, `heading ${h0}`);
    assert.equal(c.kind, 'straight');
    assert.ok(Math.abs(c.t - PATIENCE) < 0.05, `t=${c.t}`);
  }
});

test('a steady left or right turn counts as one course too', () => {
  const left = watch(10, (t) => 0.5 + 0.4 * t);
  const right = watch(10, (t) => -1 - 0.4 * t);
  assert.equal(left?.kind, 'left');
  assert.equal(right?.kind, 'right');
  assert.ok(Math.abs(left.rate - 0.4) < 0.05);
});

test('trims and gusts do not reset the watch; a real course change does', () => {
  const trims = watch(10, (t) => 0.3 + 2 * DEG * Math.sin(t * 3));
  assert.ok(trims && Math.abs(trims.t - PATIENCE) < 0.05, 'small trims still count as holding the line');
  // a 25° jink every 3 s: never on one course long enough
  assert.equal(watch(20, (t) => (Math.floor(t / 3) % 2) * 25 * DEG), null);
  // climbing or diving is a course change too
  assert.equal(watch(20, () => 0, (t) => (Math.floor(t / 3) % 2) * 12 * DEG), null);
});

test('no breaker in the first seconds of a flight', () => {
  const w = new LineWatch();
  let first = null;
  for (let t = 0; t < 20 && !first; t += DT) if (w.update(DT, 0, 0, 2)) first = t;
  assert.ok(first >= BREAKER.firstAfter - DT, `first at ${first}`);
});

test('predictCourse: straight lines and circles', () => {
  const [x, y, z] = predictCourse(0, 500, 0, Math.PI / 2, 0, 0, 1000, 0, 3, 6, 1e5);
  assert.ok(Math.abs(x + 3000) < 1e-6 && Math.abs(z) < 1e-6 && y === 500, 'heading π/2 flies toward -x');
  // a half circle: radius v/w, ends 2r to the side, heading reversed
  const w = 0.5, v = 1000, r = v / w;
  const [cx, , cz, ch] = predictCourse(0, 500, 0, 0, 0, w, v, 0, Math.PI / w, 6, 1e5, 400);
  assert.ok(Math.abs(Math.hypot(cx, cz) - 2 * r) < 5, `${cx}, ${cz}`);
  assert.ok(Math.abs(ch - Math.PI) < 1e-9);
  // clamps at the floor
  assert.equal(predictCourse(0, 100, 0, 0, -0.5, 0, 1000, 0, 3, 6, 1e5)[1], 6);
});

function rig(y, tier = 3, heading = 0.7) {
  const w = new World(new THREE.Scene(), 4);
  const h = new PathHazards(w);
  const events = [];
  const p = new Player((type, e) => events.push({ type, ...e })); p.seedTurbulence(2);
  const s = p.speedSys; s.engaged = true; s.tier = tier; s.speed = TIERS[tier - 1].speed;
  p.pos.set(0, y, 0); p.prevPos.copy(p.pos); p.heading = heading; p.updateBasis();
  p.invincible = true;
  const fly = (secs, ctl = {}) => { for (let t = 0; t < secs; t += DT) p.update(DT, { ...base, ...ctl }, w); };
  const hits = () => events.filter((e) => e.type === 'impact').length;
  return { w, h, p, fly, hits };
}

for (const [label, y] of [['a ground rock in the obstacle band', 700], ['a floating rock in the open sky', 5000]]) {
  test(`straight: ${label} lands on your line, and a committed dodge clears it`, () => {
    const a = rig(y);
    const b = a.h.spawnBreaker(a.p, 0, { rate: 0 }, 'block');
    assert.ok(b && a.h.breakers.length === 1);
    a.fly(BREAKER.lead[0] + 0.6);
    assert.ok(a.hits() > 0, 'holding the line hits it');

    const d = rig(y);
    d.h.spawnBreaker(d.p, 0, { rate: 0 }, 'block');
    d.fly(0.35);                              // reaction time
    d.fly(BREAKER.lead[0], { right: true });  // then a hard turn
    assert.equal(d.hits(), 0, 'turning away clears it');
  });
}

test('turning: the breaker sits on your arc, not straight ahead', () => {
  const a = rig(5000, 2);
  a.fly(1.5, { left: true });                   // settle into the turn
  const h0 = a.p.heading; a.fly(0.5, { left: true });
  const rate = (a.p.heading - h0) / 0.5;
  a.h.spawnBreaker(a.p, 0, { rate }, 'block');
  a.fly(BREAKER.lead[0] + 0.6, { left: true });
  assert.ok(a.hits() > 0, 'keep turning the same way and you hit it');
});

test('curtain: a row across your course (only off the ground), go over or under', () => {
  const a = rig(5000);
  const b = a.h.spawnBreaker(a.p, 0, { rate: 0 }, 'curtain');
  assert.equal(b.kind, 'curtain');
  a.fly(0.35); a.fly(BREAKER.lead[0], { up: true });
  assert.equal(a.hits(), 0, 'climbing over clears it');
  const g = rig(700);
  assert.equal(g.h.spawnBreaker(g.p, 0, { rate: 0 }, 'curtain').kind, 'block', 'no curtains on the ground');
});

test('sized to the approach: bigger at higher speed, so a trim never clears it', () => {
  const slow = rig(5000, 1).h.spawnBreaker(rig(5000, 1).p, 0, { rate: 0 }, 'block');
  const r1 = rig(5000, 1), r5 = rig(5000, 5);
  const b1 = r1.h.spawnBreaker(r1.p, 0, { rate: 0 }, 'block'), b5 = r5.h.spawnBreaker(r5.p, 0, { rate: 0 }, 'block');
  assert.ok(b5.r > b1.r * 3, `${b1.r} vs ${b5.r}`);
  // a 2° trim at spawn time misses the center by less than the radius
  for (const [b, tier] of [[b1, 1], [b5, 5]]) {
    const dist = TIERS[tier - 1].speed * BREAKER.lead[0];
    assert.ok(Math.tan(2 * DEG) * dist < b.r, `tier ${tier}`);
  }
  void slow;
});
