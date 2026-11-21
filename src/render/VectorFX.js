// Vector "oscilloscope" effects: expanding wireframe shells and rings. Flat
// 1 px lines in ink or red, eased growth, stepped blink-out. They ride in the
// player's frame so they read at any speed. Pooled.
import * as THREE from 'three';

const ringGeo = (() => {
  const n = 48, pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts[i * 3] = Math.cos(a); pts[i * 3 + 1] = Math.sin(a); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return g;
})();
const shellGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 1), 1);

export class VectorFX {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.active = [];
    this.pool = { ring: [], shell: [] };
  }
  get(kind) {
    const p = this.pool[kind];
    if (p.length) return p.pop();
    const mat = new THREE.LineBasicMaterial({ color: 0x15171a, transparent: true, depthWrite: false, fog: true });
    const obj = kind === 'ring' ? new THREE.LineLoop(ringGeo, mat) : new THREE.LineSegments(shellGeo, mat);
    obj.frustumCulled = false;
    obj.renderOrder = 6;
    return obj;
  }
  spawn(kind, x, y, z, r0, r1, life, color, delay = 0, facing = 'camera') {
    if (this.active.length > 80) return;
    const obj = this.get(kind);
    obj.position.set(x, y, z);
    obj.material.color.set(color);
    obj.material.opacity = 1;
    obj.visible = delay >= 0;
    obj.scale.setScalar(r0);
    obj.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    this.scene.add(obj);
    this.active.push({ obj, kind, r0, r1, life, age: Math.min(0, delay), facing, fresh: true });
  }
  ring(x, y, z, r0, r1, life, color = 0x15171a, delay = 0, facing = 'camera') { this.spawn('ring', x, y, z, r0, r1, life, color, delay, facing); }
  shell(x, y, z, r0, r1, life, color = 0x15171a, delay = 0) { this.spawn('shell', x, y, z, r0, r1, life, color, delay, null); }

  update(dt, frameVel) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.age += dt;
      const o = e.obj;
      if (frameVel && !e.fresh) o.position.addScaledVector(frameVel, dt); // born this frame: jet already moved
      e.fresh = false;
      if (e.age < 0) { o.visible = false; continue; }
      const t = e.age / e.life;
      if (t >= 1) { this.scene.remove(o); this.pool[e.kind].push(o); this.active.splice(i, 1); continue; }
      o.visible = true;
      const ease = 1 - Math.pow(1 - t, 3);
      o.scale.setScalar(e.r0 + (e.r1 - e.r0) * ease);
      // stepped blink-out over the last 40%
      o.material.opacity = t < 0.6 ? 1 : (Math.floor(t * 20) % 2 ? 0.25 : 0.9) * (1 - (t - 0.6) / 0.4);
      if (e.facing === 'camera') o.quaternion.copy(this.camera.quaternion);
      else if (e.facing) o.quaternion.copy(e.facing);
      else o.rotation.y += dt * 1.5;
    }
  }
  rebase(dx, dz) { for (const e of this.active) { e.obj.position.x -= dx; e.obj.position.z -= dz; } }
  clear() { for (const e of this.active) { this.scene.remove(e.obj); this.pool[e.kind].push(e.obj); } this.active.length = 0; }
}
