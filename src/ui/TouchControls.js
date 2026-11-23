// Touch controls: two floating virtual joysticks (the stick appears where
// your thumb lands) plus a brake and a pause button.
//   left stick   fly: x = bank (A / D), y = climb / dive (Space / Shift).
//                Throttle is automatic: fly straight and the barrier charges.
//   right stick  look + aim (the mouse): a rate stick, the farther the faster.
//                Shooting is automatic (auto-fire), so aiming is all you do.
//   brake        hold: S.     flares: F (manual, 2 charges).     ||  pause / settings.
// Enabled on coarse-pointer (touch-first) devices, or with ?touch in the URL.
// Input.state() reads `axes()`; Game calls update(dt) once per frame.

const DEAD = 0.12;           // stick dead zone (fraction of the radius)
const RADIUS = 56;           // px: full deflection
const LOOK_RATE = 1150;      // "mouse px" per second at full right-stick deflection

const shape = (v) => {       // dead zone, then a soft curve: fine near center, fast at the rim
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  const t = (a - DEAD) / (1 - DEAD);
  return Math.sign(v) * t * (0.35 + 0.65 * t);
};

export function touchPreferred(search = location.search) {
  if (new URLSearchParams(search).has('touch')) return true;
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}

class Stick {
  constructor(zone, side) {
    this.zone = zone; this.id = null; this.x = 0; this.y = 0;
    this.base = document.createElement('div'); this.base.className = `stick-base ${side}`;
    this.knob = document.createElement('div'); this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    zone.appendChild(this.base);
    zone.addEventListener('pointerdown', (e) => {
      if (this.id !== null) return;
      e.preventDefault();
      this.id = e.pointerId; zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      this.ox = e.clientX; this.oy = e.clientY;
      this.base.style.left = `${e.clientX - r.left}px`; this.base.style.top = `${e.clientY - r.top}px`;
      this.base.classList.add('on');
      this.move(e);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === this.id) this.move(e); });
    const end = (e) => { if (e.pointerId === this.id) this.release(); };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  }
  move(e) {
    let dx = (e.clientX - this.ox) / RADIUS, dy = (e.clientY - this.oy) / RADIUS;
    const l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    this.x = dx; this.y = dy;
    this.knob.style.transform = `translate(${dx * RADIUS}px, ${dy * RADIUS}px)`;
  }
  release() {
    this.id = null; this.x = 0; this.y = 0;
    this.knob.style.transform = '';
    this.base.classList.remove('on');
  }
}

export class TouchControls {
  constructor({ onPause } = {}) {
    this.enabled = touchPreferred();
    this.brake = false;
    this.tap = false;
    if (!this.enabled) return;
    document.body.classList.add('touch');
    // keyboard hints make no sense here
    const label = (sel, t) => document.querySelectorAll(sel).forEach((el) => { el.textContent = t; });
    label('#start', '[ tap to launch ]'); label('#restart', '[ fly again ]'); label('.open-settings', '[ settings ]');
    const root = this.root = document.createElement('div');
    root.id = 'touch'; root.className = 'hidden';
    root.innerHTML = `<div class="zone left"></div><div class="zone right"></div>
      <button class="tbtn brake">brake</button><button class="tbtn flares">flares</button><button class="tbtn pause">||</button>`;
    document.body.appendChild(root);
    this.left = new Stick(root.querySelector('.zone.left'), 'left');
    this.right = new Stick(root.querySelector('.zone.right'), 'right');
    const brake = root.querySelector('.brake');
    brake.addEventListener('pointerdown', (e) => { e.preventDefault(); this.brake = true; brake.classList.add('on'); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) brake.addEventListener(ev, () => { this.brake = false; brake.classList.remove('on'); });
    root.querySelector('.pause').addEventListener('click', () => onPause?.());
    root.querySelector('.flares').addEventListener('pointerdown', (e) => { e.preventDefault(); this.flareTap = true; });
    // the first touch on the left stick launches (a W tap)
    this.left.zone.addEventListener('pointerdown', () => { this.tap = true; });
  }

  /** show only while flying (menus need their buttons) */
  show(on) { if (this.enabled) this.root.classList.toggle('hidden', !on); }

  /** per frame: turn the right stick into mouse-look deltas */
  update(dt, input) {
    if (!this.enabled || !this.right) return;
    input.lookX += shape(this.right.x) * LOOK_RATE * dt;
    input.lookY += shape(this.right.y) * LOOK_RATE * dt;
  }

  /** controller fields merged into Input.state() */
  axes() {
    const tap = this.tap; this.tap = false;
    const flares = !!this.flareTap; this.flareTap = false;
    return {
      steerAxis: shape(this.left.x),
      pitchAxis: -shape(this.left.y),
      throttle: true,          // fly straight: the barrier charges by itself
      throttleTap: tap,
      brake: this.brake,
      flares,
    };
  }
}
