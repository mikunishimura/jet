// Obstacle events spawned DOWN THE PLAYER'S PATH. The static world is mostly
// open plain; this system places a structure ahead of you, along your current
// heading, every few seconds of flight (time-based, so pacing is the same at
// any tier). Many patterns reward holding your line (spire pairs to thread,
// gates on the line); some ask for a small correction; vistas are scenery.
//
// Add a pattern: write `(b, ctx) => reach` below and give it a weight in
// PATH.patterns (src/config.js).
//
// Orbit: when space flight is on (Game sets `hazards.space`), events above
// SPACE.hazardFloor come from src/space/patterns.js instead: asteroids, moons
// and boost rings at your altitude.
import { ChunkBuilder } from './ChunkBuilder.js';
import { buildGate } from './features/gates.js';
import { PATH, FLIGHT, WORLD_SCALE, SPACE, BREAKER, DEG, tierLevel } from '../config.js';
import { SPACE_PATTERNS } from '../space/patterns.js';
import { SpaceBuilder, BodyLibrary } from '../space/bodies.js';
import { spaceMaterials } from '../space/materials.js';
import { predictCourse } from '../game/LineWatch.js';

const S = WORLD_SCALE; // patterns are authored in base meters, scaled by World

const R = (a, b) => a + (b - a) * Math.random();
const R_ = R;
const sign = () => (Math.random() < 0.5 ? -1 : 1);

const PATTERNS = {
  /** a single tall spire, on your line or a near miss */
  spire(b, c) {
    const radius = R(16, 32);
    c.rock(b, 'spire', 0, c.single(radius), radius, R(140, 240));
    return 200;
  },
  boulder(b, c) {
    const radius = R(40, 70);
    c.rock(b, 'boulder', 0, c.single(radius), radius, R(50, 90));
    return 200;
  },
  mesa(b, c) {
    const radius = R(70, 115);
    c.rock(b, 'mesa', 0, c.single(radius), radius, R(55, 95));
    return 250;
  },
  /** two spires flanking your line: hold it and you thread the needle */
  pair(b, c) {
    const gap = R(90, 140) - 25 * c.difficulty;
    const off = R(-15, 15);
    for (const s of [-1, 1]) {
      const radius = R(18, 28);
      c.rock(b, 'spire', R(-20, 20), off + s * (gap / 2 + radius), radius, R(150, 230));
    }
    return 300;
  },
  /** survey gate square on your line (bonus when you fly through) */
  gate(b, c) {
    const [x, z] = c.at(0, R(-12, 12));
    buildGate(b, x, z, c.heading, R(130, 160), `pgate:${c.id}`);
    return 200;
  },
  /** a loose group, mostly off the line */
  cluster(b, c) {
    const n = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const radius = R(22, 55);
      const side = i === 0 ? c.single(radius) : sign() * R(radius + 60, 420);
      c.rock(b, Math.random() < 0.5 ? 'boulder' : 'spire', R(-250, 250), side, radius, R(60, 200));
    }
    return 600;
  },
  /** a mountain wall across your path with one gap: steer for it (or find it) */
  wall(b, c) {
    const gapCenter = R(-240, 240), gap = R(150, 200) - 30 * c.difficulty;
    for (let side = -700; side <= 700; side += 115) {
      if (Math.abs(side - gapCenter) < gap / 2 + 60) continue;
      const radius = R(70, 95);
      c.rock(b, 'peak', R(-30, 30), side, radius, R((FLIGHT.obstacleBand + 1500) / S, (FLIGHT.obstacleBand + 3700) / S), 'mountain');
    }
    return 800;
  },
  /** big mountains well off to the side: panorama, no gameplay */
  vista(b, c) {
    const n = 2 + Math.floor(Math.random() * 3);
    const s0 = sign();
    for (let i = 0; i < n; i++) {
      const radius = R(200, 380);
      c.rock(b, 'peak', R(-400, 900), s0 * R(800, 2300), radius, R(320, 680), 'mountain');
    }
    return 2700;
  },
};

export class PathHazards {
  constructor(world) { this.world = world; this.space = null; this.reset(); }

  /** drop every orbital event (space flight switched off) */
  clearOrbit() {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].orbit) { this.world.removeDynamic(this.items[i]); this.items.splice(i, 1); }
  }

  /** true when the next event should be an orbital one */
  inOrbit(player) { return !!this.space && player.pos.y > SPACE.hazardFloor; }

  reset() {
    for (const d of this.items || []) this.world.removeDynamic(d);
    this.flown = 0;
    this.next = PATH.firstAfter;
    this.items = [];
    this.breakers = [];   // live line breakers (HUD markers): absolute x, y, z, radius
    this.spawned = 0;
  }

  update(dt, player, difficulty = 0) {
    if (!player.alive || !player.speedSys.engaged) return;
    const w = this.world;
    this.flown += player.speed * dt;
    if (this.flown >= this.next) {
      const orbit = this.inOrbit(player);
      const ok = orbit ? this.spawnOrbit(player, difficulty) : this.spawn(player, difficulty);
      const [easy, hard] = orbit ? SPACE.interval : PATH.interval;
      const sec = (easy + (hard - easy) * difficulty) * (1 + (Math.random() * 2 - 1) * PATH.jitter);
      this.next = this.flown + (ok ? Math.max(300 * S, player.speed * sec) : 300 * S);
    }
    // drop structures that are well behind you
    const ax = player.pos.x + w.origin.x, az = player.pos.z + w.origin.z;
    const f = player.flatForward;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = this.items[i];
      const rx = d.centerX - ax, rz = d.centerZ - az;
      // breakers sit on curved courses: keep them until they are far away, not just "behind"
      const behind = rx * f.x + rz * f.z < -(d.reach + 900 * S), dist = Math.hypot(rx, rz);
      if (d.breaker ? (behind && dist > 2500 * S) || dist > 8000 * S : behind || dist > 14000 * S) {
        w.removeDynamic(d); this.items.splice(i, 1);
      }
    }
    // line breakers rise out of the ground / materialize in the air (masks the pop-in)
    for (const d of this.items) {
      const r = d.rise;
      if (!r || r.t >= r.dur) continue;
      r.t = Math.min(r.dur, r.t + dt);
      const k = r.t / r.dur, s = Math.max(0.02, 1 - Math.pow(1 - k, 3));
      if (r.floating) { d.group.scale.setScalar(S * s); d.group.position.y = r.y * (1 - s); }
      else d.group.scale.y = S * s;
    }
    // a breaker stays marked until you've passed it (or it's gone)
    const fy = player.forward?.y ?? 0;
    if (this.breakers.length) this.breakers = this.breakers.filter((b) => this.items.includes(b.item)
      && (b.x - ax) * f.x + (b.z - az) * f.z + (b.y - player.pos.y) * fy > -b.r);
  }

  /** shaders for the floating breaker rocks (compiled up front by Game.warmup) */
  breakerKit() {
    if (!this.kit) this.kit = { lib: new BodyLibrary(23), mat: spaceMaterials(this.world) };
    return this.kit;
  }
  warmupBreaker(pos) {
    const k = this.breakerKit(), b = new SpaceBuilder(pos.x / S, pos.z / S);
    b.addBody(k.lib.pick('rock'), { x: pos.x / S, y: pos.y / S, z: pos.z / S - 20, radius: 2, collide: false });
    const g = b.bake(k.mat);
    g.scale.setScalar(S); g.position.set(pos.x, 0, pos.z);
    return g;
  }

  /**
   * Line breaker: an obstacle right where the course you've been holding
   * (see LineWatch) takes you, BREAKER.lead seconds from now. Ground rocks in
   * the obstacle band, floating rocks above it and in orbit.
   */
  spawnBreaker(player, difficulty, course, kind = null) {
    const w = this.world, B = BREAKER, v = player.speed;
    if (!(v > 0)) return null;
    const lead = B.lead[0] + (B.lead[1] - B.lead[0]) * difficulty;
    const [px, py, pz, ph] = predictCourse(player.pos.x + w.origin.x, player.pos.y, player.pos.z + w.origin.z,
      player.heading, player.pitch, course.rate, v, player.drift || 0, lead, FLIGHT.minAltitude, FLIGHT.ceiling);
    const R = Math.min(B.radius[1], Math.max(B.radius[0], v * lead * Math.sin(B.coverDeg * DEG)));
    const fx = -Math.sin(ph), fz = -Math.cos(ph), rx = Math.cos(ph), rz = -Math.sin(ph);
    const floating = py > FLIGHT.obstacleBand;
    // a curtain needs room to go over or under it
    const roomV = py + 2.4 * R < FLIGHT.ceiling || py - 2.4 * R > FLIGHT.minAltitude + 200;
    if (!kind) {
      const opts = Object.entries(B.patterns).filter(([k]) => k !== 'curtain' || (floating && roomV));
      let t = Math.random() * opts.reduce((a, o) => a + o[1], 0);
      kind = opts[0][0];
      for (const [k, wt] of opts) if ((t -= wt) <= 0) { kind = k; break; }
    }
    if (kind === 'curtain' && !(floating && roomV)) kind = 'block';
    // rocks: [side offset (m, right of the course), up offset (m), radius (m)]
    const rocks = [[R * R_(-0.15, 0.15), R * R_(-0.15, 0.15), R]];
    if (kind === 'fork') {
      const s = sign(), r2 = R * 0.8;
      rocks.push([s * (R + r2 + B.forkGap * R), R * R_(-0.2, 0.2), r2]);
    } else if (kind === 'curtain') {
      rocks.length = 0;
      const r = R * 0.8, dy = R * R_(-0.25, 0.25);
      for (let k = -3; k <= 3; k++) rocks.push([k * 2.05 * r, dy + r * R_(-0.1, 0.1), r]);
    }
    const cx = px / S, cz = pz / S;
    let b, item;
    if (floating) {
      const kit = this.breakerKit();
      b = new SpaceBuilder(cx, cz);
      for (const [side, up, r] of rocks) {
        b.addBody(kit.lib.pick('rock'), { x: cx + (rx * side) / S, y: (py + up) / S, z: cz + (rz * side) / S, radius: r / S,
          color: 0x1a1c1f, spin: [R_(-1, 1), R_(-1, 1), R_(-1, 1), R_(0.1, 0.35)], tag: 'rock' });
      }
      item = w.addDynamic(b, (rocks.length > 1 ? 9 : 2) * R / S, kit.mat);
    } else {
      b = new ChunkBuilder(0, 0, 1);
      b.centerX = cx; b.centerZ = cz;
      for (const [side, , r] of rocks) {
        const big = r / S > 45;
        b.addRock(w.rocks.pick(big ? 'peak' : 'spire', Math.random), {
          x: cx + (rx * side) / S, z: cz + (rz * side) / S, radius: r / S,
          height: Math.max(py * 1.5 + 900, r * 2.4) / S, rotY: R_(0, 6.28), color: 0x17191c, tag: big ? 'mountain' : 'rock',
        });
      }
      item = w.addDynamic(b, 4 * R / S);
    }
    item.breaker = true;
    item.rise = { t: 0, dur: B.rise, floating, y: floating ? py : 0 };
    if (floating) { item.group.scale.setScalar(S * 0.02); item.group.position.y = py * 0.98; } else item.group.scale.y = S * 0.02;
    this.items.push(item);
    // the regular path events give the breaker room
    this.next = Math.max(this.next, this.flown + v * 1.2);
    const marker = { x: px, y: py, z: pz, r: R, item, kind, course: course.kind, fx, fz };
    this.breakers.push(marker);
    return marker;
  }

  pickPattern(tier, difficulty, weights = PATH.patterns, table = PATTERNS) {
    // walls (and orbital belts) only once you are fast or deep into the run
    const entries = Object.entries(weights).filter(([k]) => table[k] && ((k !== 'wall' && k !== 'belt') || tierLevel(tier) >= 3 || difficulty > 0.35));
    let t = Math.random() * entries.reduce((s, e) => s + e[1], 0);
    for (const [k, wgt] of entries) if ((t -= wgt) <= 0) return k;
    return 'spire';
  }

  spawn(player, difficulty) {
    const w = this.world;
    const tier = player.speedSys.tier;
    const ax = player.pos.x + w.origin.x, az = player.pos.z + w.origin.z;
    const f = player.flatForward, r = player.right;
    const ahead = Math.min(5200 * S, Math.max(1400 * S, w.viewDistance(tier) * 0.9));
    const cx = ax + f.x * ahead, cz = az + f.z * ahead;          // absolute
    const bx = cx / S, bz = cz / S;                              // base meters
    if (w.isReserved(bx, bz, 300)) return false;
    // don't stack on top of existing terrain
    if (w.collide(cx, FLIGHT.altitude, cz, 160 * S)) return false;

    const kind = this.pickPattern(tier, difficulty);
    const b = new ChunkBuilder(0, 0, 1);
    b.centerX = bx; b.centerZ = bz;
    const ctx = {
      id: ++this.spawned,
      difficulty,
      heading: player.heading,
      /** base-meter position `along` the path and `side` meters to the right */
      at: (along, side) => [bx + f.x * along + r.x * side, bz + f.z * along + r.z * side],
      /** lateral offset for a single obstacle: on your line, or a near miss */
      single: (radius) => (Math.random() < PATH.inPathChance ? R(-0.4, 0.4) * radius : sign() * R(radius + 50, radius + 320)),
      rock: (bb, k, along, side, radius, height, tag = 'rock') => {
        const [x, z] = ctx.at(along, side);
        bb.addRock(w.rocks.pick(k, Math.random), { x, z, radius, height, rotY: R(0, 6.28), color: k === 'peak' ? 0x1c1e21 : 0x17191c, tag });
      },
    };
    const reach = PATTERNS[kind](b, ctx);
    this.items.push(w.addDynamic(b, reach));
    this.lastKind = kind;
    return true;
  }

  /** an orbital event ahead along your heading, at your altitude */
  spawnOrbit(player, difficulty, kind = null) {
    const w = this.world, sp = this.space;
    const tier = player.speedSys.tier;
    const ax = player.pos.x + w.origin.x, az = player.pos.z + w.origin.z, ay = player.pos.y;
    const f = player.flatForward, r = player.right;
    const ahead = Math.min(5200 * S, Math.max(1400 * S, w.viewDistance(tier) * 0.9));
    const cx = ax + f.x * ahead, cz = az + f.z * ahead;
    if (w.collide(cx, ay, cz, 160 * S)) return false;        // a field rock is already there
    kind = kind || this.pickPattern(tier, difficulty, SPACE.patterns, SPACE_PATTERNS);
    const bx = cx / S, by = ay / S, bz = cz / S;
    const b = new SpaceBuilder(bx, bz);
    const lib = sp.library;
    const grays = [0x5b5f66, 0x676c73, 0x50545a];
    const spin = (lo, hi) => [R(-1, 1), R(-1, 1), R(-1, 1), R(lo, hi)];
    const ctx = {
      id: ++this.spawned,
      difficulty,
      heading: player.heading,
      at: (along, side, up) => [bx + f.x * along + r.x * side, by + up, bz + f.z * along + r.z * side],
      offset: (radius) => {
        if (Math.random() < SPACE.inPathChance) return [R(-0.4, 0.4) * radius, R(-0.4, 0.4) * radius];
        const a = Math.random() * Math.PI * 2, d = R(radius + 50, radius + 320);
        return [Math.cos(a) * d, Math.sin(a) * d];
      },
      rock: (bb, along, side, up, radius) => {
        const [x, y, z] = ctx.at(along, side, up);
        bb.addBody(lib.pick('rock'), { x, y, z, radius, color: grays[Math.floor(Math.random() * grays.length)], spin: spin(0.05, 0.4) });
      },
      moon: (bb, along, side, up, radius) => {
        const [x, y, z] = ctx.at(along, side, up);
        bb.addBody(lib.pick('moon'), { x, y, z, radius, color: 0xc3c8ce, spin: [R(-0.3, 0.3), 1, R(-0.3, 0.3), R(0.015, 0.05)], tag: 'moon' });
      },
      ring: (bb, along, side, up) => {
        const [x, y, z] = ctx.at(along, side, up);
        bb.addRing({ x, y, z, heading: player.heading, radius: R(62, 74), tube: 5, id: `pring:${ctx.id}:${along}` });
      },
    };
    const reach = SPACE_PATTERNS[kind](b, ctx);
    const item = w.addDynamic(b, reach, sp.materials);
    item.orbit = true;
    this.items.push(item);
    this.lastKind = kind;
    return true;
  }
}
