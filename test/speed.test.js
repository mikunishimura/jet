import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeedSystem } from '../src/game/SpeedSystem.js';
import { TIERS, DEG } from '../src/config.js';

const DT = 1 / 60;
const TOP = TIERS.length;
function run(sys, seconds, controls, headingFn = () => 0, t0 = 0) {
  const events = [];
  for (let t = 0; t < seconds; t += DT) {
    for (const e of sys.update(DT, { heading: headingFn(t), ...controls })) events.push({ ...e, t: t0 + t });
  }
  return events;
}
const totalHold = TIERS.slice(1).reduce((s, t) => s + t.hold, 0);

test('idle until W is pressed once', () => {
  const s = new SpeedSystem();
  run(s, 1, { throttle: false, brake: false });
  assert.equal(s.speed, 0);
  const ev = run(s, 0.1, { throttle: true, brake: false });
  assert.ok(ev.some(e => e.type === 'launch'));
});

test('the first barrier breaks on its own within 1 s of launch; the next ones need W', () => {
  const s = new SpeedSystem();
  const ev = [...run(s, 0.05, { throttle: true, brake: false }), ...run(s, 1.0, { throttle: false, brake: false }, undefined, 0.05)];
  const first = ev.find(e => e.type === 'tierUp');
  assert.ok(first && first.t <= 1.0, `first Mach change at ${first && first.t.toFixed(2)} s`);
  run(s, 10, { throttle: false, brake: false });
  assert.equal(s.tier, 2, 'no further climb without W');
});

test('perfectly straight + W held reaches the top tier in roughly the summed hold time', () => {
  const s = new SpeedSystem();
  const ev = run(s, totalHold + 0.5, { throttle: true, brake: false });
  assert.equal(s.tier, TOP);
  assert.equal(ev.filter(e => e.type === 'tierUp').length, TOP - 1);
});

test('pacing: the first Mach change comes <= 1 s after launch, then one per barrier hold', () => {
  const s = new SpeedSystem();
  const ups = run(s, totalHold + 0.5, { throttle: true, brake: false }).filter(e => e.type === 'tierUp').map(e => e.t);
  assert.ok(ups[0] <= 1.0, `first at ${ups[0].toFixed(2)} s`);
  ups.slice(1).forEach((t, i) => {
    const gap = t - ups[i], hold = TIERS[i + 2].hold;
    assert.ok(Math.abs(gap - hold) < 0.05, `tier ${i + 3}: gap ${gap.toFixed(2)} s vs hold ${hold} s`);
  });
});

test('releasing W keeps the jet flying at its tier but does not climb further', () => {
  const s = new SpeedSystem();
  run(s, 0.05, { throttle: true, brake: false });
  run(s, 10, { throttle: false, brake: false });
  assert.equal(s.tier, 2);
  assert.ok(s.speed > TIERS[1].speed * 0.95);
});

test('weaving: a ±A° weave always clears windows >= 2A wide and never clears one narrower than A', () => {
  // the line re-anchors where you are at each Mach change, so the guarantee is peak-to-peak
  for (const amp of [0.3, 0.5, 0.75, 1.1, 2.3]) {
    let surely = 1, never = TOP + 1;
    for (let k = 1; k < TOP && TIERS[k].tolerance >= 2 * amp; k++) surely = k + 1;
    for (let k = 1; k < TOP; k++) if (TIERS[k].tolerance < amp) { never = k + 1; break; }
    const s = new SpeedSystem();
    run(s, 90, { throttle: true, brake: false }, (t) => Math.sin(t * Math.PI) * amp * DEG);
    assert.ok(s.tier >= surely && s.tier < never, `±${amp}°: tier ${s.tier}, expected ${surely}..${never - 1}`);
  }
});

test('steady slow turn above tolerance prevents charging', () => {
  const s = new SpeedSystem();
  run(s, 30, { throttle: true, brake: false }, (t) => t * 0.5); // 0.5 rad/s turn
  assert.equal(s.tier, 1);
});

test('holding S steps down one tier at a time to tier I and no further', () => {
  const s = new SpeedSystem();
  run(s, totalHold + 0.5, { throttle: true, brake: false });
  assert.equal(s.tier, TOP);
  const ev = run(s, 12, { throttle: false, brake: true });
  assert.equal(s.tier, 1);
  assert.equal(ev.filter(e => e.type === 'tierDown').length, TOP - 1);
});

test('there is no hull cap: nothing but the brake and head-on crashes lowers the ceiling', () => {
  const s = new SpeedSystem();
  assert.equal(s.setCap, undefined);
  assert.equal(s.next, TIERS[1]);
});

test('drop() never goes below tier I', () => {
  const s = new SpeedSystem();
  run(s, 0.01, { throttle: true, brake: false });
  assert.deepEqual(s.drop(), []);
  assert.equal(s.tier, 1);
});
