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

test('the aim never drifts back to the nose on its own', () => {
  const a = new Aim();
  a.update(DT, { lookX: -300 });
  const y0 = a.yaw;
  for (let t = 0; t < 30; t += DT) a.update(DT, {});
  assert.equal(a.yaw, y0, 'only the mouse (or Q) moves it');
});

test('steering never moves the aim: it stays fixed in the world while the jet turns', async () => {
  const THREE = await import('three');
  const { CameraRig } = await import('../src/render/CameraRig.js');
  const { Player } = await import('../src/game/Player.js');
  const rig = new CameraRig(new THREE.PerspectiveCamera());
  const p = new Player(() => {});
  const a = new Aim(); a.worldLock = true;
  const fx = { shake: 0, fovPunch: 0, prefs: {} };
  rig.update(DT, p, fx, a);
  const before = rig.aimDir.clone();
  for (let t = 0; t < 2; t += DT) { p.heading += 0.6 * DT; p.updateBasis(); rig.update(DT, p, fx, a); }  // a hard turn
  assert.ok(rig.aimDir.angleTo(before) < 0.01, `aim swung ${(rig.aimDir.angleTo(before) * 57.3).toFixed(2)} deg with the jet`);
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

test('engaged: the crosshair holds its world direction while the view base turns under it', async () => {
  const { Aim } = await import('../src/game/Aim.js');
  const a = new Aim();
  a.yaw = 0.3; a.pitch = 0.1;
  a.hold(0.5, -0.05);              // the jet (view base) turned 0.5 rad left, nosed down
  assert.ok(Math.abs(a.yaw - (-0.2)) < 1e-12 && Math.abs(a.pitch - 0.15) < 1e-12, 'base + offset unchanged');
  a.hold(10, 0);                   // never past the look limits
  assert.ok(a.yaw >= -a.cfg.maxYaw - 1e-12);
});

test('auto-fire magnet: eases toward the target, never while snapping back', async () => {
  const { Aim } = await import('../src/game/Aim.js');
  const a = new Aim();
  for (let i = 0; i < 120; i++) a.pull(0.4, -0.1, 3.2, 1 / 60);
  assert.ok(Math.abs(a.yaw - 0.4) < 0.02 && Math.abs(a.pitch + 0.1) < 0.01);
  a.snapping = true; const y = a.yaw;
  a.pull(0, 0, 3.2, 1 / 60);
  assert.equal(a.yaw, y);
});
