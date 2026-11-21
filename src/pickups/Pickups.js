// Collectible gadgets. Type table makes adding new ones (shield, ammo,
// overdrive...) a one-entry change.
import * as THREE from 'three';
import { labMaterial, edgeMaterial } from '../render/materials.js';
import { PALETTE, FLIGHT } from '../config.js';
import { segSphere } from '../combat/Projectiles.js';

export const PICKUP_TYPES = {
  repair: {
    label: '+HULL',
    color: PALETTE.heal,
    apply(game) { game.player.heal(40); game.hud.toast('HULL RESTORED +40', 'good'); },
  },
};

export class Pickups {
  constructor(game) { this.game = game; this.list = []; }
  reset() { for (const p of this.list) this.game.scene.remove(p.mesh); this.list.length = 0; }

  spawn(type = 'repair') {
    const g = this.game, p = g.player;
    const def = PICKUP_TYPES[type];
    // find a clear spot ahead
    // placed ~3-4.5 s ahead and a bit to the side, whatever the speed;
    // the collect radius grows with speed so it stays catchable at Mach 100
    const radius = 26 + p.speed * 0.012;
    let pos = null;
    for (let tries = 0; tries < 10 && !pos; tries++) {
      const ahead = 1500 + p.speed * (3 + Math.random() * 1.5), side = (Math.random() - 0.5) * (600 + p.speed * 0.4);
      const c = p.pos.clone().addScaledVector(p.flatForward, ahead).addScaledVector(p.right, side);
      // mostly near your altitude, sometimes low (risky) or high (radar)
      c.y = Math.min(FLIGHT.ceiling - 30, Math.max(15, p.pos.y + (Math.random() - 0.5) * 300));
      if (!g.world.collide(c.x + g.world.origin.x, c.y, c.z + g.world.origin.z, radius + 20)) pos = c;
    }
    if (!pos) return null;
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(6, 0), labMaterial({ color: 0xffffff, contour: 0 }));
    mesh.add(core);
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(core.geometry), edgeMaterial(PALETTE.ink, 1)));
    const cross = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({ color: def.color, fog: true });
    cross.add(new THREE.Mesh(new THREE.BoxGeometry(2.2, 7, 2.2), m), new THREE.Mesh(new THREE.BoxGeometry(7, 2.2, 2.2), m));
    mesh.add(cross);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(13, 0.9, 6, 32), new THREE.MeshBasicMaterial({ color: def.color, fog: true }));
    mesh.add(ring);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 900, 8, 1, true), new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.22, depthWrite: false, fog: true }));
    beam.position.y = 450 - pos.y;
    mesh.add(beam);
    mesh.position.copy(pos);
    const k = radius / 26;
    for (const c of [core, mesh.children[1], cross, ring]) c.scale.setScalar(k);
    g.scene.add(mesh);
    const item = { type, def, mesh, pos: mesh.position, ring, core, cross, t: 0, radius, k };
    this.list.push(item);
    return item;
  }

  update(dt) {
    const g = this.game, p = g.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const it = this.list[i];
      it.t += dt;
      it.core.rotation.y += dt * 2; it.cross.rotation.y -= dt * 3;
      it.ring.rotation.x = Math.PI / 2 + Math.sin(it.t * 2) * 0.3;
      it.ring.scale.setScalar(it.k * (1 + Math.sin(it.t * 6) * 0.08));
      const d = it.pos.distanceTo(p.pos);
      const ahead = new THREE.Vector3().subVectors(it.pos, p.pos).dot(p.flatForward);
      if (p.alive && segSphere(p.prevPos, p.pos, it.pos, it.radius + p.radius)) {
        it.def.apply(g);
        g.audio.pickup();
        g.fx.gate();
        g.particles.vector.ring(it.pos.x, it.pos.y, it.pos.z, 10, 80, 0.4, 0x15171a);
        g.particles.normal.burst(it.pos.x, it.pos.y, it.pos.z, 24, () => ({ x: it.pos.x, y: it.pos.y, z: it.pos.z, rel: true,
          vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 220, vz: (Math.random() - 0.5) * 220,
          life: 0.5, size: 2.4, color: 0x15171a, shape: 1, drag: 2 }));
        g.scene.remove(it.mesh); this.list.splice(i, 1);
      } else if (ahead < -it.radius * 4 - 600 || d > 8000 + p.speed * 8) { g.scene.remove(it.mesh); this.list.splice(i, 1); }
    }
  }
  rebase(dx, dz) { for (const it of this.list) { it.pos.x -= dx; it.pos.z -= dz; } }
}
