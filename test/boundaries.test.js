// Ceiling / floor pinning, gun hardpoints, planet curvature.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player } from '../src/game/Player.js';
import { JetModel, HARDPOINTS } from '../src/render/JetModel.js';
import { curveRadius, updateCurvature, curveDrop } from '../src/render/curvature.js';
import { FLIGHT, DEG } from '../src/config.js';

const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
const DT = 1 / 60;
const base = { left: false, right: false, throttle: true, throttleTap: false, brake: false, up: false, down: false };

test('pinned at the ceiling while holding climb: no upward velocity (enemies would drift up)', () => {
  const p = new Player(() => {}); p.seedTurbulence(1);
  for (let t = 0; t < 40 && p.pos.y < FLIGHT.ceiling; t += DT) p.update(DT, { ...base, up: true }, W);
  assert.equal(p.pos.y, FLIGHT.ceiling);
  for (let t = 0; t < 2; t += DT) {
    p.update(DT, { ...base, up: true }, W);
    assert.equal(p.vel.y, 0, 'vertical velocity while pinned');
    assert.equal(p.pitch, 0, 'nose cannot point into the ceiling');
  }
});

test('resting on the floor while holding dive: no downward velocity, no scrape spam', () => {
  const events = [];
  const p = new Player((type, e) => events.push([type, e])); p.seedTurbulence(2);
  p.pos.y = FLIGHT.minAltitude + 2; p.pitch = -3 * DEG; p.updateBasis();
  for (let t = 0; t < 3; t += DT) p.update(DT, { ...base, down: true }, W);
  assert.ok(p.pos.y >= FLIGHT.minAltitude - 1e-9);
  assert.equal(p.vel.y, 0);
  assert.equal(p.pitch, 0);
  const scrapes = events.filter(([t]) => t === 'impact').length;
  assert.ok(scrapes <= 1, `${scrapes} impact events`);
  assert.equal(p.health, 100);
});

test('gun hardpoints sit on the airframe at any heading/pitch (left gun on the left)', () => {
  const jet = new JetModel(new THREE.Scene());
  for (const [h, pitch] of [[0, 0], [1.2, 0.3], [-2.5, -0.4], [Math.PI, 0.1]]) {
    const p = new Player(() => {});
    p.heading = h; p.pitch = pitch; p.pos.set(100, 500, -40); p.updateBasis();
    const L = jet.hardpoint(HARDPOINTS.gun[0], p), R = jet.hardpoint(HARDPOINTS.gun[1], p);
    for (const [hp, w] of [[L, HARDPOINTS.gun[0]], [R, HARDPOINTS.gun[1]]]) {
      assert.ok(Math.abs(hp.distanceTo(p.pos) - w.length()) < 1e-6, 'rigid offset');
    }
    const side = R.clone().sub(L).dot(p.right);
    assert.ok(side > 6, `right gun is to the right (${side.toFixed(2)})`);
  }
});

test('curvature: almost flat on the floor, clearly round near the ceiling', () => {
  const rFloor = curveRadius(26), rHigh = curveRadius(FLIGHT.ceiling);
  assert.ok(rFloor > 2e6 && rHigh < 4e5 && rFloor > rHigh, `${rFloor} ${rHigh}`);
  updateCurvature(26);
  const lowDrop = curveDrop(20000, 0);    // 20 km away, seen from the floor
  updateCurvature(FLIGHT.ceiling);
  const highDrop = curveDrop(100000, 0);  // 100 km away, seen from the ceiling
  assert.ok(lowDrop < 120, `floor: ${lowDrop.toFixed(0)} m at 20 km`);
  assert.ok(highDrop > 10000, `ceiling: ${highDrop.toFixed(0)} m at 100 km`);
});
