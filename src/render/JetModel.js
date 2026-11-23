// The player's airframe for the chase camera. The geometry, exhaust, contrail
// nozzles and gun/missile hardpoints come from the active skin (skins.js);
// this class handles transform, bank, thrust flames, contrails and swapping.
import * as THREE from 'three';
import { SKINS, DEFAULT_SKIN } from './skins.js';

const TRAIL_N = 64; // samples per contrail (one per frame)
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class JetModel {
  constructor(scene, skinId = DEFAULT_SKIN) {
    this.scene = scene;
    this.root = new THREE.Group();     // follows position + heading/pitch
    this.body = new THREE.Group();     // banks
    this.root.add(this.body);
    scene.add(this.root);
    this.bank = 0;
    this._v = new THREE.Vector3();
    this.trails = [];
    this.setSkin(skinId);
  }

  /** swap the airframe (live); unknown ids fall back to the default skin */
  setSkin(id) {
    if (!SKINS[id]) id = DEFAULT_SKIN;
    for (const c of [...this.body.children]) {
      this.body.remove(c);
      c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    }
    const built = SKINS[id].build(this.body);
    this.flames = built.flames;
    this.nozzles = built.nozzles;
    this.hardpoints = built.hardpoints;
    this.skinId = id;
    while (this.trails.length < this.nozzles.length) this.trails.push(this.makeTrail());
    this.trails.forEach((tr, k) => { tr.n = 0; tr.used = k < this.nozzles.length; tr.line.visible = false; });
  }

  makeTrail() {
    const pos = new Float32Array(TRAIL_N * 3), col = new Float32Array(TRAIL_N * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true }));
    line.frustumCulled = false;
    this.scene.add(line);
    return { line, pos, col, n: 0, used: true };
  }

  rebase(dx, dz) {
    for (const tr of this.trails) for (let q = 0; q < tr.n; q++) { tr.pos[q * 3] -= dx; tr.pos[q * 3 + 2] -= dz; }
  }

  /** squash = [width, length] scale from the event juice (smear / squash / settle) */
  /**
   * World position of a point on the airframe (model-local coords), from the
   * jet's CURRENT state (position, heading, pitch, bank, squash scale), so
   * muzzles sit exactly on the pods even before this frame's mesh update and
   * whatever the camera angle.
   */
  hardpoint(local, player, out = new THREE.Vector3()) {
    this._qr = this._qr || new THREE.Quaternion();
    this._qb = this._qb || new THREE.Quaternion();
    this._eh = this._eh || new THREE.Euler(0, 0, 0, 'YXZ');
    this._qr.setFromEuler(this._eh.set(player.pitch, player.heading, 0, 'YXZ'));
    this._qb.setFromAxisAngle(Z_AXIS, this.bank);
    return out.copy(local).applyQuaternion(this._qb).multiply(this.root.scale).applyQuaternion(this._qr).add(player.pos);
  }

  update(dt, player, visible, squash = [1, 1]) {
    // bank + scale track the jet even when hidden (cockpit view) so hardpoints stay right
    const targetBank = -player.steer * 0.75 + player.vstick * 0;
    this.bank += (targetBank - this.bank) * (1 - Math.exp(-6 * dt));
    this.root.scale.set(squash[0], 1 / Math.sqrt(squash[0] * squash[1]), squash[1]); // keep volume
    this.root.visible = visible && player.alive;
    for (const tr of this.trails) tr.line.visible = this.root.visible && tr.used;
    if (!this.root.visible) { for (const tr of this.trails) tr.n = 0; return; }
    this.root.position.copy(player.pos);
    this.root.rotation.set(player.pitch, player.heading, 0, 'YXZ');
    // hostile band: the airframe shudders (visual only; hardpoints follow the clean bank)
    const hz = player.hostility || 0;
    this.buffetT = (this.buffetT || 0) + dt;
    const bt = this.buffetT;
    this.body.rotation.z = this.bank + hz * (Math.sin(bt * 23.1) * 0.05 + Math.sin(bt * 7.3 + 1.1) * 0.08);
    this.body.rotation.x = hz * (Math.sin(bt * 19.7 + 0.4) * 0.03 + Math.sin(bt * 5.9) * 0.04);
    const s = player.speedSys;
    const power = 0.45 + 0.12 * s.level + (player.throttle ? 0.3 : 0) + s.charge * 0.4 - (player.braking ? 0.3 : 0);
    for (const f of this.flames) {
      const flick = 0.85 + Math.random() * 0.3;
      f.scale.set(1, 1, Math.max(0.3, power * flick * (3 + s.level)));
      f.material.opacity = Math.min(0.95, 0.35 + power * 0.5);
    }
    // contrails: 1 px fading polylines that record the nozzle path (world-
    // fixed), so a turn draws your actual trajectory behind you
    this.root.updateMatrixWorld();
    const on = s.tier >= 2 ? 1 : 0.35;
    this.nozzles.forEach((n, k) => {
      const tr = this.trails[k];
      const cur = this._v.copy(n).applyMatrix4(this.body.matrixWorld);
      tr.pos.copyWithin(3, 0, (TRAIL_N - 1) * 3);
      tr.pos[0] = cur.x; tr.pos[1] = cur.y; tr.pos[2] = cur.z;
      tr.n = Math.min(tr.n + 1, TRAIL_N);
      for (let q = 0; q < tr.n; q++) {
        const a = (1 - q / tr.n) * 0.75 * on;
        tr.col[q * 4] = 0.42; tr.col[q * 4 + 1] = 0.44; tr.col[q * 4 + 2] = 0.47; tr.col[q * 4 + 3] = a;
      }
      tr.line.geometry.setDrawRange(0, tr.n);
      tr.line.geometry.attributes.position.needsUpdate = true;
      tr.line.geometry.attributes.color.needsUpdate = true;
    });
  }
}
