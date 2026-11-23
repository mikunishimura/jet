// No dead time (intensity director) and skill chains (combo multiplier).
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTENSITY, COMBO } from '../src/config.js';
import { Intensity } from '../src/game/Intensity.js';
import { Combo } from '../src/game/Combo.js';

const DT = 1 / 30;

test('intensity: build -> peak -> breather -> build, with the configured lengths', () => {
  const it = new Intensity(INTENSITY, () => 0.5);
  const seen = [];
  for (let t = 0; t < 120; t += DT) { const { changed } = it.update(DT, true); if (changed) seen.push([changed, +t.toFixed(1)]); }
  assert.deepEqual(seen.slice(0, 4).map((s) => s[0]), ['peak', 'breather', 'build', 'peak']);
  assert.ok(Math.abs(seen[0][1] - INTENSITY.firstPeak) < 0.1);
  const peakLen = seen[1][1] - seen[0][1], breathLen = seen[2][1] - seen[1][1];
  assert.ok(Math.abs(peakLen - (INTENSITY.peak[0] + INTENSITY.peak[1]) / 2) < 0.1, `peak ${peakLen}`);
  assert.ok(breathLen >= INTENSITY.breather[0] && breathLen <= INTENSITY.breather[1]);
});

test('intensity: peaks are hotter than builds, breathers hold everything back', () => {
  const r = INTENSITY.rates;
  assert.ok(r.peak.wave > r.build.wave && r.peak.events > r.build.events && r.peak.patience < r.build.patience);
  assert.equal(r.breather.wave, 0); assert.equal(r.breather.events, 0); assert.equal(r.breather.patience, Infinity);
});

test('dead-time guard: never more than maxIdle with nothing to react to (outside a breather)', () => {
  const it = new Intensity(INTENSITY, () => 0.5);
  let forced = [], lastForce = 0;
  for (let t = 0; t < 60; t += DT) {
    const { force } = it.update(DT, false);
    if (force) { forced.push(t); assert.notEqual(it.phase, 'breather'); }
  }
  assert.ok(forced[0] >= INTENSITY.guardFrom - DT, 'not right after launch');
  for (let i = 1; i < forced.length; i++) {
    const gap = forced[i] - forced[i - 1];
    if (gap > INTENSITY.maxIdle + 0.1) assert.ok(gap < INTENSITY.maxIdle + INTENSITY.breather[1] + 0.2, `gap ${gap}`); // only a breather stretches it
  }
  void lastForce;
  // something going on: nothing forced
  const busy = new Intensity(INTENSITY, () => 0.5);
  for (let t = 0; t < 60; t += DT) assert.equal(busy.update(DT, true).force, false);
});

test('combo: stacks raise the multiplier up to the cap', () => {
  const c = new Combo();
  assert.equal(c.mult, 1);
  c.add(); assert.equal(c.mult, 1 + COMBO.step);
  for (let i = 0; i < 40; i++) c.add();
  assert.equal(c.mult, COMBO.max);
});

test('combo: milestones are announced once as you cross them', () => {
  const c = new Combo(), hits = [];
  for (let i = 0; i < 40; i++) { const { milestone } = c.add(); if (milestone) hits.push(milestone); }
  assert.deepEqual(hits, COMBO.announce);
});

test('combo: the window keeps it alive, silence ends it, a hit breaks it', () => {
  const c = new Combo();
  c.add(); c.add();
  for (let t = 0; t < COMBO.window - 0.2; t += DT) assert.equal(c.update(DT), false);
  assert.ok(c.stacks === 2 && c.fill > 0);
  c.add();                                   // refreshed
  let ended = false;
  for (let t = 0; t < COMBO.window + 0.1; t += DT) ended = c.update(DT) || ended;
  assert.ok(ended && c.stacks === 0 && c.mult === 1);
  c.add(); c.add(); c.add();
  assert.equal(c.break(), 1 + 3 * COMBO.step);
  assert.equal(c.mult, 1);
});
