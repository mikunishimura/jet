import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { stepFlowFrame } from '../src/render/SpeedLines.js';
import { SPEED_LINES } from '../src/config.js';

const DT = 1 / 60;
const frame = () => ({ d: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(1, 0, 0), w: new THREE.Vector3(0, 1, 0), _r: new THREE.Vector3() });
// velocity direction in camera space when the camera is yawed `yaw` rad away from the flight path
const yawed = (yaw) => new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
const near = (a, b, eps = 1e-6) => a.distanceTo(b) < eps;

test('looking straight (inside the dead zone) is exactly the old camera tunnel', () => {
  for (const yaw of [0, SPEED_LINES.deadzone * 0.9]) {
    const f = frame();
    const k = stepFlowFrame(f, yawed(yaw), DT);
    assert.equal(k, 0);
    assert.ok(near(f.d, new THREE.Vector3(0, 0, -1)) && near(f.u, new THREE.Vector3(1, 0, 0)) && near(f.w, new THREE.Vector3(0, 1, 0)));
  }
});

test('looking away, the streaks run along the velocity, not the view', () => {
  for (const yaw of [Math.PI / 2, -Math.PI / 2, Math.PI * 0.75, Math.PI]) {
    const f = frame(), v = yawed(yaw);
    for (let i = 0; i < 120; i++) stepFlowFrame(f, v, DT);
    assert.ok(near(f.d, v, 1e-6), `yaw ${yaw}`);
    assert.ok(Math.abs(f.w.y) > 0.99, `tube stays upright, w=${f.w.toArray()}`);
  }
});

test('turning the head is smooth: no frame-to-frame jump or flip at any angle', () => {
  const f = frame(), prev = frame();
  for (let i = 0; i <= 600; i++) {
    const yaw = (i / 600) * Math.PI * 0.98;   // sweep to nearly looking backwards
    const v = yawed(yaw).add(new THREE.Vector3(0, 0.3 * Math.sin(i / 50), 0)).normalize(); // with some pitch
    prev.d.copy(f.d); prev.u.copy(f.u);
    stepFlowFrame(f, v, DT);
    assert.ok(f.d.distanceTo(prev.d) < 0.05, `d jumped at step ${i}`);
    assert.ok(f.u.distanceTo(prev.u) < 0.1, `u flipped at step ${i}`);
    assert.ok(Math.abs(f.u.dot(f.d)) < 1e-6 && Math.abs(f.u.length() - 1) < 1e-6 && Math.abs(f.w.length() - 1) < 1e-6);
  }
});

test('flight path along the camera up axis (looking 90 deg down a climb) stays well defined', () => {
  const f = frame();
  for (let i = 0; i < 200; i++) stepFlowFrame(f, new THREE.Vector3(0, 0, -1).lerp(new THREE.Vector3(0, 1, 0), Math.min(1, i / 100)).normalize(), DT);
  for (const v of [f.d, f.u, f.w]) assert.ok(Number.isFinite(v.x + v.y + v.z) && Math.abs(v.length() - 1) < 1e-6);
  assert.ok(near(f.d, new THREE.Vector3(0, 1, 0), 1e-6));
});
