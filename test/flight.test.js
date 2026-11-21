// Full Player flight model (stick + turbulence + tiers) in an empty world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/game/Player.js';
import { TIERS } from '../src/config.js';
const TOP = TIERS.length;

const emptyWorld = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
const DT = 1 / 60;
const idle = { left: false, right: false, throttle: true, throttleTap: false, brake: false };

function fly(seconds, controller, seed) {
  const p = new Player(() => {});
  p.seedTurbulence(seed * 7919);
  let t = 0, nextLook = 0, tap = null, frames = 0;
  const ups = [];
  while (t < seconds && p.speedSys.tier < TOP) {
    let ctl = { ...idle };
    if (controller === 'human' && t >= nextLook) {
      // human-like: glances at the deviation needle every 150 ms and taps
      // for 1-8 frames (17-133 ms) depending on how far off the line it is
      nextLook = t + 0.15;
      const s = p.speedSys;
      if (Math.abs(s.deviation) > s.tolerance * 0.3) {
        tap = s.deviation > 0 ? 'right' : 'left';
        frames = Math.max(1, Math.min(8, Math.round(Math.abs(s.deviation) / s.tolerance * 4)));
      }
    }
    if (tap && frames > 0) { ctl[tap] = true; if (--frames === 0) tap = null; }
    const before = p.speedSys.tier;
    p.update(DT, ctl, emptyWorld);
    t += DT;
    if (p.speedSys.tier > before) ups.push(t);
  }
  return { tier: p.speedSys.tier, t, ups };
}

test('the top tier is reachable against turbulence with human-rate one-frame trim taps', () => {
  let ok = 0;
  for (let seed = 1; seed <= 10; seed++) if (fly(90, 'human', seed).tier === TOP) ok++;
  assert.ok(ok >= 8, `reached the top in ${ok}/10 runs`);
});

test('pacing for a human-rate pilot: first Mach change <= 1 s; the early barriers cost no extra time', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { ups } = fly(90, 'human', seed);
    assert.ok(ups[0] <= 1.0, `seed ${seed}: first change at ${ups[0].toFixed(2)} s`);
    // II -> III and III -> IV take exactly their hold: trimming keeps you on the line
    for (const k of [1, 2]) assert.ok(Math.abs(ups[k] - ups[k - 1] - TIERS[k + 1].hold) < 0.1, `seed ${seed}: gap ${k}`);
  }
});

test('without trimming, gusts keep you out of the top tier (rarely reached within 26 s)', () => {
  let reached = 0;
  for (let seed = 1; seed <= 20; seed++) if (fly(26, 'none', seed).tier === TOP) reached++;
  assert.ok(reached <= 5, `hands-off reached the top in ${reached}/20 runs`);
});
