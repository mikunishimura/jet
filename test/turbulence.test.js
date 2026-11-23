// The jet model's rough-air motion in the hostile band: random, never a loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Turbulence } from '../src/render/turbulence.js';

const DT = 1 / 60;
const run = (tb, secs, k, fn = () => {}) => { for (let t = 0; t < secs; t += DT) fn(tb.update(DT, k), t); };

test('calm air: the jet sits still', () => {
  const tb = new Turbulence(1);
  run(tb, 2, 0, (o) => { for (const v of Object.values(o)) assert.equal(v, 0); });
});

test('rough air moves every axis, within bounds', () => {
  const tb = new Turbulence(2);
  const max = { roll: 0, pitch: 0, yaw: 0, heave: 0, sway: 0 };
  run(tb, 20, 1, (o) => { for (const k in max) max[k] = Math.max(max[k], Math.abs(o[k])); });
  for (const k in max) assert.ok(max[k] > 0, `${k} never moves`);
  assert.ok(max.roll < 0.45, `roll ${max.roll.toFixed(2)} rad`);
  assert.ok(max.pitch < 0.25, `pitch ${max.pitch.toFixed(2)} rad`);
  assert.ok(max.heave < 4, `heave ${max.heave.toFixed(2)} m`);
});

test('air pockets come at irregular moments, mostly as drops', () => {
  const tb = new Turbulence(3);
  const times = []; let drops = 0;
  run(tb, 60, 1, (o, t) => {
    const v = tb.spring.heave.v;
    if (Math.abs(v - (tb._lastV ?? 0)) > 3) { times.push(t); if (v < (tb._lastV ?? 0)) drops++; }
    tb._lastV = v;
  });
  assert.ok(times.length > 40, `${times.length} pockets in 60 s`);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  assert.ok(sd / mean > 0.6, `gap spread ${(sd / mean).toFixed(2)}: too regular`);
  assert.ok(drops > times.length * 0.55, `${drops}/${times.length} drops`);
});

test('no loop: the roll never lines up with a shifted copy of itself', () => {
  const tb = new Turbulence(4);
  const xs = []; run(tb, 30, 1, (o) => xs.push(o.roll));
  const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / n;
  const c = (lag) => { let s = 0, z = 0; for (let i = 0; i + lag < n; i++) { s += (xs[i] - mean) * (xs[i + lag] - mean); z += (xs[i] - mean) ** 2; } return s / z; };
  // any repeat period between 0.5 s and 10 s would show as a strong correlation peak
  for (let lag = 30; lag <= 600; lag += 3) assert.ok(c(lag) < 0.5, `periodic at ${(lag * DT).toFixed(2)} s: ${c(lag).toFixed(2)}`);
});

test('same seed, same ride', () => {
  const a = new Turbulence(7), b = new Turbulence(7);
  for (let i = 0; i < 300; i++) assert.deepEqual({ ...a.update(DT, 0.8) }, { ...b.update(DT, 0.8) });
});
