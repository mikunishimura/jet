// Space flight (FLAGS.space): the flag gate, orbit physics, floating colliders,
// boost rings, the streamed asteroid field and orbital path events.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FLAGS, FLIGHT, SPACE, WORLD_SCALE, TIERS } from '../src/config.js';
import { Player } from '../src/game/Player.js';
import { World, ringCrossed } from '../src/world/World.js';
import { PathHazards } from '../src/world/PathHazards.js';
import { sphere, contact, radiusAt } from '../src/game/Collision.js';
import { clearance } from '../src/game/NearMiss.js';
import { curveRadius, updateCurvature, curveDrop, CURVE_FADE } from '../src/render/curvature.js';
import { orbitFactor, airDensity, farPlane, limbSin } from '../src/space/orbit.js';
import { urlFlag, resolveFlag, FLAG_DEFAULTS } from '../src/core/flags.js';
import { Settings } from '../src/core/Settings.js';
import { SpaceField } from '../src/space/SpaceField.js';
import { BodyLibrary } from '../src/space/bodies.js';
import { spaceMaterials } from '../src/space/materials.js';

const DT = 1 / 60;
const base = { left: false, right: false, throttle: true, throttleTap: false, brake: false, up: false, down: false };
const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
/** run fn with FLAGS.space forced, restoring it afterwards */
function withSpace(on, fn) { const prev = FLAGS.space; FLAGS.space = on; try { return fn(); } finally { FLAGS.space = prev; } }

test('the flag is on by default; URL beats the setting beats the default', () => {
  assert.equal(FLAG_DEFAULTS.space, true);
  assert.equal(new Settings({ getItem: () => null, setItem() {} }).get('flags.space'), true);
  assert.equal(urlFlag('space', '?space=off'), false);
  assert.equal(urlFlag('space', '?space=0'), false);
  assert.equal(urlFlag('space', '?space=on'), true);
  assert.equal(urlFlag('space', '?god'), null);
  assert.equal(resolveFlag('space', { search: '?space=off', setting: true }), false);
  assert.equal(resolveFlag('space', { search: '', setting: false }), false);
  assert.equal(resolveFlag('space', { search: '' }), true);
});

test('flag off: the 24 km earth ceiling, no space band, climbing pins at the ceiling', () => withSpace(false, () => {
  assert.equal(FLIGHT.ceiling, FLIGHT.earthCeiling);
  const p = new Player(() => {}); p.seedTurbulence(3);
  p.pos.y = FLIGHT.earthCeiling - 500;
  let top = 0;
  for (let t = 0; t < 3; t += DT) { p.update(DT, { ...base, up: true }, W); top = Math.max(top, p.pos.y); }
  assert.equal(top, FLIGHT.earthCeiling, 'never past the ceiling');
  // the hostile band's gravity keeps tugging you off it while you hold climb
  assert.ok(p.pos.y > FLIGHT.earthCeiling - 100, `y=${p.pos.y}`);
  assert.equal(p.band, 'high');
}));

test('flag on: you climb past 24 km into orbit, up to the orbit ceiling', () => withSpace(true, () => {
  assert.equal(FLIGHT.ceiling, SPACE.ceiling);
  const p = new Player(() => {}); p.seedTurbulence(4);
  p.pos.y = FLIGHT.earthCeiling - 500;
  for (let t = 0; t < 3; t += DT) p.update(DT, { ...base, up: true }, W);
  assert.ok(p.pos.y > FLIGHT.earthCeiling + 1000, `y=${p.pos.y}`);
  p.pos.y = SPACE.edge + 1000;
  assert.equal(p.band, 'space');
  assert.equal(p.chargeRate, SPACE.chargeRate);
  p.pos.y = SPACE.ceiling - 200;
  for (let t = 0; t < 3; t += DT) p.update(DT, { ...base, up: true }, W);
  assert.equal(p.pos.y, SPACE.ceiling);
}));

test('vacuum: gusts fade to the solar-wind share above the air', () => withSpace(true, () => {
  // same gust seed, same tier: heading drift in orbit is a fraction of the drift in air
  const drift = (y) => {
    const p = new Player(() => {}); p.seedTurbulence(9);
    p.speedSys.engaged = true; p.speedSys.tier = 4; p.pos.y = y;
    let sum = 0;
    for (let t = 0; t < 6; t += DT) { const h = p.heading; p.update(DT, { ...base, throttle: false }, W); sum += Math.abs(p.heading - h); p.pos.y = y; }
    return sum;
  };
  const air = drift(5000), vac = drift(100000);
  assert.ok(Math.abs(vac / air - SPACE.turbulence) < 0.02, `ratio ${(vac / air).toFixed(3)}`);
}));

test('the sky / air / far-plane helpers leave earth untouched', () => {
  for (const alt of [0, 8000, FLIGHT.earthCeiling]) {
    assert.equal(orbitFactor(alt), 0);
    assert.equal(airDensity(alt), 1);
    assert.equal(farPlane(alt), 140000);
  }
  assert.equal(orbitFactor(SPACE.edge), 1);
  assert.equal(airDensity(SPACE.edge), 0);
  assert.ok(farPlane(SPACE.ceiling) > 500000);
  assert.ok(limbSin(SPACE.ceiling, curveRadius(SPACE.ceiling)) < -0.7, 'from orbit the planet sits well below you');
});

test('curvature: the earth curve is unchanged up to 24 km, then the planet keeps shrinking', () => {
  assert.ok(Math.abs(curveRadius(FLIGHT.earthCeiling) - 300e3) < 1);
  assert.ok(Math.abs(curveRadius(SPACE.ceiling) - SPACE.curveRadius) < 1);
  let prev = Infinity;
  for (let a = 0; a <= SPACE.ceiling; a += 5000) { const r = curveRadius(a); assert.ok(r <= prev + 1e-6); prev = r; }
  // free-flying things above the fade band are not bent (asteroids ahead are where they look)
  updateCurvature(90000);
  const saved = CURVE_FADE.value.clone();
  CURVE_FADE.value.set(26000, 52000);
  assert.ok(curveDrop(20000, 0, 5000) > 1000, 'the planet shell bends');
  assert.equal(curveDrop(20000, 0, 90000), 0, 'orbit does not');
  CURVE_FADE.value.copy(saved);
});

test('floating sphere colliders: 3D contact, cross-section, clearance above and below', () => {
  const c = sphere(0, 1000, 0, 100);
  assert.equal(contact(c, 0, 1200, 0, 7), null, 'clear above');
  const h = contact(c, 0, 1095, 0, 7);
  assert.ok(h && h.ny > 0.99 && Math.abs(h.depth - 12) < 1e-9, 'hit from above pushes up');
  assert.ok(Math.abs(radiusAt(c, 1060) - 80) < 1e-9);
  assert.equal(radiusAt(c, 1101), 0);
  assert.ok(Math.abs(clearance(c, 0, 1150, 0, 7) - 43) < 1e-9, 'passing over it is a near miss');
  // the player slides off over the top instead of being shoved sideways
  const p = new Player(() => {}); p.pos.set(0, 1095, 0); p.invuln = 1;
  p.resolveContact(h);
  assert.ok(p.pos.y > 1100 && Math.abs(p.pos.x) < 1e-9);
});

test('ring trigger: fires when the path crosses the disk, not beside it or parallel to it', () => {
  const t = { kind: 'ring', x: 0, y: 500, z: -1000, nx: 0, ny: 0, nz: -1, r: 60 };
  assert.ok(ringCrossed(t, 0, 500, -900, 0, 500, -1100));
  assert.ok(ringCrossed(t, 40, 530, -990, 40, 530, -1010));
  assert.ok(!ringCrossed(t, 80, 500, -990, 80, 500, -1010), 'outside the ring');
  assert.ok(!ringCrossed(t, 0, 500, -900, 0, 500, -990), 'not there yet');
  assert.ok(!ringCrossed(t, 0, 500, -900, 50, 500, -900), 'parallel');
});

function orbitWorld(seed = 5) {
  const w = new World(new THREE.Scene(), seed);
  const space = { library: new BodyLibrary(11), materials: spaceMaterials(w) };
  return { w, space };
}

test('asteroid field: only streams in orbit, is deterministic, and frees everything below', () => {
  const { w, space } = orbitWorld();
  const f = w.addLayer(new SpaceField(w, space.materials, space.library));
  f.reset(5);
  w.update(0, 0, 0, -1, 1, 0, 10000);
  assert.equal(f.chunks.size, 0, 'nothing on earth');
  for (let i = 0; i < 400 && f.chunks.size < 20; i++) w.update(0, 0, 0, -1, 1, 0, 90000);
  assert.ok(f.chunks.size >= 20, `${f.chunks.size} columns`);
  const one = [...f.chunks.values()][0];
  const sig = (c) => c.colliders.map((k) => `${k.x.toFixed(1)},${k.y.toFixed(1)},${k.r.toFixed(1)}`).join('|');
  const before = sig(one);
  for (const k of one.colliders) {
    assert.ok(k.y - k.r > SPACE.field.floor - 4000 && k.y + k.r < SPACE.field.top + 12000, `rock at ${k.y}`);
  }
  // rebuild the same column in a fresh field: identical rocks
  const g = orbitWorld();
  const f2 = g.w.addLayer(new SpaceField(g.w, g.space.materials, g.space.library)); f2.reset(5);
  assert.equal(sig(f2.buildColumn(one.cx, one.cz)), before);
  // the field collides like terrain (a query at a rock's center hits it)
  const rock = [...f.chunks.values()].flatMap((c) => c.colliders)[0];
  if (rock) assert.ok(w.collide(rock.x, rock.y, rock.z, 7));
  w.update(0, 0, 0, -1, 1, 0, SPACE.field.dropBelow - 1);
  assert.equal(f.chunks.size, 0, 'freed on the way down');
});

test('orbital path events: at your altitude, ahead, and rings you fly straight through', () => {
  const { w, space } = orbitWorld(7);
  const hz = new PathHazards(w);
  const p = withSpace(true, () => new Player(() => {}));
  p.speedSys.engaged = true; p.speedSys.tier = 3; p.speedSys.speed = TIERS[2].speed;
  p.pos.y = 90000;
  assert.equal(hz.inOrbit(p), false, 'no space module, no orbital events');
  hz.space = space;
  assert.equal(hz.inOrbit(p), true);
  assert.ok(hz.spawnOrbit(p, 0, 'ringRun'));
  const item = hz.items.at(-1);
  assert.equal(item.triggers.length, 3);
  for (const t of item.triggers) {
    assert.ok(Math.abs(t.y - 90000) < 20 * WORLD_SCALE, `ring at ${t.y}`);
    assert.ok(t.z < 0, 'ahead of you');
  }
  // fly straight down -Z at 90 km: all three rings fire
  const out = [];
  const end = Math.min(...item.triggers.map((t) => t.z)) - 1000;
  for (let z = 0; z > end; z -= 400) w.crossedTriggers(0, z, 0, z - 400, out, 90000, 90000);
  assert.equal(out.filter((t) => t.type === 'ring').length, 3);
  // a moonlet / belt carry floating colliders near your altitude
  p.pos.z -= 300000; // fly on: events never stack on one another
  assert.ok(hz.spawnOrbit(p, 0.5, 'belt'));
  const belt = hz.items.at(-1);
  assert.ok(belt.colliders.length > 30 && belt.colliders.every((c) => Math.abs(c.y - 90000) < 600 * WORLD_SCALE));
  hz.clearOrbit();
  assert.equal(hz.items.length, 0);
});
