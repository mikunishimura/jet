// Mouse aim model. Pure: no DOM, no three.js, unit-testable.
//
// yaw/pitch are stored as an offset from the camera's base (radians):
//   yaw > 0 looks left (same sign as heading), pitch > 0 looks up.
// While flying, CameraRig calls hold() every frame with the base's turn, so
// the aim stays fixed in the WORLD: only the mouse moves it, steering never
// does, and it never drifts back to the nose (Q snaps it back on request).
// The jet's trajectory never reads this; only the camera and weapons do.
import { AIM } from '../config.js';

export class Aim {
  constructor(cfg = AIM) { this.cfg = cfg; this.reset(); }
  reset() { this.yaw = 0; this.pitch = 0; this.idle = 0; this.snapping = false; this.worldLock = false; }

  /** the view base turned by (dh, dp): counter it so the crosshair stays fixed in the world */
  hold(dh, dp) {
    const c = this.cfg;
    this.yaw = Math.max(-c.maxYaw, Math.min(c.maxYaw, this.yaw - dh));
    this.pitch = Math.max(-c.maxPitchDown, Math.min(c.maxPitchUp, this.pitch - dp));
  }

  /** ease the aim toward (yaw, pitch) at `rate` 1/s: the auto-fire magnet on a target */
  pull(yaw, pitch, rate, dt) {
    if (this.snapping) return;
    const k = 1 - Math.exp(-rate * dt);
    this.yaw += (yaw - this.yaw) * k; this.pitch += (pitch - this.pitch) * k;
  }

  /**
   * ctl.lookX / ctl.lookY: mouse deltas (px) since last frame.
   * ctl.recenter: snap back to forward. `firing` holds the aim (no auto-recenter).
   */
  update(dt, ctl, firing = false) {
    const c = this.cfg;
    const dx = ctl.lookX || 0, dy = ctl.lookY || 0;
    if (dx || dy) {
      this.yaw -= dx * c.sensitivity;                       // mouse right -> look right
      this.pitch -= dy * c.sensitivity * (c.invertY ? -1 : 1); // mouse up -> look up
      this.idle = 0;
      this.snapping = false;
    } else this.idle += dt;
    if (firing) this.idle = 0;
    if (ctl.recenter) this.snapping = true;
    const rate = this.snapping ? 14 : 0;   // only on request (Q / middle mouse)
    if (rate) {
      const k = Math.exp(-rate * dt);
      this.yaw *= k; this.pitch *= k;
      if (Math.abs(this.yaw) + Math.abs(this.pitch) < 1e-3) { this.yaw = 0; this.pitch = 0; this.snapping = false; }
    }
    this.yaw = Math.max(-c.maxYaw, Math.min(c.maxYaw, this.yaw));
    this.pitch = Math.max(-c.maxPitchDown, Math.min(c.maxPitchUp, this.pitch));
  }
  get active() { return Math.abs(this.yaw) > 0.01 || Math.abs(this.pitch) > 0.01; }
}
