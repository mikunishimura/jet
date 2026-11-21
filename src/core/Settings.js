// Player settings: defaults, persistence (localStorage), clamping, change events.
// Pure (storage is injectable) so it is unit-testable in node.

export const DEFAULTS = {
  audio: { muted: false, master: 0.8, engine: 0.8, sfx: 0.9 },
  controls: { sensitivity: 1.0, invertY: false, autoRecenter: true, recenterDelay: 1.6 },
  view: { camera: 'chase', fovOffset: 0, renderScale: 1.0, showFps: false },
  fx: { intensity: 1.0, flashes: true, shake: 1.0, blur: 1.0 },
};

/** allowed ranges / values, used to sanitize anything loaded or set */
export const LIMITS = {
  'audio.master': [0, 1], 'audio.engine': [0, 1], 'audio.sfx': [0, 1],
  'controls.sensitivity': [0.2, 3], 'controls.recenterDelay': [0.5, 5],
  'view.fovOffset': [-15, 15], 'view.renderScale': [0.5, 1.5],
  'fx.intensity': [0, 1], 'fx.shake': [0, 1.5], 'fx.blur': [0, 1],
  'view.camera': ['chase', 'cockpit'],
};

const KEY = 'jetlab.settings.v1';
const clone = (o) => JSON.parse(JSON.stringify(o));

function sanitize(path, v, fallback) {
  const lim = LIMITS[path];
  if (typeof fallback === 'boolean') return typeof v === 'boolean' ? v : fallback;
  if (Array.isArray(lim) && typeof lim[0] === 'string') return lim.includes(v) ? v : fallback;
  if (typeof fallback === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return lim ? Math.min(lim[1], Math.max(lim[0], n)) : n;
  }
  return v ?? fallback;
}

export class Settings {
  /** storage: { getItem, setItem } (defaults to localStorage when available) */
  constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    this.storage = storage;
    this.listeners = new Set();
    this.values = clone(DEFAULTS);
    this.load();
  }
  load() {
    let saved = null;
    try { saved = JSON.parse(this.storage?.getItem(KEY) || 'null'); } catch { saved = null; }
    // migrate the old standalone camera preference
    let legacyCam = null;
    try { legacyCam = this.storage?.getItem('jetlab.cam'); } catch { /* private mode */ }
    const v = clone(DEFAULTS);
    for (const [sec, items] of Object.entries(DEFAULTS)) {
      for (const [k, def] of Object.entries(items)) v[sec][k] = sanitize(`${sec}.${k}`, saved?.[sec]?.[k], def);
    }
    if (!saved && legacyCam) v.view.camera = sanitize('view.camera', legacyCam, v.view.camera);
    this.values = v;
  }
  save() { try { this.storage?.setItem(KEY, JSON.stringify(this.values)); } catch { /* private mode: keep in memory */ } }
  get(path) { const [s, k] = path.split('.'); return this.values[s]?.[k]; }
  set(path, value) {
    const [s, k] = path.split('.');
    if (!(s in DEFAULTS) || !(k in DEFAULTS[s])) throw new Error(`unknown setting ${path}`);
    const v = sanitize(path, value, DEFAULTS[s][k]);
    if (this.values[s][k] === v) return v;
    this.values[s][k] = v;
    this.save();
    for (const fn of this.listeners) fn(path, v, this.values);
    return v;
  }
  reset() {
    this.values = clone(DEFAULTS);
    this.save();
    for (const fn of this.listeners) fn('*', null, this.values);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
