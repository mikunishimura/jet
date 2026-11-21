// A teammate's enemy, as seen here. Its owner simulates it (the enemy attacks
// the owner) and publishes it relative to the owner's jet; we re-anchor it on
// our prediction of that jet every frame. It lives in our EnemyManager list so
// auto-aim, locks, HUD boxes and our rounds all treat it like any enemy. Our
// hits are claims sent to the owner (shooter-favored); feedback is immediate.
import * as THREE from 'three';
import { ufoMesh, droneMesh, fighterMesh } from '../enemies/meshes.js';
import { explosion } from '../render/Particles.js';

export const KINDS = [
  { name: 'DRONE', mesh: droneMesh, radius: 6, score: 80, hp: 36 },
  { name: 'UFO', mesh: ufoMesh, radius: 17, score: 300, hp: 280 },
  { name: 'FIGHTER', mesh: fighterMesh, radius: 11, score: 200, hp: 170 },
];
export const kindIndex = (name) => Math.max(0, KINDS.findIndex((k) => k.name === name));

export class GhostEnemy {
  constructor(game, net, owner, rid, kind) {
    const K = KINDS[kind] || KINDS[0];
    this.game = game; this.net = net;
    this.ghost = true;
    this.owner = owner; this.rid = rid; this.kind = kind;
    this.mesh = K.mesh();
    this.pos = this.mesh.position;
    this.vel = new THREE.Vector3();
    this.radius = K.radius; this.score = K.score; this.name = K.name;
    this.maxHp = K.hp; this.hp = K.hp;
    this.alive = true; this.flash = 0;
    this.lockAngle = 9; this.dist = 1e9;
    this.localHitT = -9;
    this.flashMats = [];
    this.mesh.traverse((o) => { if (o.material?.uniforms?.uFlash) this.flashMats.push(o.material); });
    game.scene.add(this.mesh);
  }
  update(dt) {
    if (this.flash > 0) this.flash -= dt;
    const f = Math.max(0, this.flash) / 0.09;
    for (const m of this.flashMats) m.uniforms.uFlash.value = f * 0.85;
    const spin = this.mesh.userData.spin;
    if (spin) spin.rotation.y += dt * 3;
  }
  outOfPlay() { return false; } // the owner decides
  /** our round / missile hit it: claim it, show it now */
  damage(n, source, at = null) {
    if (!this.alive) return;
    const dealt = Math.min(n, this.hp);
    this.hp -= n; this.flash = 0.09; this.localHitT = this.game.time;
    const kill = this.hp <= 0;
    this.net.claimHit(this, n, source, kill);
    this.game.onEnemyHit(this, dealt, source, at || this.pos, kill);
    if (kill) this.die(true);
  }
  die(predicted = false) {
    if (!this.alive) return;
    this.alive = false;
    const g = this.game;
    explosion(g.particles, this.pos.x, this.pos.y, this.pos.z, this.radius / 9 + 0.6);
    g.audio.explosion(this.pos.distanceTo(g.player.pos), 1);
    if (predicted) this.net.predictedKill(this);
    this.dispose();
  }
  dispose() { this.alive = false; this.game.scene.remove(this.mesh); }
}
