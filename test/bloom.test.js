// Reticle bloom: steady flight tightens the real spread (and the reticle), turning,
// banking, speed, buffet, recoil and hits open it up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOOM } from '../src/config.js';
import { Bloom } from '../src/combat/Bloom.js';

const DT = 1 / 60;
const run = (b, secs, s, each = () => {}) => { for (let t = 0; t < secs; t += DT) { each(t); b.update(DT, s(t)); } return b.value; };
const straight = () => ({ forward: { x: 0, y: 0, z: -1 }, speed01: 0, bank: 0, pitch: 0, hostility: 0 });
const turning = (rate) => (t) => ({ forward: { x: -Math.sin(rate * t), y: 0, z: -Math.cos(rate * t) }, speed01: 0, bank: 0.8, pitch: 0, hostility: 0 });

test('steady, slow flight: tight', () => {
  assert.ok(run(new Bloom(), 2, straight) < 0.02);
});

test('turning hard and banking opens it; it settles once you straighten out', () => {
  const b = new Bloom();
  const hard = run(b, 1.5, turning(0.8));
  assert.ok(hard > 0.6, `hard turn: ${hard.toFixed(2)}`);
  const after = run(b, 1.5, straight);
  assert.ok(after < 0.1, `settled: ${after.toFixed(2)}`);
});

test('speed, buffet, recoil and hits each widen it', () => {
  const fast = run(new Bloom(), 2, () => ({ ...straight(), speed01: 1 }));
  const rough = run(new Bloom(), 2, () => ({ ...straight(), hostility: 1 }));
  assert.ok(fast > 0.1 && fast < 0.3, `top speed: ${fast.toFixed(2)}`);
  assert.ok(rough > 0.45, `hostile band: ${rough.toFixed(2)}`);
  const firing = new Bloom();
  const sustained = run(firing, 1, straight, (t) => { if (Math.floor(t * 11) !== Math.floor((t - DT) * 11)) firing.shot(); });
  assert.ok(sustained > 0.15 && sustained <= BLOOM.recoilMax + 0.01, `recoil: ${sustained.toFixed(2)}`);
  const hit = new Bloom(); hit.hit(20); const kicked = run(hit, 0.15, straight);
  assert.ok(kicked > 0.4, `hit: ${kicked.toFixed(2)}`);
});

test('spread follows the bloom: x1 steady .. x(1 + spreadK) at full bloom', () => {
  const b = new Bloom();
  assert.equal(b.spread(0.004), 0.004);
  b.value = 1;
  assert.ok(Math.abs(b.spread(0.004) - 0.004 * (1 + BLOOM.spreadK)) < 1e-12);
});
