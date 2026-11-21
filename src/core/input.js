// Keyboard + mouse state. Tracks held keys and edge-triggered presses.
// Mouse look uses Pointer Lock: raw movementX/Y deltas, accumulated per frame.
export class Input {
  constructor(target = window) {
    this.down = new Set();
    this.pressed = new Set();
    this.mouseDown = false;
    this.mouse2Down = false;
    this.virtual = null; // autopilot can inject a virtual controller
    this.lookX = 0; this.lookY = 0;
    this.locked = false;
    document.addEventListener('pointerlockchange', () => { this.locked = !!document.pointerLockElement; });
    target.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX || 0; this.lookY += e.movementY || 0;
    });
    target.addEventListener('keydown', (e) => {
      const k = e.code;
      if (['KeyW','KeyA','KeyS','KeyD','KeyJ','KeyK','KeyQ','KeyF','Space','ShiftLeft','ShiftRight','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(k)) e.preventDefault();
      if (!this.down.has(k)) this.pressed.add(k);
      this.down.add(k);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => { this.down.clear(); this.mouseDown = false; this.mouse2Down = false; });
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouseDown = true; this.pressed.add('Mouse0'); }
      if (e.button === 1) { this.pressed.add('Mouse1'); e.preventDefault(); }
      if (e.button === 2) { this.mouse2Down = true; this.pressed.add('Mouse2'); }
    });
    target.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseDown = false; if (e.button === 2) this.mouse2Down = false; });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  // Abstract controls the game consumes.
  state() {
    if (this.virtual) return this.virtual;
    const d = this.down;
    return {
      left: d.has('KeyA') || d.has('ArrowLeft'),
      right: d.has('KeyD') || d.has('ArrowRight'),
      throttle: d.has('KeyW'),
      throttleTap: this.pressed.has('KeyW'),
      brake: d.has('KeyS'),
      up: d.has('Space') || d.has('ArrowUp'),
      down: d.has('ShiftLeft') || d.has('ShiftRight') || d.has('ArrowDown'),
      gun: d.has('KeyJ') || this.mouseDown,
      missileHold: d.has('KeyK') || this.mouse2Down,   // hold: lock on, release: fire
      flares: this.pressed.has('KeyF'),
      lookX: this.lookX, lookY: this.lookY,
      recenter: this.pressed.has('KeyQ') || this.pressed.has('Mouse1'),
    };
  }
  /** Must be called from a user gesture (click / keydown). Raw deltas when supported. */
  requestLock(el) {
    if (!el?.requestPointerLock || this.locked) return;
    const plain = () => { try { el.requestPointerLock()?.catch?.(() => {}); } catch { /* denied: the click hint stays up */ } };
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true });
      // raw input unsupported on this platform -> retry without it; any other denial is silent
      r?.catch?.((err) => { if (err?.name === 'NotSupportedError') plain(); });
    } catch { plain(); }
  }
  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }
  wasPressed(code) { return this.pressed.has(code); }
  endFrame() { this.pressed.clear(); this.lookX = 0; this.lookY = 0; }
}
