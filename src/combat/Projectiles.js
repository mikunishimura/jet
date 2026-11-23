// All in-flight ordnance: tracer bullets (both sides), homing missiles (both
// sides) and enemy plasma orbs.
//
// Everything flies in the PLAYER'S FRAME: each projectile stores a relative
// velocity `rv`; its world velocity is player.vel + rv. Combat therefore reads
// the same at tier I and at Mach 100, and homing never has to "turn around"
// a hypersonic world velocity. Hit tests sweep the relative motion.
//
// Frame order: the jet moves first, THEN weapons fire from the (already
// moved) muzzle. A projectile born this frame must not also get the jet's
// displacement (that put new shots ~300 m ahead of the jet at Mach 100), so
// it only advances by its relative velocity on its first frame.
import * as THREE from 'three';
import { labMaterial, edgeMaterial } from '../render/materials.js';
import { PALETTE } from '../config.js';
import { explosion, sparks } from '../render/Particles.js';

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const rgba = (hex, a) => { const c = new THREE.Color(hex); return { r: c.r, g: c.g, b: c.b, a }; };
const PLAYER_TRAIL = rgba(0x5b6168, 0.8), KILL_TRAIL = rgba(0x15171a, 1), ENEMY_TRAIL = rgba(0xff3b30, 0.9);

export class Projectiles {
  constructor(game) {
    this.game = game;
    const scene = game.scene;
    // tracers
    this.maxBullets = 600;
    this.bullets = [];
    const g = new THREE.BufferGeometry();
    this.bPos = new THREE.BufferAttribute(new Float32Array(this.maxBullets * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.bCol = new THREE.BufferAttribute(new Float32Array(this.maxBullets * 6), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.bPos); g.setAttribute('color', this.bCol);
    this.tracers = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, fog: true, transparent: true, opacity: 0.95, depthWrite: false }));
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 4;
    scene.add(this.tracers);

    // missile trails: thin vector lines tracing each missile's recent path,
    // fading toward the tail (no smoke: same 1 px language as the contrails)
    this.TRAIL = 14;                       // points per missile
    this.maxTrailSegs = 64 * (this.TRAIL - 1);
    const tg = new THREE.BufferGeometry();
    this.tPos = new THREE.BufferAttribute(new Float32Array(this.maxTrailSegs * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.tCol = new THREE.BufferAttribute(new Float32Array(this.maxTrailSegs * 8), 4).setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('position', this.tPos); tg.setAttribute('color', this.tCol);
    this.trails = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true }));
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 4;
    scene.add(this.trails);

    // missiles
    this.missiles = [];
    const mg = new THREE.ConeGeometry(0.7, 5, 6); mg.rotateX(-Math.PI / 2);
    this.missileGeo = mg;
    this.missileEdges = new THREE.EdgesGeometry(mg, 20);
    this.missileMatP = labMaterial({ color: 0xffffff, contour: 0 });
    this.missileMatE = labMaterial({ color: 0x2a2d33, contour: 0 });
    this.edgeP = edgeMaterial(PALETTE.ink, 1);
    this.edgeE = edgeMaterial(PALETTE.enemy, 1);
    // orbs: red wireframe glyph around a small solid core
    this.orbs = [];
    this.orbCore = new THREE.OctahedronGeometry(2.2, 0);
    this.orbShell = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(5.5, 0));
    this.orbMat = new THREE.MeshBasicMaterial({ color: PALETTE.enemy, fog: true });
    this.orbEdge = new THREE.LineBasicMaterial({ color: PALETTE.enemy, fog: true });
  }

  reset() {
    this.bullets.length = 0;
    for (const m of this.missiles) this.game.scene.remove(m.mesh);
    for (const o of this.orbs) this.game.scene.remove(o.mesh);
    this.missiles.length = 0; this.orbs.length = 0;
    this.trails.geometry.setDrawRange(0, 0);
  }

  /** `vel` is a WORLD velocity (as aimed); stored relative to the player */
  bullet(owner, pos, vel, damage, color, life = 1.4) {
    if (this.bullets.length >= this.maxBullets) this.bullets.shift();
    const b = { owner, p: pos.clone(), rv: vel.clone().sub(this.game.player.vel), damage, color: new THREE.Color(color), life, age: 0, born: this.game.frame };
    this.bullets.push(b);
    return b;
  }

  /** opts: relSpeed, accel, turnRate, damage, splash, prox, life, armDelay */
  missile(owner, pos, vel, target, opts) {
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(this.missileGeo, owner === 'player' ? this.missileMatP : this.missileMatE));
    mesh.add(new THREE.LineSegments(this.missileEdges, owner === 'player' ? this.edgeP : this.edgeE));
    mesh.position.copy(pos);
    this.game.scene.add(mesh);
    const rv = vel.clone().sub(this.game.player.vel);
    const m = { owner, mesh, p: mesh.position, rv, target, speed: rv.length(), ...opts, age: 0, born: this.game.frame, hist: [] };
    this.missiles.push(m);
    return m;
  }

  orb(pos, vel, damage) {
    const mesh = new THREE.Mesh(this.orbCore, this.orbMat);
    mesh.add(new THREE.LineSegments(this.orbShell, this.orbEdge));
    mesh.position.copy(pos);
    this.game.scene.add(mesh);
    this.orbs.push({ mesh, p: mesh.position, rv: vel.clone().sub(this.game.player.vel), damage, life: 6, born: this.game.frame });
  }

  rebase(dx, dz) {
    for (const b of this.bullets) { b.p.x -= dx; b.p.z -= dz; }
    for (const m of this.missiles) { m.p.x -= dx; m.p.z -= dz; for (const h of m.hist) { h.x -= dx; h.z -= dz; } }
    for (const o of this.orbs) { o.p.x -= dx; o.p.z -= dz; }
  }

  hitsWorld(p) {
    const g = this.game;
    if (p.y < 0.5) return true;
    return !!g.world.collide(p.x + g.world.origin.x, p.y, p.z + g.world.origin.z, 0.5);
  }

  update(dt) {
    const g = this.game;
    const player = g.player;
    const pv = player.vel;
    const enemies = g.enemies.list;
    const fx = g.particles;
    // --- bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;
      const kb = b.born === g.frame ? 0 : 1; // born this frame: the jet already moved
      b.age += dt;
      b.p.x += (pv.x * kb + b.rv.x) * dt; b.p.y += (pv.y * kb + b.rv.y) * dt; b.p.z += (pv.z * kb + b.rv.z) * dt;
      const prev = _a.copy(b.p).addScaledVector(b.rv, -dt); // sweep in the moving frame
      let dead = b.life <= 0;
      if (!dead && b.owner === 'player') {
        const doomed = g.weapons?.doomed;
        for (const e of enemies) {
          if (!e.alive || doomed?.has(e)) continue;   // locked-in: the kill missile has it, rounds fly on
          // sweep relative to the enemy (it moved this frame too): fast or jinking targets can't slip between frames
          _v.copy(prev).addScaledVector(e.rv, dt);
          if (segSphere(_v, b.p, e.pos, e.radius + 2)) {
            e.damage(b.damage, b.crit ? 'crit' : 'gun', b.p);
            // flak: the burst also catches anything packed close (not targets a kill missile has)
            if (b.splash) {
              for (const o of enemies) {
                if (o === e || !o.alive || doomed?.has(o)) continue;
                if (o.pos.distanceTo(b.p) < b.splash + o.radius) o.damage(b.damage * b.splashShare, 'gun', o.pos);
              }
              if (Math.random() < 0.35) g.particles.vector.ring(b.p.x, b.p.y, b.p.z, 2, b.splash, 0.16, 0x15171a);
            }
            dead = true; break;
          }
        }
      } else if (!dead && b.owner === 'enemy' && player.alive) {
        if (segSphere(prev, b.p, player.pos, player.radius + 1.5)) { g.damagePlayer(b.damage, 'bullet'); dead = true; }
      }
      if (!dead && (i & 1) === (g.frame & 1) && this.hitsWorld(b.p)) { sparks(fx, b.p.x, b.p.y, b.p.z, 2, 0x15171a, false); dead = true; }
      if (dead) this.bullets.splice(i, 1);
    }
    // tracer geometry: each bullet draws a streak along its relative velocity
    const P = this.bPos.array, C = this.bCol.array;
    const n = this.bullets.length;
    for (let i = 0; i < n; i++) {
      const b = this.bullets[i];
      // streak never longer than the distance flown: no tail poking back through the jet
      const len = Math.min(b.owner === 'player' ? 0.01 : 0.035, b.age); // player rounds are 6.5 km/s: ~65 m streaks
      P[i * 6] = b.p.x; P[i * 6 + 1] = b.p.y; P[i * 6 + 2] = b.p.z;
      P[i * 6 + 3] = b.p.x - b.rv.x * len; P[i * 6 + 4] = b.p.y - b.rv.y * len; P[i * 6 + 5] = b.p.z - b.rv.z * len;
      C[i * 6] = b.color.r; C[i * 6 + 1] = b.color.g; C[i * 6 + 2] = b.color.b;
      C[i * 6 + 3] = b.color.r; C[i * 6 + 4] = b.color.g; C[i * 6 + 5] = b.color.b;
    }
    this.tracers.geometry.setDrawRange(0, n * 2);
    this.bPos.needsUpdate = this.bCol.needsUpdate = true;

    // --- missiles (guided in the player's frame)
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.age += dt; m.life -= dt;
      let tgtPos = null, tgtRv = null;
      if (m.owner === 'player') {
        if (m.target && !m.target.alive && !m.lost) m.target = g.weapons.retarget(m);
        if (m.target) { tgtPos = m.target.pos; tgtRv = m.target.vel.clone().sub(pv); }
      } else if (m.decoy) { tgtPos = m.decoy.p; tgtRv = m.decoy.rv; }   // pulled off by a flare
      else if (m.beaten) { /* out-turned: flies on past, harmless */ }
      else if (player.alive) { tgtPos = player.pos; tgtRv = new THREE.Vector3(); }
      m.speed = Math.min(m.relSpeed, m.speed + m.accel * dt);
      // loose lock: in the last moment the target may jink out of the way
      if (m.evade && m.target && tgtPos && !m.rolled && m.p.distanceTo(tgtPos) < m.speed * 0.12) {
        m.rolled = true;
        if (Math.random() < m.evade) {
          const e = m.target;
          m.dir = _v.copy(m.rv).normalize().clone();
          _a.crossVectors(m.dir, _d.set(0, 1, 0)).normalize().multiplyScalar(Math.random() < 0.5 ? -1 : 1);
          e.rv.addScaledVector(_a, 420).y += 120;          // the jink: a hard sidestep
          m.target = null; m.lost = true; tgtPos = null;
          g.onEnemyEvaded?.(e);
        }
      }
      if (tgtPos && m.age > m.armDelay) {
        const dist = _d.subVectors(tgtPos, m.p).length();
        const closing = Math.max(150, m.speed - tgtRv.dot(_d.clone().normalize()));
        const tgo = Math.min(2, dist / closing);
        _d.copy(tgtPos).addScaledVector(tgtRv, tgo).sub(m.p).normalize();
        const cur = _v.copy(m.rv).normalize();
        const ang = Math.acos(Math.max(-1, Math.min(1, cur.dot(_d))));
        if (ang > 1e-4) cur.lerp(_d, Math.min(1, (m.turnRate * dt) / ang)).normalize();
        m.rv.copy(cur).multiplyScalar(m.speed);
      } else if (m.dir) {
        // no lock: settle onto the crosshair direction it was fired along
        const cur = _v.copy(m.rv).normalize();
        const ang = Math.acos(Math.max(-1, Math.min(1, cur.dot(m.dir))));
        if (ang > 1e-4) cur.lerp(m.dir, Math.min(1, (m.turnRate * dt) / ang)).normalize();
        m.rv.copy(cur).multiplyScalar(m.speed);
      } else m.rv.setLength(m.speed);
      const km = m.born === g.frame ? 0 : 1;
      m.p.x += (pv.x * km + m.rv.x) * dt; m.p.y += (pv.y * km + m.rv.y) * dt; m.p.z += (pv.z * km + m.rv.z) * dt;
      const prev = m.p.clone().addScaledVector(m.rv, -dt);
      m.mesh.lookAt(_v.copy(m.p).sub(m.rv)); // nose is -Z
      // trail history: points ride in the player's frame like everything else
      for (const h of m.hist) { h.x += pv.x * km * dt; h.y += pv.y * km * dt; h.z += pv.z * km * dt; }
      if (m.hist.length >= this.TRAIL) m.hist.pop();
      m.hist.unshift(m.p.clone());
      let boom = m.life <= 0 || m.p.y < 1;
      if (!boom && tgtPos && m.p.distanceTo(tgtPos) < m.prox) boom = true;
      if (!boom && m.owner === 'player') {
        for (const e of enemies) if (e.alive && segSphere(prev, m.p, e.pos, e.radius + 4)) { boom = true; break; }
      }
      if (!boom && (i & 1) === (g.frame & 1) && this.hitsWorld(m.p)) boom = true;
      if (boom) { this.detonate(m); this.missiles.splice(i, 1); }
    }

    this.drawTrails();

    // --- orbs
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.life -= dt;
      const ko = o.born === g.frame ? 0 : 1;
      o.p.x += (pv.x * ko + o.rv.x) * dt; o.p.y += (pv.y * ko + o.rv.y) * dt; o.p.z += (pv.z * ko + o.rv.z) * dt;
      o.mesh.rotation.x += dt * 5; o.mesh.rotation.y += dt * 3;
      const prev = _a.copy(o.p).addScaledVector(o.rv, -dt);
      let dead = o.life <= 0;
      if (!dead && player.alive && segSphere(prev, o.p, player.pos, player.radius + 5)) {
        g.damagePlayer(o.damage, 'plasma'); dead = true;
        explosion(fx, o.p.x, o.p.y, o.p.z, 0.35);
      }
      if (!dead && (i & 1) === (g.frame & 1) && this.hitsWorld(o.p)) { dead = true; explosion(fx, o.p.x, o.p.y, o.p.z, 0.4); }
      if (dead) { g.scene.remove(o.mesh); this.orbs.splice(i, 1); }
    }
  }

  drawTrails() {
    const P = this.tPos.array, C = this.tCol.array;
    let n = 0;
    for (const m of this.missiles) {
      const h = m.hist, L = h.length - 1;
      if (L < 1) continue;
      const c = m.kill ? KILL_TRAIL : m.owner === 'player' ? PLAYER_TRAIL : ENEMY_TRAIL;
      for (let i = 0; i < L && n < this.maxTrailSegs; i++, n++) {
        const a = h[i], b = h[i + 1];
        P[n * 6] = a.x; P[n * 6 + 1] = a.y; P[n * 6 + 2] = a.z;
        P[n * 6 + 3] = b.x; P[n * 6 + 4] = b.y; P[n * 6 + 5] = b.z;
        const fa = (1 - i / L) * c.a, fb = (1 - (i + 1) / L) * c.a;
        C.set([c.r, c.g, c.b, fa, c.r, c.g, c.b, fb], n * 8);
      }
    }
    this.trails.geometry.setDrawRange(0, n * 2);
    this.tPos.needsUpdate = this.tCol.needsUpdate = true;
  }

  detonate(m) {
    const g = this.game;
    g.scene.remove(m.mesh);
    explosion(g.particles, m.p.x, m.p.y, m.p.z, m.owner === 'player' ? 0.8 : 0.65, m.owner === 'player' ? 0x15171a : 0xff3b30);
    g.audio.explosion(m.p.distanceTo(g.player.pos), 0.6);
    if (m.owner === 'player') {
      // kill missile: the locked target dies, whatever its hull
      if (m.kill && m.target?.alive && m.target.pos.distanceTo(m.p) < m.prox + m.target.radius + 20) m.target.damage(m.target.hp, 'missile', m.p);
      for (const e of g.enemies.list) {
        if (!e.alive) continue;
        const d = e.pos.distanceTo(m.p);
        if (d < m.splash + e.radius) e.damage(m.damage * (1 - 0.5 * d / (m.splash + e.radius)), 'missile', m.p);
      }
    } else if (g.player.alive) {
      const d = g.player.pos.distanceTo(m.p);
      if (d < m.splash) g.damagePlayer(m.damage * (1 - 0.6 * d / m.splash), 'missile');
    }
    const near = g.player.pos.distanceTo(m.p);
    if (near < 300) g.fx.explosionNear((1 - near / 300) * 0.8);
  }
}

/** segment (a→b) vs sphere (c, r) */
export function segSphere(a, b, c, r) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz || 1e-9;
  let t = (acx * abx + acy * aby + acz * abz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a.x + abx * t - c.x, dy = a.y + aby * t - c.y, dz = a.z + abz * t - c.z;
  return dx * dx + dy * dy + dz * dz < r * r;
}
