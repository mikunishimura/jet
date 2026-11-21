// Terminal-style settings window. Built from SCHEMA: add a setting by adding
// a row here (and its default in core/Settings.js). Changes apply live.
import { SKINS } from '../render/skins.js';
import { SKIN_IDS } from '../config.js';

const pct = (v) => `${Math.round(v * 100)}%`;

export const SCHEMA = [
  { section: 'hangar', items: [
    { key: 'view.skin', type: 'choice', label: 'airframe', options: SKIN_IDS, labels: Object.fromEntries(SKIN_IDS.map((id) => [id, SKINS[id].name])) },
  ] },
  { section: 'audio', items: [
    { key: 'audio.muted', type: 'toggle', label: 'mute', hint: 'm' },
    { key: 'audio.master', type: 'range', label: 'master volume', min: 0, max: 1, step: 0.05, fmt: pct },
    { key: 'audio.engine', type: 'range', label: 'engine & wind', min: 0, max: 1, step: 0.05, fmt: pct },
    { key: 'audio.sfx', type: 'range', label: 'effects', min: 0, max: 1, step: 0.05, fmt: pct },
  ] },
  { section: 'controls', items: [
    { key: 'controls.sensitivity', type: 'range', label: 'mouse sensitivity', min: 0.2, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
    { key: 'controls.invertY', type: 'toggle', label: 'invert mouse y' },
    { key: 'controls.autoRecenter', type: 'toggle', label: 'auto-recenter view' },
    { key: 'controls.recenterDelay', type: 'range', label: 'recenter after', min: 0.5, max: 5, step: 0.1, fmt: (v) => `${v.toFixed(1)} s` },
  ] },
  { section: 'view', items: [
    { key: 'view.camera', type: 'choice', label: 'camera', options: ['chase', 'cockpit'], hint: 'c' },
    { key: 'view.fovOffset', type: 'range', label: 'field of view', min: -15, max: 15, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v}°` },
    { key: 'view.renderScale', type: 'range', label: 'render scale', min: 0.5, max: 1.5, step: 0.05, fmt: pct },
    { key: 'view.showFps', type: 'toggle', label: 'show fps' },
  ] },
  { section: 'lab', items: [
    { key: 'flags.space', type: 'toggle', label: 'space flight', hint: 'orbit',
      title: 'on: climb past 24 km into orbit (asteroids, moons, boost rings). off: stay on earth under the 24 km ceiling. switches as soon as you are below 24 km' },
  ] },
  { section: 'effects', items: [
    { key: 'fx.flashes', type: 'toggle', label: 'flashes & inversion', title: 'turn off for a photosensitivity-safe mode: no color inversion, dimmed white flashes' },
    { key: 'fx.intensity', type: 'range', label: 'screen effects', min: 0, max: 1, step: 0.05, fmt: pct },
    { key: 'fx.shake', type: 'range', label: 'camera shake', min: 0, max: 1.5, step: 0.05, fmt: pct },
    { key: 'fx.blur', type: 'range', label: 'speed blur', min: 0, max: 1, step: 0.05, fmt: pct },
  ] },
];

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class SettingsPanel {
  constructor(settings, { onClose } = {}) {
    this.settings = settings;
    this.onClose = onClose;
    this.root = document.getElementById('settings');
    this.build();
    this.refresh();
    settings.onChange(() => this.refresh());
    addEventListener('keydown', (e) => {
      if (!this.isOpen || e.code !== 'Escape') return;
      e.preventDefault();
      this.onClose?.();
    });
  }
  get isOpen() { return !this.root.classList.contains('hidden'); }

  build() {
    const rows = SCHEMA.map((sec) => {
      const items = sec.items.map((it) => {
        let ctl = '';
        if (it.type === 'range') ctl = `<input type="range" data-key="${it.key}" min="${it.min}" max="${it.max}" step="${it.step}">`;
        else if (it.type === 'toggle') ctl = `<button class="inline" data-key="${it.key}" data-type="toggle"></button>`;
        else if (it.type === 'choice') ctl = it.options.map((o) => `<button class="inline opt" data-key="${it.key}" data-value="${esc(o)}">${esc(it.labels?.[o] ?? o)}</button>`).join('');
        return `<div class="srow"${it.title ? ` title="${esc(it.title)}"` : ''}><span class="slabel">${esc(it.label)}${it.hint ? ` <span class="d">· ${esc(it.hint)}</span>` : ''}</span><span class="sctl">${ctl}</span><span class="sval" data-val="${it.key}"></span></div>`;
      }).join('');
      return `<div class="ssec"><div class="shead"># ${esc(sec.section)}</div>${items}</div>`;
    }).join('');
    this.root.innerHTML = `
      <div class="term wide">
        <div class="titlebar"><span>~/lab/jet/settings</span><span id="s-state">settings</span></div>
        <div class="body">
          ${rows}
          <div class="sfoot">
            <button id="s-resume">[ resume · esc ]</button>
            <button id="s-reset" class="ghost">[ reset defaults ]</button>
          </div>
        </div>
      </div>`;
    this.root.querySelectorAll('input[type=range]').forEach((el) => {
      el.addEventListener('input', () => this.settings.set(el.dataset.key, parseFloat(el.value)));
    });
    this.root.querySelectorAll('button[data-type=toggle]').forEach((el) => {
      el.addEventListener('click', () => this.settings.set(el.dataset.key, !this.settings.get(el.dataset.key)));
    });
    this.root.querySelectorAll('button.opt').forEach((el) => {
      el.addEventListener('click', () => this.settings.set(el.dataset.key, el.dataset.value));
    });
    this.root.querySelector('#s-resume').addEventListener('click', () => this.onClose?.());
    this.root.querySelector('#s-reset').addEventListener('click', () => this.settings.reset());
  }

  refresh() {
    for (const sec of SCHEMA) for (const it of sec.items) {
      const v = this.settings.get(it.key);
      const val = this.root.querySelector(`[data-val="${it.key}"]`);
      if (it.type === 'range') {
        const el = this.root.querySelector(`input[data-key="${it.key}"]`);
        if (el && document.activeElement !== el) el.value = v;
        if (val) val.textContent = it.fmt(v);
      } else if (it.type === 'toggle') {
        const el = this.root.querySelector(`button[data-key="${it.key}"]`);
        el.textContent = v ? '[x] on' : '[ ] off';
        el.classList.toggle('on', !!v);
        if (val) val.textContent = '';
      } else if (it.type === 'choice') {
        this.root.querySelectorAll(`button.opt[data-key="${it.key}"]`).forEach((b) => b.classList.toggle('on', b.dataset.value === v));
      }
    }
    // recenter delay only matters when auto-recenter is on
    const delay = this.root.querySelector('input[data-key="controls.recenterDelay"]');
    if (delay) delay.disabled = !this.settings.get('controls.autoRecenter');
  }

  open(paused) {
    this.root.querySelector('#s-state').textContent = paused ? 'paused' : 'settings';
    this.root.querySelector('#s-resume').textContent = paused ? '[ resume · esc ]' : '[ close · esc ]';
    this.root.classList.remove('hidden');
    this.refresh();
  }
  close() { this.root.classList.add('hidden'); }
}
