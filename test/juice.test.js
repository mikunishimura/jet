import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, gateFrame, boostFrame, boostEvents, isMilestone, beatFor } from '../src/render/Juice.js';
import { JUICE, TIERS } from '../src/config.js';
const MILESTONES = JUICE.boost.milestones;

const DT = 1 / 120;
const sample = (fn, from, to) => { const out = []; for (let t = from; t <= to + 1e-9; t += DT) out.push({ t, ...fn(t) }); return out; };

test('envelope: instant attack, flat hold, linear fade to zero', () => {
  assert.equal(envelope(-0.01, 0, 0.1, 0.5), 0);
  assert.equal(envelope(0, 0, 0.1, 0.5), 1);
  assert.equal(envelope(0.09, 0, 0.1, 0.5), 1);
  assert.ok(Math.abs(envelope(0.35, 0, 0.1, 0.5) - 0.5) < 1e-9);
  assert.equal(envelope(0.61, 0, 0.1, 0.5), 0);
});

test('gate ("landing"): peaks inside 100 ms and is fully gone by ~0.6 s, like the measured game', () => {
  const s = sample(gateFrame, 0, 1.0);
  const beamPeakT = s.reduce((a, b) => (b.beam > a.beam ? b : a)).t;
  assert.ok(beamPeakT <= 0.1, `beam peaks at ${beamPeakT}`);
  const lastLit = s.filter((f) => f.ring.alpha > 0.01 || f.beam > 0.01 || f.ghost > 0.01).pop().t;
  assert.ok(lastLit >= 0.5 && lastLit <= 0.62, `last visible at ${lastLit}`);
  const live = s.filter((f) => f.active);
  for (let i = 1; i < live.length; i++) assert.ok(live[i].ring.radius >= live[i - 1].ring.radius, 'ring only grows while active');
  assert.equal(gateFrame(2).active, false);
});

test('gate: smear then squash then settle back to scale 1', () => {
  const [sx0, sz0] = gateFrame(0.01).jet;
  assert.ok(sz0 > 1.3 && sx0 < 1, 'smear stretches along the flight axis');
  const [sx1, sz1] = gateFrame(JUICE.gate.smear.smearFor + 0.02).jet;
  assert.ok(sx1 > 1 && sz1 < 1, 'then squashes');
  const [sx2, sz2] = gateFrame(1).jet;
  assert.ok(Math.abs(sx2 - 1) < 1e-6 && Math.abs(sz2 - 1) < 1e-6);
});

test('boost: one white frame at the cut, then straight into the negative', () => {
  const J = JUICE.boost;
  const w = boostFrame(J.cut + 0.001, 3);
  assert.equal(w.white, 1);
  const after = boostFrame(J.cut + J.whiteFrame + 0.001, 3);
  assert.equal(after.white, 0);
  assert.equal(after.negative, 1);
  assert.equal(boostFrame(J.cut - 0.05, 3).negative, 0);
});

test('boost: negative flips on the beat, lasts base+tier beats, always ends positive', () => {
  const J = JUICE.boost;
  for (const tier of MILESTONES) {
    const s = sample((t) => boostFrame(t, tier), 0, 10);
    const flips = s.filter((f, i) => i && f.negative !== s[i - 1].negative);
    const beats = J.beatsBase + MILESTONES.indexOf(tier);
    assert.equal(flips.length, beats + beats % 2, `tier ${tier}`); // in + toggles + out
    for (let i = 1; i < flips.length; i++) assert.ok(Math.abs(flips[i].t - flips[i - 1].t - beatFor(tier)) < 2 * DT);
    assert.equal(s[s.length - 1].negative, 0, 'ends positive');
    assert.ok(s[s.length - 1].done);
  }
});

test('boost: never more than 3 flashes per second at any tier (photosensitivity, WCAG 2.3.1)', () => {
  for (const tier of MILESTONES) {
    const s = sample((t) => boostFrame(t, tier), 0, 10);
    const lum = s.map((f) => (f.white ? 2 : f.negative ? 0 : 1));
    const changes = s.map((f, i) => (i && lum[i] !== lum[i - 1] ? f.t : null)).filter((t) => t !== null);
    for (const t0 of changes) {
      const inWindow = changes.filter((t) => t >= t0 && t < t0 + 1).length;
      assert.ok(inWindow <= 6, `tier ${tier}: ${inWindow} luminance changes in 1 s from ${t0.toFixed(2)}`); // 6 changes = 3 flashes
    }
  }
});

test('boost: swirl grows and dies within its duration; flood stays partial', () => {
  const J = JUICE.boost;
  const a = boostFrame(0.1, 2), b = boostFrame(0.8, 2), c = boostFrame(J.swirl.duration + 0.01, 2);
  assert.ok(b.swirl.radius > a.swirl.radius);
  assert.ok(a.swirl.intensity > b.swirl.intensity && b.swirl.intensity > 0);
  assert.equal(c.swirl.intensity, 0);
  const maxFlood = Math.max(...sample((t) => boostFrame(t, 2), 0, J.cut - 0.01).map((f) => f.flood));
  assert.ok(maxFlood > 0.3 && maxFlood <= J.flood.amount + 1e-9, `flood ${maxFlood}`);
});

test('boostEvents (audio cues) land exactly on the visual flips', () => {
  for (const tier of MILESTONES) {
    const ev = boostEvents(tier);
    const flipsAudio = ev.filter((e) => e.type === 'neg' || e.type === 'pos').map((e) => e.t);
    const s = sample((t) => boostFrame(t, tier), 0, 10);
    const flipsVisual = s.filter((f, i) => i && f.negative !== s[i - 1].negative).map((f) => f.t);
    assert.equal(flipsAudio.length, flipsVisual.length, `tier ${tier} flip count`);
    flipsAudio.forEach((t, i) => assert.ok(Math.abs(t - flipsVisual[i]) <= DT + 1e-9, `tier ${tier} flip ${i}: audio ${t} vs visual ${flipsVisual[i]}`));
    const white = ev.find((e) => e.type === 'white').t;
    assert.equal(boostFrame(white + 1e-6, tier).white, 1, 'white cue starts the white frame');
    assert.equal(ev[0].type, 'break');
    assert.ok(ev.find((e) => e.type === 'neg').first, 'first negative is flagged as the cut');
    assert.equal(ev[ev.length - 1].type, 'end');
  }
});

test('full boost only on milestone tiers; the last tier is always a milestone', () => {
  assert.ok(MILESTONES.length >= 2);
  assert.ok(isMilestone(TIERS.length));
  assert.equal(isMilestone(2), false);
  for (const m of MILESTONES) assert.ok(isMilestone(m));
});

test('tempo rises with Mach but never past 3 flips per second', () => {
  const beats = MILESTONES.map(beatFor);
  for (let i = 1; i < beats.length; i++) assert.ok(beats[i] < beats[i - 1], 'faster at higher tiers');
  for (let t = 1; t <= TIERS.length; t++) assert.ok(beatFor(t) >= 1 / 3 - 1e-9, `tier ${t} beat ${beatFor(t)}`);
});

test('Mach pop (every non-milestone change) and near-miss hit: instant, gone by ~0.6 s', () => {
  for (const J of [JUICE.pop, JUICE.near]) {
    const s = sample((t) => gateFrame(t, J), 0, 1.2);
    const lit = s.filter((f) => f.ring.alpha > 0.01 || f.ghost > 0.01 || f.beam > 0.01);
    assert.ok(lit[0].t <= 0.02);
    assert.ok(lit[lit.length - 1].t <= 0.62, `last lit ${lit[lit.length - 1].t}`);
  }
});
