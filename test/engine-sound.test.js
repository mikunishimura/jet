// Engine sound presets: the B-2 gets the ion drive, the lab interceptor the classic jet,
// the player can pick either, and the choice survives sanitizing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKINS } from '../src/render/skins.js';
import { Settings } from '../src/core/Settings.js';
import { Audio, ENGINE_PRESETS } from '../src/audio/Audio.js';

const mem = () => { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };

test('each airframe names an engine sound', () => {
  assert.equal(SKINS['b2-spirit'].engine, 'ion');
  assert.equal(SKINS['lab-interceptor'].engine, 'jet');
  for (const s of Object.values(SKINS)) assert.ok(ENGINE_PRESETS.includes(s.engine));
});

test('setting: auto by default, ion / jet allowed, anything else falls back', () => {
  const st = new Settings(mem());
  assert.equal(st.get('audio.engineSound'), 'auto');
  st.set('audio.engineSound', 'jet'); assert.equal(st.get('audio.engineSound'), 'jet');
  st.set('audio.engineSound', 'warp'); assert.notEqual(st.get('audio.engineSound'), 'warp');
});

test('Audio.setEngine works before the audio context exists and rejects unknown presets', () => {
  const a = new Audio();
  a.setEngine('ion'); assert.equal(a.engine, 'ion');
  a.setEngine('nope'); assert.equal(a.engine, 'jet');
});

import { EngineSurge } from '../src/audio/EngineSurge.js';
import { ENGINE_SURGE } from '../src/config.js';

const DT = 1 / 60;
const cruise = (s, secs, speed = 1, charge = 0) => { for (let t = 0; t < secs; t += DT) s.update(DT, speed, charge); return s.gain; };

test('surge: loud right after a Mach increase, held, then a smooth glide down to cruise', () => {
  const s = new EngineSurge();
  cruise(s, 10);
  s.kick();
  assert.equal(cruise(s, ENGINE_SURGE.hold * 0.9), 1, 'held at full');
  const g = []; for (let t = 0; t < 8; t += 0.5) g.push(cruise(s, 0.5));
  for (let i = 1; i < g.length; i++) assert.ok(g[i] <= g[i - 1] + 1e-9, 'never jumps back up while cruising');
  assert.ok(g[0] - g[1] < 0.25, 'smooth, not a cut');
  assert.ok(Math.abs(g[g.length - 1] - ENGINE_SURGE.floor) < 0.03, `settles near the floor: ${g[g.length - 1].toFixed(2)}`);
});

test('surge: accelerating again brings it back up; charging builds toward the next Mach', () => {
  const s = new EngineSurge();
  cruise(s, 12);
  const quiet = s.gain;
  let v = 1; for (let t = 0; t < 0.8; t += DT) { v *= 1 + 0.4 * DT; s.update(DT, v); }   // +40 %/s
  assert.ok(s.gain > quiet + 0.4, `accelerating: ${quiet.toFixed(2)} -> ${s.gain.toFixed(2)}`);
  const c = new EngineSurge(); cruise(c, 12);
  const charged = cruise(c, 2, 1, 1);
  assert.ok(charged > quiet + 0.2 && charged < 1, `charging: ${charged.toFixed(2)}`);
});
