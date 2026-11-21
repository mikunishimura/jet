// Camera-space streaks that sell velocity. Invisible at tier I, a blizzard at V.
import * as THREE from 'three';

export class SpeedLines {
  constructor(camera, count = 260) {
    this.count = count;
    this.data = new Float32Array(count * 3);
    const pos = new Float32Array(count * 6);
    const g = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attr);
    this.material = new THREE.LineBasicMaterial({ color: 0x3a3e44, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    camera.add(this.lines);
    for (let i = 0; i < count; i++) this.respawn(i, true);
  }
  respawn(i, anywhere) {
    const a = Math.random() * Math.PI * 2;
    const r = 14 + Math.pow(Math.random(), 0.7) * 90;
    this.data[i * 3] = Math.cos(a) * r;
    this.data[i * 3 + 1] = Math.sin(a) * r * 0.6;
    this.data[i * 3 + 2] = anywhere ? -Math.random() * 700 : -600 - Math.random() * 100;
  }
  update(dt, speed, level, charge) {
    const p = this.attr.array;
    // camera-space streaks can't move at 19 km/s (they'd respawn every frame):
    // compress the visual speed with a square root, keep it monotonic
    const vis = 400 + Math.sqrt(speed) * 28;
    const len = vis * (0.03 + 0.04 * charge);
    for (let i = 0; i < this.count; i++) {
      this.data[i * 3 + 2] += vis * dt;
      if (this.data[i * 3 + 2] > 5) this.respawn(i, false);
      const x = this.data[i * 3], y = this.data[i * 3 + 1], z = this.data[i * 3 + 2];
      p[i * 6] = x; p[i * 6 + 1] = y; p[i * 6 + 2] = z;
      p[i * 6 + 3] = x; p[i * 6 + 4] = y; p[i * 6 + 5] = z - len;
    }
    this.attr.needsUpdate = true;
    const target = Math.max(0, (level - 1) / 4) * 0.55 + charge * 0.3;
    this.material.opacity += (target - this.material.opacity) * Math.min(1, dt * 4);
    this.lines.visible = this.material.opacity > 0.01;
  }
}
