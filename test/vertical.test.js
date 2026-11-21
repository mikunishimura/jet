// Vertical flight: pitch control, auto-level, ceiling, ground contact,
// altitude bands, 3D straightness and profiled rock colliders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/game/Player.js';
import { SpeedSystem } from '../src/game/SpeedSystem.js';
import { circle, contact } from '../src/game/Collision.js';
import { FLIGHT, DEG, TIERS, ALTITUDE } from '../src/config.js';

const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
const DT = 1 / 60;
const base = { left: false, right: false, throttle: true, throttleTap: false, brake: false, up: false, down: false };
function sim(p, seconds, ctl) { for (let t = 0; t < seconds; t += DT) p.update(DT, { ...base, ...ctl }, W); }
function quiet() { const p = new Player(() => {}); p.seedTurbulence(1); return p; }

test('Space climbs, release auto-levels at the new altitude', () => {
  const p = quiet();
  sim(p, 0.2, {});
  const y0 = p.pos.y;
  sim(p, 0.4, { up: true }); // short: at 3 km/s the ceiling arrives fast
  assert.ok(p.pitch > 6 * DEG, `pitch ${p.pitch / DEG}`);
  assert.ok(p.pos.y > y0 + 40, `y ${p.pos.y}`);
  sim(p, 3, {});
  assert.ok(Math.abs(p.pitch) < 0.5 * DEG, `levels out (${p.pitch / DEG}°)`);
  const y1 = p.pos.y; sim(p, 1, {});
  assert.ok(Math.abs(p.pos.y - y1) < 3, 'holds the new altitude');
});

test('W tap snaps level quickly', () => {
  const p = quiet();
  sim(p, 1, { up: true });
  p.update(DT, { ...base, throttleTap: true }, W);
  sim(p, 0.5, {});
  assert.ok(Math.abs(p.pitch) < 0.5 * DEG, `${p.pitch / DEG}°`);
});

test('containment ceiling cannot be exceeded', () => {
  const p = quiet();
  sim(p, 12, { up: true });
  assert.ok(p.pos.y <= FLIGHT.ceiling + 1e-6, `y=${p.pos.y}`);
});

test('steep dive into the floor is a hard hit; shallow skim is a free scrape', () => {
  const evs = [];
  const p = new Player((t, e) => evs.push([t, e]));
  sim(p, 0.2, {});
  p.pitch = -30 * DEG; p.updateBasis();
  sim(p, 1.5, { down: true });
  assert.ok(evs.some(([t, e]) => t === 'impact' && e.hard && e.tag === 'ground'), 'hard ground impact');
  assert.ok(p.health < 100);

  const evs2 = [];
  const q = new Player((t, e) => evs2.push([t, e]));
  sim(q, 0.2, {});
  q.pos.y = FLIGHT.minAltitude + 1; q.pitch = -4 * DEG; q.updateBasis();
  sim(q, 1, {});
  assert.ok(!evs2.some(([t, e]) => t === 'impact' && e.hard), 'no hard hit');
  assert.equal(q.health, 100);
  assert.ok(q.pos.y >= FLIGHT.minAltitude - 1e-6);
});

test('climbing breaks the straight line just like turning', () => {
  // climb straight to the last tier whose window is wider than 1°, then try the next one
  // while porpoising ±1° in pitch: it must not break
  let wall = 1;
  for (let k = 1; k < TIERS.length && TIERS[k].tolerance >= 1.0; k++) wall = k + 1;
  const s = new SpeedSystem();
  for (let t = 0; t < 30 && s.tier < wall; t += DT) s.update(DT, { heading: 0, pitch: 0, throttle: true, brake: false });
  assert.equal(s.tier, wall);
  for (let t = 0; t < 30; t += DT) s.update(DT, { heading: 0, pitch: Math.sin(t * Math.PI) * 1.0 * DEG, throttle: true, brake: false });
  assert.equal(s.tier, wall);
});

test('taking damage never costs a tier, even heavy hits (no hull cap, no serious-hit drop)', () => {
  const p = quiet();
  p.speedSys.engaged = true; p.speedSys.tier = TIERS.length; p.speedSys.speed = TIERS[TIERS.length - 1].speed;
  const events = [];
  p.emit = (type, e) => events.push(type);
  p.takeDamage(45, 'missile'); p.takeDamage(40, 'plasma');
  assert.equal(p.speedSys.tier, TIERS.length);
  assert.ok(!events.includes('tierDown'));
  assert.ok(p.alive && p.health > 0);
});

test('ground effect charges the barrier faster than radar altitude', () => {
  const timeToII = (rate) => {
    const s = new SpeedSystem(); let t = 0;
    while (s.tier < 2 && t < 10) { s.update(DT, { heading: 0, pitch: 0, throttle: true, brake: false, chargeRate: rate }); t += DT; }
    return t;
  };
  const low = timeToII(1.3), high = timeToII(0.75);
  assert.ok(low < TIERS[1].hold && high > TIERS[1].hold, `low ${low.toFixed(2)}s, high ${high.toFixed(2)}s`);
});

test('altitude bands', () => {
  const p = quiet();
  p.pos.y = ALTITUDE.groundEffect - 5; assert.equal(p.band, 'low');
  p.pos.y = (ALTITUDE.groundEffect + ALTITUDE.radar) / 2; assert.equal(p.band, 'mid');
  p.pos.y = ALTITUDE.radar + 50; assert.equal(p.band, 'high');
});

test('profiled cone collider: narrower near the top, flank normal tilts upward, free above', () => {
  const rAt = (y) => 100 * (1 - y / 200); // cone: r=100 at base, 0 at 200 m
  const c = circle(0, 0, 100, 200, -Infinity, 'mountain', rAt);
  assert.ok(contact(c, 0, 20, 85, 7), 'hits base');
  assert.equal(contact(c, 0, 150, 85, 7), null, 'passes beside the narrow top');
  const h = contact(c, 0, 100, 52, 7);
  assert.ok(h && h.ny > 0.3, `normal ny=${h && h.ny}`);
  assert.equal(contact(c, 0, 215, 0, 7), null, 'over the summit');
});

test('spawn is midway in the obstacle band (where the gameplay is), in the neutral band', () => {
  const p = quiet();
  assert.equal(p.pos.y, (FLIGHT.minAltitude + FLIGHT.obstacleBand) / 2);
  assert.equal(p.band, 'mid');
  assert.ok(FLIGHT.ceiling > 8000, 'ceiling is above the cloud deck');
});
