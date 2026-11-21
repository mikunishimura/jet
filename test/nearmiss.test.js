import test from 'node:test';
import assert from 'node:assert/strict';
import { NearMiss, nearMissThreshold } from '../src/game/NearMiss.js';
import { circle, capsule } from '../src/game/Collision.js';
import { FLIGHT } from '../src/config.js';

const R = FLIGHT.playerRadius;
// fly straight along -z at `speed` past one collider, from z = 0
function flyPast(col, { speed = 3000, y = 750, touchAt = null, seconds = 3 } = {}) {
  const nm = new NearMiss(); const ev = []; let z = 0;
  for (let t = 0; t < seconds; t += 1 / 60) {
    z -= speed / 60;
    if (touchAt !== null && Math.abs(z - touchAt) < speed / 60) nm.touch(col);
    ev.push(...nm.update(0, y, z, 0, -1, speed, (fn) => fn(col)));
  }
  return ev;
}

test('a close pass fires exactly once, with the measured clearance', () => {
  const ev = flyPast(circle(500 + R + 600, -4000, 500, 2000));
  assert.equal(ev.length, 1);
  assert.ok(Math.abs(ev[0].clearance - 600) < 40, `clearance ${ev[0].clearance}`);
  assert.ok(ev[0].closeness > 0 && ev[0].closeness < 1);
});

test('closer passes score higher closeness', () => {
  const near = flyPast(circle(500 + R + 200, -4000, 500, 2000))[0];
  const far = flyPast(circle(500 + R + 1500, -4000, 500, 2000))[0];
  assert.ok(near.closeness > far.closeness);
});

test('a wide pass is not a near miss', () => {
  assert.equal(flyPast(circle(500 + R + 6000, -4000, 500, 2000)).length, 0);
});

test('an obstacle you touched is not a near miss', () => {
  assert.equal(flyPast(circle(500 + R + 300, -4000, 500, 2000), { touchAt: -4000 }).length, 0);
});

test('obstacles below your altitude do not count', () => {
  assert.equal(flyPast(circle(500 + R + 300, -4000, 500, 300), { y: 750 }).length, 0);
});

test('threading a gap in a wall counts once per wall segment', () => {
  const nm = new NearMiss(); const left = capsule(-3000, -4000, -400, -4000, 60, 2000), right = capsule(400, -4000, 3000, -4000, 60, 2000);
  const ev = []; let z = 0;
  for (let t = 0; t < 3; t += 1 / 60) { z -= 50; ev.push(...nm.update(0, 750, z, 0, -1, 3000, (fn) => { fn(left); fn(right); })); }
  assert.equal(ev.length, 2);
});

test('the threshold grows with speed', () => {
  assert.ok(nearMissThreshold(19000) > nearMissThreshold(3000));
});
