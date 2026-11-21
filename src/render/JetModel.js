// The player's airframe for the chase camera. Monochrome lab style: white
// skin, ink outlines, dark engine pods; exhaust and line contrails read on white.
import * as THREE from 'three';
import { labMaterial, edgeMaterial } from './materials.js';
import { PALETTE } from '../config.js';

function outlined(geo, color, threshold = 25) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, labMaterial({ color, contour: 0 })));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), edgeMaterial(PALETTE.ink, 1)));
  return g;
}
function tri(points) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  g.computeVertexNormals();
  return g;
}

const TRAIL_N = 64;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// gun muzzles = front of the engine pods; missile rails under the wings (model-local)
export const HARDPOINTS = {
  gun: [new THREE.Vector3(-3.3, -0.55, -0.35), new THREE.Vector3(3.3, -0.55, -0.35)],
  rail: [new THREE.Vector3(-2.2, -0.95, 0.9), new THREE.Vector3(2.2, -0.95, 0.9)],
}; // samples per contrail (one per frame)

export class JetModel {
  constructor(scene) {
    this.root = new THREE.Group();     // follows position + heading/pitch
    this.body = new THREE.Group();     // banks
    this.root.add(this.body);
    scene.add(this.root);
    const b = this.body;

    // fuselage (nose toward -Z)
    const fus = new THREE.CylinderGeometry(0.95, 1.15, 9, 8, 1); fus.rotateX(Math.PI / 2);
    b.add(outlined(fus, 0xffffff));
    const nose = new THREE.ConeGeometry(0.95, 5.5, 8, 1); nose.rotateX(-Math.PI / 2); nose.translate(0, 0, -7.25);
    b.add(outlined(nose, 0xffffff));
    const tail = new THREE.ConeGeometry(1.15, 2.4, 8, 1, true); tail.rotateX(Math.PI / 2); tail.translate(0, 0, 5.7);
    b.add(outlined(tail, 0x3a3e44));
    // canopy
    const canopy = new THREE.SphereGeometry(0.75, 10, 6); canopy.scale(1, 0.7, 2.6); canopy.translate(0, 0.8, -3.2);
    b.add(outlined(canopy, 0x2a2d31, 40));
    // delta wings (double-sided by duplicating winding)
    for (const s of [-1, 1]) {
      const w = tri([0, 0, -2.5, s * 7.2, -0.25, 3.6, 0, 0, 3.8, 0, 0, -2.5, 0, 0, 3.8, s * 7.2, -0.25, 3.6]);
      b.add(outlined(w, 0xf4f4f4, 1));
      const fin = tri([s * 0.6, 0.6, 2.2, s * 1.4, 3.6, 4.6, s * 0.6, 0.6, 4.6, s * 0.6, 0.6, 2.2, s * 0.6, 0.6, 4.6, s * 1.4, 3.6, 4.6]);
      b.add(outlined(fin, 0xf4f4f4, 1));
    }
    // engine pods + exhaust
    this.flames = [];
    this.nozzles = [];
    for (const s of [-1, 1]) {
      const pod = new THREE.CylinderGeometry(0.62, 0.75, 4.4, 10, 1); pod.rotateX(Math.PI / 2); pod.translate(s * 3.3, -0.55, 2.0);
      b.add(outlined(pod, 0x2a2d31));
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1, 10, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
      flame.position.set(s * 3.3, -0.55, 4.2);
      b.add(flame);
      const core = new THREE.Mesh(new THREE.CircleGeometry(0.5, 14), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      core.position.set(s * 3.3, -0.55, 4.21);
      b.add(core);
      this.flames.push(flame);
      this.nozzles.push(new THREE.Vector3(s * 3.3, -0.55, 5.0));
    }
    this.bank = 0;
    this._v = new THREE.Vector3();
    this.trails = this.nozzles.map(() => {
      const pos = new Float32Array(TRAIL_N * 3), col = new Float32Array(TRAIL_N * 4);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true }));
      line.frustumCulled = false;
      scene.add(line);
      return { line, pos, col, n: 0 };
    });
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
    for (const tr of this.trails) tr.line.visible = this.root.visible;
    if (!this.root.visible) { for (const tr of this.trails) tr.n = 0; return; }
    this.root.position.copy(player.pos);
    this.root.rotation.set(player.pitch, player.heading, 0, 'YXZ');
    this.body.rotation.z = this.bank;
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
