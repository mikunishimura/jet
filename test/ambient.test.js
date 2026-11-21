import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbientConductor } from '../src/render/Ambient.js';
import { beatFor } from '../src/render/Juice.js';
import { AMBIENT, TIERS } from '../src/config.js';

const DT = 1 / 60;
const base = { speed01: 0.3, level: 2, tier: 2, charge: 0, throttle: true, braking: false, boosting: false, alive: true, bands: null, prefs: { intensity: 1, flashes: true } };
function run(c, seconds, over = {}) { const out = []; for (let t = 0; t < seconds; t += DT) out.push({ t, ...c.update(DT, { ...base, ...over }) }); return out; }

test('the beat follows the Mach tempo (faster at higher tiers)', () => {
  for (const tier of [1, 3, 5]) {
    const c = new AmbientConductor();
    const s = run(c, 6, { tier });
    const beats = s.filter((f, i) => i && f.beat > s[i - 1].beat).map((f) => f.t);
    const gaps = beats.slice(1).map((t, i) => t - beats[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(Math.abs(mean - beatFor(tier)) < 0.02, `tier ${tier}: ${mean.toFixed(3)} vs ${beatFor(tier)}`);
  }
});

test('changing tier keeps the beat phase continuous (no skipped or doubled beat)', () => {
  const c = new AmbientConductor();
  run(c, 1.3, { tier: 1 });
  const before = c.phase;
  const f = c.update(DT, { ...base, tier: 5 });
  assert.ok(Math.abs(f.phase - before) < 0.1, `phase jumped from ${before} to ${f.phase}`);
});

test('the beat pulse is small: never a flash (WCAG: a flash needs >= 10% luminance swing)', () => {
  const c = new AmbientConductor();
  const s = run(c, 4, { tier: 5, prefs: { intensity: 1, flashes: true } });
  const maxPulse = Math.max(...s.map((f) => f.pulse * f.gate));
  assert.ok(maxPulse <= AMBIENT.pulse.amp + 1e-9);
  // the pulse only darkens grid lines that cover < 25% of pixels: screen swing = amp * coverage
  assert.ok(maxPulse * 0.25 < 0.1, `worst-case screen swing ${(maxPulse * 0.25).toFixed(3)}`);
});

test('the ambient layer fades out during the boost negative, at 0 intensity, when dead, or with master 0', () => {
  for (const over of [{ boosting: true }, { prefs: { intensity: 0, flashes: true } }, { alive: false }]) {
    const c = new AmbientConductor();
    run(c, 1);
    const s = run(c, 1.5, over);
    assert.ok(s[s.length - 1].gate < 0.02, `${JSON.stringify(over)} -> gate ${s[s.length - 1].gate}`);
  }
  const c = new AmbientConductor({ ...AMBIENT, master: 0 });
  assert.ok(run(c, 1).pop().gate < 0.02);
});

test('flashes off: the beat pulse stops, the rest of the ambient layer stays', () => {
  const c = new AmbientConductor();
  const s = run(c, 3, { prefs: { intensity: 1, flashes: false } });
  assert.equal(Math.max(...s.map((f) => f.pulse)), 0);
  assert.ok(s[s.length - 1].gate > 0.9);
});

test('the sky progresses toward space only as you climb tiers', () => {
  const vals = [1, 2, 3, 4, 5].map((level) => { const c = new AmbientConductor(); return run(c, 3, { level }).pop().space; });
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] > vals[i - 1], `level ${i + 1}`);
  assert.ok(vals[0] < 0.05 && vals[4] > 0.8, vals.join(', '));
});

test('without audio yet, the engine spectrum model still reacts to throttle, speed and charge', () => {
  const idle = run(new AmbientConductor(), 2, { throttle: false, speed01: 0.05 }).pop();
  const hot = run(new AmbientConductor(), 2, { throttle: true, speed01: 0.9, charge: 0.8 }).pop();
  const sum = (b) => b.reduce((a, v) => a + v, 0);
  assert.ok(sum(hot.bands) > sum(idle.bands) * 1.5);
  for (const v of hot.bands) assert.ok(v >= 0 && v <= 1);
});

test('real audio bands are smoothed, not passed through raw', () => {
  const c = new AmbientConductor();
  run(c, 1, { bands: new Float32Array(AMBIENT.eq.bands) });
  const f = c.update(DT, { ...base, bands: new Float32Array(AMBIENT.eq.bands).fill(1) });
  assert.ok(f.bands[0] > 0 && f.bands[0] < 0.6, `one frame of a full spike -> ${f.bands[0]}`);
});

test('tier count independence: the conductor works for any TIERS length', () => {
  const c = new AmbientConductor();
  assert.doesNotThrow(() => run(c, 0.5, { tier: TIERS.length }));
});
