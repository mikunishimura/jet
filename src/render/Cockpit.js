// The player's own airframe in POV: nose spine and two wing propulsors with
// throttle-driven exhaust glow. Parented to the camera with a little lag.
import * as THREE from 'three';
import { labMaterial, edgeMaterial } from './materials.js';
import { PALETTE } from '../config.js';

function outlined(geo, color, emissive = 0x000000) {
  const g = new THREE.Group();
  const mat = labMaterial({ color, emissive, contour: 0 });
  mat.fog = false;
  g.add(new THREE.Mesh(geo, mat));
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMaterial(PALETTE.ink, 1));
  e.material.fog = false;
  g.add(e);
  return g;
}

export class Cockpit {
  constructor(camera) {
    this.root = new THREE.Group();
    this.frame = new THREE.Group(); // scaled airframe
    
    this.root.add(this.frame);
    camera.add(this.root);

    // nose spine
    const nose = new THREE.ConeGeometry(0.8, 9, 6, 1);
    nose.rotateX(-Math.PI / 2);
    const n = outlined(nose, 0xffffff);
    n.position.set(0, -3.9, -9.5);
    n.scale.set(1, 0.5, 1);
    this.frame.add(n);

    // wings + propulsors
    this.pods = [];
    this.flames = [];
    for (const side of [-1, 1]) {
      const wing = new THREE.BufferGeometry();
      wing.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, -3, side * 6.5, -0.3, 1.2, 0, 0, 2.5,
      ]), 3));
      wing.computeVertexNormals();
      const w = outlined(wing, 0xf4f4f4);
      w.children[0].material.side = THREE.DoubleSide;
      w.position.set(side * 0.8, -4.1, -6.5);
      this.frame.add(w);

      const podGeo = new THREE.CylinderGeometry(0.62, 0.8, 3.4, 8, 1);
      podGeo.rotateX(Math.PI / 2);
      const pod = outlined(podGeo, 0x2a2e33);
      pod.position.set(side * 7.2, -4.3, -6.6);
      this.frame.add(pod);
      // intake ring (signal cyan)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.12, 6, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
      ring.position.set(side * 7.2, -4.3, -8.3);
      this.frame.add(ring);
      // hazard stripe
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.83, 0.83, 0.5, 8, 1, true).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
      stripe.position.set(side * 7.2, -4.3, -5.6);
      this.frame.add(stripe);
      // exhaust glow
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.62, 3.5, 10, 1, true).rotateX(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
      flame.position.set(side * 7.2, -4.3, -3.2);
      this.frame.add(flame);
      const core = new THREE.Mesh(new THREE.CircleGeometry(0.55, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: false }));
      core.position.set(side * 7.2, -4.3, -4.88);
      core.rotation.y = Math.PI;
      this.frame.add(core);
      this.flames.push({ flame, core });
      this.pods.push(pod);
    }
    this.root.traverse((o) => { o.renderOrder = 10; o.frustumCulled = false; });
    this.sway = new THREE.Vector2();
    this.t = 0;
  }
  update(dt, player, hit, local = null) {
    this.t += dt;
    const target = new THREE.Vector2(-player.steer * 0.5, (player.braking ? 0.25 : player.throttle ? -0.15 : 0) + player.vstick * 0.35);
    this.sway.lerp(target, 1 - Math.exp(-6 * dt));
    this.root.position.set(this.sway.x, this.sway.y + Math.sin(this.t * 2.1) * 0.05 + hit * (Math.random() - 0.5) * 0.4, 0);
    // airframe stays put while the head (camera) looks around
    this._sway = this._sway || new THREE.Quaternion();
    this._sway.setFromAxisAngle(this._z || (this._z = new THREE.Vector3(0, 0, 1)), player.steer * 0.05);
    if (local) this.root.quaternion.copy(local).multiply(this._sway); else this.root.quaternion.copy(this._sway);
    const s = player.speedSys;
    const power = player.alive ? 0.4 + 0.15 * s.level + (player.throttle ? 0.35 : 0) + s.charge * 0.3 - (player.braking ? 0.3 : 0) : 0;
    for (const f of this.flames) {
      const flick = 0.85 + Math.random() * 0.3;
      f.flame.scale.set(1, 1, Math.max(0.1, power * flick * 1.4));
      f.flame.material.opacity = Math.min(1, power * 0.8);
      f.core.material.opacity = Math.min(1, 0.4 + power * 0.5) * flick;
    }
  }
}
