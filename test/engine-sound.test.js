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
