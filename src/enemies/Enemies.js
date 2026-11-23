// Enemy behaviours. Every enemy flies in the PLAYER'S FRAME: its state is a
// relative velocity `rv` (world velocity = player.vel + rv). It picks a
// station (ahead/side/up offsets relative to the jet) and a critically damped
// spring pulls it there; head-on attackers close at a fixed relative speed.
// Dogfights read the same at tier I and at Mach 100.
//
// Each enemy keeps its OWN frame (F forward, R right), taken from the jet when
// it appears and then fixed in the world. Its stations and passes are laid
// out in that frame, so steering the jet never drags enemies back in front of
// the nose: they stay where they are and you aim at them with the mouse.
import * as THREE from 'three';
import { ufoMesh, droneMesh, fighterMesh } from './meshes.js';
import { explosion } from '../render/Particles.js';
import { WEAPONS } from '../config.js';

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _st = new THREE.Vector3();

class Enemy {
  constructor(game, mesh, { hp, radius, score, name }) {
    this.game = game;
    this.mesh = mesh;
    this.pos = mesh.position;
    this.vel = new THREE.Vector3();
    this.rv = new THREE.Vector3();   // velocity relative to the player
    this.hp = this.maxHp = hp;
    this.radius = radius;
    this.score = score;
    this.name = name;
    this.alive = true;
    this.age = 0;
    this.flash = 0;
    this.leaving = false;
    this.lockAngle = 9; this.dist = 1e9;
    // world-fixed frame (see header): where "ahead" and "right" are for this enemy
    this.F = game.player.flatForward.clone();
    this.R = game.player.right.clone();
    // body materials that can flash white when hit (labMaterial's uFlash)
    this.flashMats = [];
    mesh.traverse((o) => { if (o.material?.uniforms?.uFlash) this.flashMats.push(o.material); });
    game.scene.add(mesh);
  }
  /** spring toward station expressed in player frame */
  station(dt, ahead, side, alt, w = 1.4, maxAcc = 900) {
    const p = this.game.player;
    // random sidesteps on top of the weave: the crosshair never just sits on it
    const J = WEAPONS.jink;
    this.jinkT = (this.jinkT ?? 0) - dt;
    if (this.jinkT <= 0 && !this.leaving) {
      const d = this.game.difficulty || 0, k = J.difficulty[0] + (J.difficulty[1] - J.difficulty[0]) * d;
      this.jinkT = J.every[0] + Math.random() * (J.every[1] - J.every[0]);
      // mostly to the other side of where it is now: a real direction change
      const s = -Math.sign(this.jinkSide || (Math.random() - 0.5)) * (Math.random() < 0.75 ? 1 : -1);
      this.jinkSide = s * J.side * k * (0.45 + 0.55 * Math.random());
      this.jinkUp = (Math.random() * 2 - 1) * J.up * k;
    }
    side += this.jinkSide || 0; alt += this.jinkUp || 0;
    _st.copy(p.pos).addScaledVector(this.F, ahead).addScaledVector(this.R, side);
    // altitudes are authored relative to the player's flight line (26 m base)
    _st.y = Math.max(12, alt - 26 + p.pos.y, this.avoidY || 0);
    const acc = _v.subVectors(_st, this.pos).multiplyScalar(w * w).addScaledVector(this.rv, -2 * w);
    if (acc.length() > maxAcc) acc.setLength(maxAcc);
    this.rv.addScaledVector(acc, dt);
  }
  /** player-frame coordinates of this enemy */
  rel() {
    const p = this.game.player;
    _v.subVectors(this.pos, p.pos);
    return { ahead: _v.dot(this.F), side: _v.dot(this.R), dist: _v.length() };
  }
  /** look ~0.6 s ahead; if terrain is in the way, climb over it */
  avoidTerrain(dt) {
    const g = this.game;
    this.avoidY = Math.max(0, (this.avoidY || 0) - 40 * dt);
    if ((g.frame + (this.id | 0)) % 4) return;
    const rv = _d.subVectors(this.vel, g.player.vel).length() > 50 ? this.vel : g.player.vel;
    const lx = this.pos.x + rv.x * 0.6 + g.world.origin.x, lz = this.pos.z + rv.z * 0.6 + g.world.origin.z;
    const hit = g.world.collide(lx, this.pos.y, lz, this.radius + 40);
    if (hit && isFinite(hit.collider.top)) this.avoidY = Math.min(420, hit.collider.top + 30);
  }
  integrate(dt) {
    // acceleration estimate (relative to the player), smoothed: the gun leads with it
    if (!this.acc) { this.acc = new THREE.Vector3(); this.prevRv = this.rv.clone(); }
    if (dt > 0) {
      _d.subVectors(this.rv, this.prevRv).divideScalar(dt);
      this.acc.lerp(_d, 1 - Math.exp(-dt / 0.08));
      this.prevRv.copy(this.rv);
    }
    this.avoidTerrain(dt);
    if (this.avoidY > this.pos.y) this.rv.y += Math.min(400, (this.avoidY - this.pos.y) * 4) * dt;
    this.vel.copy(this.game.player.vel).add(this.rv);
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < 12) { this.pos.y = 12; this.rv.y = Math.abs(this.rv.y) * 0.3; }
    // crash into terrain (funny + free kills)
    const g = this.game;
    if ((g.frame + (this.id | 0)) % 3 === 0) {
      const hit = g.world.collide(this.pos.x + g.world.origin.x, this.pos.y, this.pos.z + g.world.origin.z, this.radius * 0.6);
      if (hit) this.die('crash');
    }
    if (this.flash > 0) this.flash -= dt;
    const f = Math.max(0, this.flash) / 0.09;
    for (const m of this.flashMats) m.uniforms.uFlash.value = f * 0.85;
  }
  faceVelocity(relativeToPlayer = false, bankScale = 0.002) {
    const p = this.game.player;
    const v = relativeToPlayer ? _d.subVectors(this.vel, p.vel) : _d.copy(this.vel);
    if (v.lengthSq() < 1) v.copy(p.forward);
    const yawBefore = this.mesh.rotation.y;
    this.mesh.lookAt(_v.copy(this.pos).sub(v));
    const lateral = this.vel.clone().sub(p.vel).dot(this.R);
    this.mesh.rotateZ(Math.max(-0.9, Math.min(0.9, -lateral * bankScale)));
    return yawBefore;
  }
  /** at: world hit point (for the hit effect / damage number) */
  damage(n, source, at = null) {
    if (!this.alive) return;
    const dealt = Math.min(n, this.hp);
    this.hp -= n;
    this.flash = 0.09;
    const kill = this.hp <= 0;
    this.game.onEnemyHit?.(this, dealt, source, at || this.pos, kill);
    if (kill) this.die(source);
  }
  die(cause) {
    if (!this.alive) return;
    this.alive = false;
    const g = this.game;
    explosion(g.particles, this.pos.x, this.pos.y, this.pos.z, this.radius / 9 + 0.6);
    g.audio.explosion(this.pos.distanceTo(g.player.pos), 1);
    g.onKill(this, cause);
    this.dispose();
  }
  dispose() { this.alive = false; this.game.scene.remove(this.mesh); }
  /** despawn conditions shared by all */
  outOfPlay() {
    const r = this.rel();
    return r.dist > 7000 || (this.leaving && r.dist > 4200) || (r.ahead < -2500);
  }
}

export class Ufo extends Enemy {
  constructor(game, spawnAhead, side) {
    super(game, ufoMesh(), { hp: 280, radius: 17, score: 300, name: 'UFO' });
    const p = game.player;
    this.pos.copy(p.pos).addScaledVector(p.flatForward, spawnAhead).addScaledVector(p.right, side);
    this.pos.y = p.pos.y + 64;
    this.rv.copy(p.flatForward).multiplyScalar(-500); // drifts in from ahead
    this.fireT = 2.5 + Math.random();
    this.phase = Math.random() * 10;
    this.stay = 20 + Math.random() * 8;
  }
  update(dt) {
    this.age += dt;
    const t = this.age + this.phase;
    if (this.age > this.stay) this.leaving = true;
    const ahead = this.leaving ? 5000 : 650 + Math.sin(t * 0.5) * 150;
    this.station(dt, ahead, Math.sin(t * 0.63) * 280, 45 + Math.sin(t * 1.1) * 18, this.leaving ? 0.6 : 1.1, 700);
    this.integrate(dt);
    this.mesh.rotation.set(Math.sin(t * 2) * 0.12, 0, Math.cos(t * 1.7) * 0.12);
    this.mesh.userData.spin.rotation.y += dt * 6;
    const r = this.rel();
    this.fireT -= dt;
    if (!this.leaving && this.fireT <= 0 && r.ahead > 150 && r.dist < 2600) {
      this.fireT = 1.5 + Math.random() * 0.8;
      const p = this.game.player;
      // 3-orb fan: one at you, one each side, so you must pick a gap
      const rel = 460;
      const tgo = r.dist / rel;
      const fan = 28 + Math.random() * 14;
      for (const k of [-1, 0, 1]) {
        _v.copy(p.pos).addScaledVector(p.right, p.steer * p.speed * 0.12 * tgo + k * fan).sub(this.pos).normalize();
        this.game.projectiles.orb(this.pos.clone().add(new THREE.Vector3(0, -4, 0)), _v.multiplyScalar(rel).add(p.vel), 10);
      }
      this.game.audio.plasma(r.dist);
    }
  }
}

export class Drone extends Enemy {
  constructor(game, spawnAhead, side, alt, kamikaze, slot) {
    super(game, droneMesh(), { hp: 36, radius: 6, score: 80, name: 'DRONE' });
    const p = game.player;
    this.pos.copy(p.pos).addScaledVector(p.flatForward, spawnAhead).addScaledVector(p.right, side);
    this.pos.y = Math.max(14, alt - 26 + p.pos.y);
    this.rv.copy(p.flatForward).multiplyScalar(-700); // closing head-on
    this.kamikaze = kamikaze;
    this.slot = slot;
    this.mode = 'rush';
    this.fireT = 0.5 + Math.random();
    this.burst = 0;
    this.phase = Math.random() * 6;
  }
  update(dt) {
    this.age += dt;
    const g = this.game, p = g.player;
    const r = this.rel();
    if (this.age > 26) this.leaving = true;
    if (this.mode === 'rush') {
      // close head-on with weaving
      const t = this.age * 2.2 + this.phase;
      const targetSide = this.kamikaze ? 0 : this.slot * 40 + Math.sin(t) * 60;
      const lat = (targetSide - r.side) * 2.2;
      _v.copy(this.F).multiplyScalar(-700).addScaledVector(this.R, lat);
      _v.y = ((this.kamikaze ? p.pos.y : p.pos.y + 14 + this.slot * 6) - this.pos.y) * 2;
      this.rv.lerp(_v, 1 - Math.exp(-3 * dt));
      if (r.ahead < -80) { this.mode = 'chase'; this.chaseSide = (Math.random() - 0.5) * 300; }
      if (this.kamikaze && r.dist < p.radius + this.radius + 2) {
        g.damagePlayer(16, 'ram');
        this.die('ram');
        return;
      }
    } else {
      // overtake and re-engage from the front
      const t = this.age * 1.3 + this.phase;
      this.station(dt, this.leaving ? 6000 : 420 + this.slot * 30, this.chaseSide + Math.sin(t) * 120, 40 + Math.sin(t * 1.7) * 12, 1.2, 1400);
    }
    this.integrate(dt);
    for (const rt of this.mesh.userData.rotors) rt.rotation.z += dt * 40;
    this.faceVelocity(true, 0.004);
    // gun bursts
    this.fireT -= dt;
    if (!this.kamikaze && !this.leaving && r.ahead > 60 && r.dist < 1700 && this.fireT <= 0) {
      this.burst = 6; this.fireT = 1.4 + Math.random();
    }
    if (this.burst > 0 && (g.frame % 5 === 0)) {
      this.burst--;
      const rel = 1400;
      _v.subVectors(p.pos, this.pos).normalize();
      _v.x += (Math.random() - 0.5) * 0.07; _v.y += (Math.random() - 0.5) * 0.05; _v.z += (Math.random() - 0.5) * 0.07;
      g.projectiles.bullet('enemy', this.pos.clone(), _v.normalize().multiplyScalar(rel).add(p.vel), 3, 0xff3b30, 2);
      g.audio.enemyGun(r.dist);
    }
  }
}

export class Fighter extends Enemy {
  constructor(game, fromBehind) {
    super(game, fighterMesh(), { hp: 170, radius: 11, score: 200, name: 'FIGHTER' });
    const p = game.player;
    this.fromBehind = fromBehind;
    const side = (Math.random() - 0.5) * 500;
    if (fromBehind) {
      this.pos.copy(p.pos).addScaledVector(p.flatForward, -1100).addScaledVector(p.right, side);
      this.rv.copy(p.flatForward).multiplyScalar(300);
      this.mode = 'overtake';
      game.hud.toast('BOGEY ON YOUR SIX', 'warn');
    } else {
      this.pos.copy(p.pos).addScaledVector(p.flatForward, 4200).addScaledVector(p.right, side);
      this.rv.copy(p.flatForward).multiplyScalar(-900);
      this.mode = 'joust';
    }
    this.pos.y = Math.max(20, p.pos.y + 30 + Math.random() * 30);
    this.missileT = 1.2;
    this.gunT = 2;
    this.burst = 0;
    this.phase = Math.random() * 6;
    this.salvoFired = 0;
  }
  update(dt) {
    this.age += dt;
    const g = this.game, p = g.player;
    const r = this.rel();
    if (this.age > 34) this.leaving = true;
    if (this.mode === 'joust') {
      const lat = (Math.sin(this.age * 0.8 + this.phase) * 120 - r.side) * 0.9;
      _v.copy(this.F).multiplyScalar(-900).addScaledVector(this.R, lat);
      _v.y = (p.pos.y + 34 - this.pos.y);
      this.rv.lerp(_v, 1 - Math.exp(-2 * dt));
      if (r.ahead < 2700 && r.ahead > 500 && this.salvoFired < 2) {
        this.missileT -= dt;
        if (this.missileT <= 0) { this.missileT = 0.35; this.salvoFired++; this.fireMissile(); }
      }
      if (r.ahead < -300) this.mode = 'dogfight';
    } else if (this.mode === 'overtake') {
      this.station(dt, 900, Math.sin(this.age * 0.7) * 200, 60, 0.9, 1100);
      if (r.ahead > 600) this.mode = 'dogfight';
    } else {
      const t = this.age * 0.55 + this.phase;
      this.station(dt, this.leaving ? 6000 : 850 + Math.sin(t * 0.7) * 200, Math.sin(t) * 380, 55 + Math.sin(t * 1.3) * 25, 0.9, 1300);
      this.missileT -= dt;
      if (!this.leaving && r.ahead > 300 && r.dist < 2200 && this.missileT <= 0) { this.missileT = 4.5 + Math.random() * 2; this.fireMissile(); }
    }
    this.integrate(dt);
    this.faceVelocity(true, 0.004);
    if (this.mode !== 'joust') {
      // keep nose pointing forward-ish (same direction as player) while dogfighting
      this.mesh.lookAt(_v.copy(this.pos).sub(this.F).sub(_d.subVectors(this.vel, p.vel).multiplyScalar(0.004)));
      this.mesh.rotateZ(-_d.dot(this.R) * 0.6);
    }
    const b = this.mesh.userData.burner;
    b.scale.z = 0.8 + Math.random() * 0.5;
  }
  fireMissile() {
    const g = this.game, p = g.player;
    _v.subVectors(p.pos, this.pos).normalize();
    const vel = this.vel.clone().addScaledVector(_v, 120);
    g.projectiles.missile('enemy', this.pos.clone().add(new THREE.Vector3(0, -3, 0)), vel, null, {
      relSpeed: 420, accel: 500, turnRate: 1.9, damage: 22, splash: 26, prox: 12, life: 7, armDelay: 0.25,
    });
    g.audio.enemyMissile();
    g.hud.toast('MISSILE INCOMING', 'danger');
  }
}

export class EnemyManager {
  constructor(game) { this.game = game; this.list = []; this.nextId = 1; }
  reset() { for (const e of this.list) e.dispose(); this.list.length = 0; }
  add(e) { e.id = this.nextId++; this.list.push(e); return e; }
  spawnWave(kind, difficulty) {
    const g = this.game;
    if (kind === 'drones') {
      const n = 3 + Math.round(difficulty * 4);
      const side = (Math.random() - 0.5) * 500;
      for (let i = 0; i < n; i++) {
        const slot = i - (n - 1) / 2;
        this.add(new Drone(g, 2800 + Math.abs(slot) * 80, side + slot * 50, 34 + Math.random() * 20, Math.random() < 0.25 + difficulty * 0.25, slot));
      }
      g.hud.toast(`DRONE SWARM ×${n}`, 'danger');
    } else if (kind === 'ufo') {
      const n = difficulty > 0.6 && Math.random() < 0.5 ? 2 : 1;
      for (let i = 0; i < n; i++) this.add(new Ufo(g, 3400 + i * 400, (Math.random() - 0.5) * 900));
      g.hud.toast(n > 1 ? 'UNIDENTIFIED CRAFT ×2' : 'UNIDENTIFIED CRAFT', 'danger');
    } else if (kind === 'fighters') {
      const n = 1 + (difficulty > 0.45 ? 1 : 0) + (difficulty > 0.85 ? 1 : 0);
      const behind = Math.random() < 0.35;
      for (let i = 0; i < n; i++) this.add(new Fighter(g, behind));
      if (!behind) g.hud.toast(n > 1 ? `FIGHTERS ×${n} HEAD-ON` : 'FIGHTER HEAD-ON', 'danger');
    }
    g.audio.alarm();
  }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.alive) {
        e.update(dt);
        // hit flash
        const m = e.mesh.children[0]?.material;
        if (m?.uniforms?.uFlash) m.uniforms.uFlash.value = e.flash > 0 ? 0.6 : 0;
        if (e.alive && e.outOfPlay()) e.dispose();
      }
      if (!e.alive) this.list.splice(i, 1);
    }
  }
  rebase(dx, dz) { for (const e of this.list) { e.pos.x -= dx; e.pos.z -= dz; } }
  get count() { return this.list.length; }
}
