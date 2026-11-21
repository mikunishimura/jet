import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { JetModel } from '../src/render/JetModel.js';
import { SKINS, DEFAULT_SKIN } from '../src/render/skins.js';
import { SKIN_IDS } from '../src/config.js';
import { DEFAULTS } from '../src/core/Settings.js';

test('the B-2 Spirit is the default skin (model and settings)', () => {
  assert.equal(DEFAULT_SKIN, 'b2-spirit');
  assert.equal(DEFAULTS.view.skin, 'b2-spirit');
  assert.equal(new JetModel(new THREE.Scene()).skinId, 'b2-spirit');
  assert.match(SKINS['b2-spirit'].name, /b-2 spirit/i);
});

test('every skin builds a jet-sized airframe with weapons and exhausts on it', () => {
  const jet = new JetModel(new THREE.Scene());
  for (const id of SKIN_IDS) {
    jet.setSkin(id);
    const box = new THREE.Box3().setFromObject(jet.body);
    const size = box.getSize(new THREE.Vector3());
    assert.ok(size.x > 12 && size.x < 18, `${id}: span ${size.x.toFixed(1)} m (keeps gameplay identical)`);
    assert.ok(size.z > 4 && size.z < 20, `${id}: length ${size.z.toFixed(1)} m`);
    assert.equal(jet.hardpoints.gun.length, 2); assert.equal(jet.hardpoints.rail.length, 2);
    const grown = box.clone().expandByScalar(0.6);
    for (const hp of [...jet.hardpoints.gun, ...jet.hardpoints.rail]) assert.ok(grown.containsPoint(hp), `${id}: hardpoint on the airframe`);
    assert.ok(jet.flames.length >= 1 && jet.nozzles.length >= 1, `${id}: exhaust + contrails`);
    for (const n of jet.nozzles) assert.ok(n.z > 0, `${id}: contrails come out the back`);

  }
});

test('swapping skins replaces the airframe; unknown ids fall back to the default', () => {
  const jet = new JetModel(new THREE.Scene());
  jet.setSkin('lab-interceptor');
  const n1 = jet.body.children.length;
  jet.setSkin('b2-spirit');
  jet.setSkin('lab-interceptor');
  assert.equal(jet.body.children.length, n1, 'old parts are removed, not stacked');
  jet.setSkin('nope');
  assert.equal(jet.skinId, DEFAULT_SKIN);
});

test('B-2: every detail sits on the wing surface (nothing floating ahead of it)', () => {
  const jet = new JetModel(new THREE.Scene());
  jet.setSkin('b2-spirit');
  jet.body.updateMatrixWorld(true);
  let wing = null;
  jet.body.traverse((o) => { if (o.isMesh && (!wing || o.geometry.attributes.position.count > wing.geometry.attributes.position.count)) wing = o; });
  const { zLE, zTE } = wing.geometry.userData;
  jet.body.traverse((o) => {
    if (!o.isMesh || o === wing) return;
    const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
    assert.ok(c.z >= zLE(c.x) - 0.05, `part at x=${c.x.toFixed(2)} z=${c.z.toFixed(2)} is ahead of the leading edge (${zLE(c.x).toFixed(2)})`);
    assert.ok(c.z <= zTE(c.x) + 1.5, `part at x=${c.x.toFixed(2)} z=${c.z.toFixed(2)} is far behind the trailing edge`);
  });
});
