// The hostile band between the clouds and orbit: you can't cruise in it.
// Gravity drags you down (harder the longer you stay), orbit pulls you up past
// 80% of the way to the Kármán line, and the airframe is buffeted throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FLAGS, FLIGHT, SPACE, HOSTILE, TIERS } from '../src/config.js';
import { Player } from '../src/game/Player.js';
import { hostileField, hostileTop, captureAltitude } from '../src/game/hostile.js';

const DT = 1 / 60;
const base = { left: false, right: false, throttle: true, throttleTap: false, brake: false, up: false, down: false };
const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
function withSpace(on, fn) { const prev = FLAGS.space; FLAGS.space = on; try { return fn(); } finally { FLAGS.space = prev; } }
function cruiser(y, tier = 2, seed = 5) {
  const p = new Player(() => {}); p.seedTurbulence(seed);
  p.speedSys.engaged = true; p.speedSys.tier = tier; p.speedSys.speed = TIERS[tier - 1].speed;
  p.pos.y = p.prevPos.y = y;
  return p;
}
const fly = (p, secs, ctl = {}) => { for (let t = 0; t < secs && p.alive; t += DT) p.update(DT, { ...base, ...ctl }, W); };

test('the band: nothing below the floor or past the top, gravity under 80%, capture above', () => {
  for (const space of [true, false]) {
    assert.equal(hostileField(HOSTILE.floor - 1, space).hostility, 0);
    assert.equal(hostileField(FLIGHT.altitude, space).gravity, 0, 'the obstacle band is untouched');
    assert.equal(hostileField(hostileTop(space) + 1, space).hostility, 0);
  }
  assert.equal(hostileTop(true), SPACE.edge);
  assert.equal(hostileTop(false), FLIGHT.earthCeiling);
  const cap = captureAltitude(true);
  assert.equal(cap, HOSTILE.floor + 0.8 * (SPACE.edge - HOSTILE.floor));
  assert.equal(hostileField(cap - 100, true).gravity, 1);
  assert.equal(hostileField(cap - 100, true).capture, 0);
  assert.equal(hostileField(cap + 100, true).capture, 1);
  assert.equal(hostileField(cap + 100, true).gravity, 0);
  assert.equal(captureAltitude(false), Infinity, 'no orbit to fall into with space flight off');
  assert.equal(hostileField(FLIGHT.earthCeiling - 10, false).capture, 0);
  assert.ok(hostileField(SPACE.edge - 100, true).hostility < hostileField(cap + 100, true).hostility, 'orbit calms you as it pulls you up');
});

test('hands off in the band: gravity drags you back under the floor', () => withSpace(true, () => {
  const p = cruiser(30000);
  fly(p, 60);
  assert.ok(p.pos.y < HOSTILE.floor, `still at ${Math.round(p.pos.y)} m`);
  assert.ok(p.pos.y > FLIGHT.minAltitude + 100, 'the pull lets go once you are out of the band');
}));

test('the pull builds with exposure: level flight sinks faster the longer you stay', () => withSpace(true, () => {
  const p = cruiser(35000);
  fly(p, 1); const early = -p.vel.y;
  p.pos.y = 35000; fly(p, 6); p.pos.y = 35000; fly(p, 0.5); const late = -p.vel.y;
  assert.ok(early > 0, 'sinking from the start');
  assert.ok(late > early * 1.4, `early ${early.toFixed(0)} m/s, late ${late.toFixed(0)} m/s`);
  assert.ok(p.exposure > 0.9);
}));

test('a committed climb still gets you through to orbit', () => withSpace(true, () => {
  const p = cruiser(HOSTILE.floor + 500, 3);
  fly(p, 40, { up: true });
  assert.ok(p.pos.y > SPACE.edge, `stuck at ${Math.round(p.pos.y)} m`);
}));

test('past 80% of the band, orbit pulls you up into space hands off', () => withSpace(true, () => {
  const p = cruiser(captureAltitude(true) + 500);
  fly(p, 30);
  assert.ok(p.pos.y > SPACE.edge, `at ${Math.round(p.pos.y)} m`);
}));

test('just under 80%, hands off, you fall back instead', () => withSpace(true, () => {
  const p = cruiser(captureAltitude(true) - 1500);
  fly(p, 8);
  assert.ok(p.pos.y < captureAltitude(true) - 1500, `at ${Math.round(p.pos.y)} m`);
}));

test('space flight off: the whole band up to the ceiling pulls you down', () => withSpace(false, () => {
  const p = cruiser(FLIGHT.earthCeiling - 200);
  fly(p, 40);
  assert.ok(p.pos.y < HOSTILE.floor, `at ${Math.round(p.pos.y)} m`);
}));

test('the buffet breaks your line in the band, not below it', () => withSpace(true, () => {
  const wander = (y) => {
    const p = cruiser(y, 4, 11);
    p.exposure = 1;
    let sum = 0;
    for (let t = 0; t < 4; t += DT) { const h = p.heading; p.update(DT, { ...base, throttle: false }, W); sum += Math.abs(p.heading - h); p.pos.y = y; }
    return { sum, hostility: p.hostility };
  };
  const calm = wander(5000), band = wander(30000);
  assert.equal(calm.hostility, 0);
  assert.ok(band.hostility > 0.9);
  assert.ok(band.sum > calm.sum * 1.3, `calm ${calm.sum.toFixed(3)} band ${band.sum.toFixed(3)}`);
}));

test('the reported velocity includes the pull (player-frame objects ride on it)', () => withSpace(true, () => {
  const p = cruiser(30000);
  fly(p, 2);
  const before = p.pos.y;
  fly(p, DT);
  assert.ok(Math.abs((p.pos.y - before) / DT - p.vel.y) < Math.abs(p.vel.y) * 0.05 + 1);
}));
