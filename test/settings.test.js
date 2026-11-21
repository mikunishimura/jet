import test from 'node:test';
import assert from 'node:assert/strict';
import { Settings, DEFAULTS } from '../src/core/Settings.js';

const memStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test('fresh install uses the defaults', () => {
  const s = new Settings(memStore());
  assert.deepEqual(s.values, DEFAULTS);
});

test('changes persist and reload', () => {
  const store = memStore();
  const a = new Settings(store);
  a.set('audio.master', 0.3); a.set('fx.flashes', false); a.set('view.camera', 'cockpit');
  const b = new Settings(store);
  assert.equal(b.get('audio.master'), 0.3);
  assert.equal(b.get('fx.flashes'), false);
  assert.equal(b.get('view.camera'), 'cockpit');
});

test('values are clamped / sanitized, corrupt storage falls back to defaults', () => {
  const s = new Settings(memStore());
  assert.equal(s.set('audio.master', 7), 1);
  assert.equal(s.set('controls.sensitivity', -2), 0.2);
  assert.equal(s.set('view.camera', 'drone-cam'), DEFAULTS.view.camera);
  assert.equal(s.set('audio.muted', 'yes'), false);
  const bad = new Settings(memStore({ 'jetlab.settings.v1': '{"audio":{"master":"loud","sfx":0.4},"view":{"renderScale":99}' }));
  assert.deepEqual(bad.values, DEFAULTS, 'unparseable JSON -> defaults');
  const partial = new Settings(memStore({ 'jetlab.settings.v1': JSON.stringify({ audio: { master: 'loud', sfx: 0.4 }, view: { renderScale: 99 } }) }));
  assert.equal(partial.get('audio.master'), DEFAULTS.audio.master);
  assert.equal(partial.get('audio.sfx'), 0.4);
  assert.equal(partial.get('view.renderScale'), 1.5);
});

test('migrates the old camera preference', () => {
  const s = new Settings(memStore({ 'jetlab.cam': 'cockpit' }));
  assert.equal(s.get('view.camera'), 'cockpit');
});

test('change events fire once per real change; reset restores defaults', () => {
  const s = new Settings(memStore());
  const seen = [];
  s.onChange((k, v) => seen.push([k, v]));
  s.set('fx.shake', 0.5); s.set('fx.shake', 0.5);
  assert.deepEqual(seen, [['fx.shake', 0.5]]);
  s.reset();
  assert.equal(s.get('fx.shake'), DEFAULTS.fx.shake);
  assert.equal(seen.at(-1)[0], '*');
  assert.throws(() => s.set('audio.nope', 1));
});
