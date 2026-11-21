// Two camera modes:
//  * 'chase' (default): far behind and above the jet, horizon always level
//    (never rolls with the stick); swings smoothly around when you turn.
//  * 'cockpit': POV, banks with the stick.
// Both shake with trauma and widen FOV with speed.
//
// Mouse aim: the view direction = flight direction + aim offset (yaw/pitch).
// The jet's turn is followed with lag; the mouse is applied instantly. The
// rig publishes the UNSHAKEN aim ray relative to the jet (aimOffset + aimDir)
// so weapons can rebuild it in the current frame, even at 19 km/s.
import * as THREE from 'three';
import { FLIGHT, TIERS, FOV, MACH_FACTOR, fovForMach } from '../config.js';

// lookAhead is long so the camera looks along the aim ray: the jet sits below
// the crosshair (third-person shooter framing) instead of under it.
const CHASE = { distance: 36, height: 8, lookAhead: 1200, yawFollow: 4.5, pitchFollow: 3.5, pitchShare: 0.55, speedPull: 8 };

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.roll = 0;
    this.pitchView = 0;
    this.fov = FOV.min;
    this.t = 0;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.camHeading = 0;
    this.camPitch = 0;
    this.snap = true;
    this._target = new THREE.Vector3();
    this.aimDir = new THREE.Vector3(0, 0, -1);   // world unit vector of the crosshair ray
    this.aimOffset = new THREE.Vector3();         // crosshair ray origin relative to the jet
    this.cockpitLocal = new THREE.Quaternion();   // airframe orientation in camera space (head look)
    this._q1 = new THREE.Quaternion(); this._q2 = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
  }
  setMode(mode) { this.mode = mode; this.snap = true; }
  reset() { this.snap = true; }

  update(dt, player, fx, aim = null) {
    const ay = aim ? aim.yaw : 0, ap = aim ? aim.pitch : 0;
    this.t += dt;
    const cam = this.camera;
    const s = player.speedSys;
    const t = this.t;
    const tr = Math.min(3, fx.shake * (fx.prefs?.shake ?? 1));
    const k = tr * tr * 0.5;
    // smooth pseudo-noise shake
    const sx = (Math.sin(t * 37.1) + Math.sin(t * 23.7 + 1.3) * 0.6) * 0.35 * k;
    const sy = (Math.sin(t * 41.3 + 2.1) + Math.sin(t * 19.1) * 0.6) * 0.35 * k;
    const sr = Math.sin(t * 29.3 + 0.7) * 0.018 * k;
    const buffet = (s.level >= 3 ? (s.level - 2) * 0.03 : 0) + s.charge * 0.12;

    if (this.mode === 'chase') {
      if (this.snap) { this.camHeading = player.heading; this.camPitch = player.pitch * CHASE.pitchShare; this.snap = false; }
      // follow heading with lag (shortest angle) so turns show the jet yawing
      let dh = player.heading - this.camHeading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.camHeading += dh * (1 - Math.exp(-CHASE.yawFollow * dt));
      this.camPitch += (player.pitch * CHASE.pitchShare - this.camPitch) * (1 - Math.exp(-CHASE.pitchFollow * dt));
      // view = lagged flight direction + instant mouse aim; orbit the jet
      const vh = this.camHeading + ay;
      const vp = Math.max(-1.35, Math.min(1.35, this.camPitch + ap));
      const ch = Math.cos(vp);
      const dx = -Math.sin(vh) * ch, dy = Math.sin(vp), dz = -Math.cos(vh) * ch;
      const dist = CHASE.distance + CHASE.speedPull * (s.speed / TIERS[TIERS.length - 1].speed);
      const ux = player.pos.x - dx * dist, uy = Math.max(2.5, player.pos.y - dy * dist + CHASE.height), uz = player.pos.z - dz * dist;
      this._target.set(player.pos.x + dx * CHASE.lookAhead, player.pos.y + dy * CHASE.lookAhead + 2, player.pos.z + dz * CHASE.lookAhead);
      // unshaken aim ray (published for weapons + HUD)
      this.aimOffset.set(ux - player.pos.x, uy - player.pos.y, uz - player.pos.z);
      this.aimDir.set(this._target.x - ux, this._target.y - uy, this._target.z - uz).normalize();
      cam.position.set(ux + sx * 0.6, uy + sy * 0.6, uz);
      cam.up.set(0, 1, 0);
      cam.lookAt(this._target); // up = world Y: the horizon never tilts
      this.roll = 0;
      this.cockpitLocal.identity();
    } else {
      const targetRoll = -player.steer * FLIGHT.bankAngle * (0.7 + 0.3 * (s.level / 5));
      this.roll += (targetRoll - this.roll) * (1 - Math.exp(-7 * dt));
      cam.position.set(player.pos.x + sx, player.pos.y + sy + Math.sin(t * 1.3) * 0.6, player.pos.z);
      this.pitchView += (player.pitch - this.pitchView) * (1 - Math.exp(-10 * dt));
      // head look: camera = airframe orientation + aim offset
      const hp = -0.035 + this.pitchView + ap, hh = player.heading + ay;
      this.euler.set(hp + Math.sin(t * 53) * 0.002 * buffet + sy * 0.004, hh + sx * 0.003, this.roll + sr + Math.sin(t * 61) * 0.003 * buffet);
      cam.quaternion.setFromEuler(this.euler);
      // the airframe must NOT turn with the head: cockpit local = camera^-1 * airframe
      this._q1.setFromEuler(this._e.set(hp, hh, this.roll));
      this._q2.setFromEuler(this._e.set(-0.035 + this.pitchView, player.heading, this.roll));
      this.cockpitLocal.copy(this._q1).invert().multiply(this._q2);
      this.aimOffset.set(0, 0, 0);
      this.aimDir.set(0, 0, -1).applyQuaternion(this._q1);
    }
    // FOV follows the Mach number continuously (log scale), plus barrier charge
    const mach = Math.max(1, s.speed * MACH_FACTOR);
    const targetFov = fovForMach(mach) + s.charge * FOV.charge + (player.braking ? FOV.brake : 0) + (this.mode === 'chase' ? FOV.chaseOffset : 0) + (FOV.userOffset || 0);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-4 * dt));
    cam.fov = Math.max(40, Math.min(125, this.fov + fx.fovPunch));
    cam.updateProjectionMatrix();
  }
}
