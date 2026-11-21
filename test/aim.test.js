// Mouse aim: moves the camera/crosshair, never the jet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aim } from '../src/game/Aim.js';
import { Player } from '../src/game/Player.js';
import { AIM } from '../src/config.js';

const DT = 1 / 60;

test('mouse right looks right (yaw < 0), mouse up looks up (pitch > 0)', () => {
  const a = new Aim();
  a.update(DT, { lookX: 100, lookY: -50 });
  assert.ok(a.yaw < 0 && a.pitch > 0, `${a.yaw} ${a.pitch}`);
  assert.ok(Math.abs(a.yaw - -100 * AIM.sensitivity) < 1e-9);
});

test('aim is clamped to the look limits', () => {
  const a = new Aim();
  a.update(DT, { lookX: -1e6, lookY: -1e6 });
  assert.equal(a.yaw, AIM.maxYaw);
  assert.equal(a.pitch, AIM.maxPitchUp);
  a.update(DT, { lookX: 1e6, lookY: 1e6 });
  assert.equal(a.yaw, -AIM.maxYaw);
  assert.equal(a.pitch, -AIM.maxPitchDown);
});

test('aim holds while you are looking or firing, then eases back to forward', () => {
  const a = new Aim();
  a.update(DT, { lookX: -300 });
  const y0 = a.yaw;
  for (let t = 0; t < AIM.recenterDelay * 0.8; t += DT) a.update(DT, {});
  assert.equal(a.yaw, y0, 'no drift before the idle delay');
  for (let t = 0; t < 5; t += DT) a.update(DT, {}, true);
  assert.equal(a.yaw, y0, 'firing holds the aim');
  for (let t = 0; t < AIM.recenterDelay + 3; t += DT) a.update(DT, {});
  assert.ok(Math.abs(a.yaw) < 0.01, `eased back: ${a.yaw}`);
});

test('Q / middle mouse snaps back quickly', () => {
  const a = new Aim();
  a.update(DT, { lookX: 400, lookY: 200 });
  a.update(DT, { recenter: true });
  for (let t = 0; t < 0.5; t += DT) a.update(DT, {});
  assert.equal(a.yaw, 0); assert.equal(a.pitch, 0);
});

test('mouse look never changes the trajectory', () => {
  const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
  const base = { left: false, right: false, throttle: true, throttleTap: false, brake: false, up: false, down: false };
  const run = (look) => {
    const p = new Player(() => {}); p.seedTurbulence(5);
    for (let t = 0; t < 4; t += DT) p.update(DT, { ...base, lookX: look ? 250 : 0, lookY: look ? -120 : 0 }, W);
    return [p.heading, p.pitch, p.pos.x, p.pos.y, p.pos.z];
  };
  assert.deepEqual(run(true), run(false));
});
