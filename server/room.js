// One co-op squad. Transport-agnostic: a member is { id, name, skin, send(data) }
// where data is an ArrayBuffer/Uint8Array (binary hot frame) or a string
// (JSON event). The WebSocket front end (server/index.js) wires sockets to
// it today; a cloud build can wire WebRTC / WebTransport the same way.
//
// Authority split:
//   * each client owns its own jet and the enemies attacking it (no latency
//     where it matters); the room RELAYS those snapshots untouched
//   * the room owns the squad: the shared barrier (tier, charge, squad line),
//     the obstacle events planned along the squad line, and the enemy-wave
//     director (which member gets the next wave)
import { BIN, SF, MF, decodeState, encodeSquad, encodePong } from '../src/net/protocol.js';
import { SquadBarrier, consensus, bandOf, chargeRateOf, pickPattern, eventInterval, viewDistanceFor } from '../src/net/squad.js';
import { SQUAD, PATH, SPACE, FLIGHT, WORLD_SCALE, DIRECTOR, ALTITUDE } from '../src/config.js';
import { mulberry32 } from '../src/core/rng.js';

const S = WORLD_SCALE;
const lerp = (a, b, t) => a + (b - a) * t;

export class Room {
  constructor(name, { seed = (Math.random() * 1e9) | 0, space = true, now = () => 0 } = {}) {
    this.name = name;
    this.seed = seed;
    this.space = space;
    this.now = now;
    this.members = new Map();   // id -> member
    this.rng = mulberry32(seed ^ 0x51ab);
    this.barrier = new SquadBarrier();
    this.line = { n: 0 };
    this.squadSeq = 0;
    this.sinceSquad = 0;
    this.stats = { relayed: 0, bytesIn: 0, bytesOut: 0, ticks: 0, tickMs: 0, maxTickMs: 0 };
    this.resetSquad();
  }

  get size() { return this.members.size; }

  resetSquad() {
    this.barrier.reset(this.line.heading || 0, this.line.pitch || 0);
    this.hz = { flown: 0, next: PATH.firstAfter, id: 0 };
    this.director = { wave: DIRECTOR.firstWave, time: 0, difficulty: 0 };
  }

  nextId() { for (let i = 1; i < 256; i++) if (!this.members.has(i)) return i; return 0; }

  /** returns the member, or null when the room is full */
  join(member, hello) {
    if (this.members.size >= SQUAD.maxMembers) return null;
    member.id = this.nextId();
    member.name = String(hello.name || `pilot ${member.id}`).slice(0, 16);
    member.skin = String(hello.skin || '');
    member.bot = !!hello.bot;                       // demo wingmen (?bot windows)
    member.state = null;
    member.joined = this.now();
    this.members.set(member.id, member);
    member.send(JSON.stringify({
      t: 'welcome', id: member.id, room: this.name, seed: this.seed, space: this.space, now: this.now(),
      members: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, skin: m.skin, bot: m.bot })),
      squad: { tier: this.barrier.tier, charge: this.barrier.charge },
    }));
    this.broadcast(JSON.stringify({ t: 'join', id: member.id, name: member.name, skin: member.skin, bot: member.bot }), member);
    return member;
  }

  leave(member) {
    if (!this.members.delete(member.id)) return;
    this.broadcast(JSON.stringify({ t: 'leave', id: member.id }));
  }

  broadcast(data, except = null) {
    for (const m of this.members.values()) if (m !== except) { m.send(data); this.stats.bytesOut += data.byteLength ?? data.length; }
  }

  /** binary hot frame from `member`. `bytes` is a Uint8Array view (mutated: sender id stamped) */
  onBinary(member, bytes) {
    this.stats.bytesIn += bytes.byteLength;
    const type = bytes[0];
    if (type === BIN.PING) {
      const t0 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(4, true);
      member.send(encodePong(t0, this.now()));
      return;
    }
    if (type === BIN.STATE || type === BIN.ENEMIES) {
      bytes[1] = member.id;                      // stamp the sender (clients can't spoof)
      if (type === BIN.STATE) {
        const wasFlying = this.flying(member);
        member.state = decodeState(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), member.state || {});
        member.lastState = this.now();
        if (!wasFlying && this.flying(member) && this.flyingCount() === 1) this.resetSquad(); // first one up: a fresh run
      }
      this.stats.relayed++;
      this.broadcast(bytes, member);               // relay as-is: lowest latency, no re-encode
    }
  }

  /** JSON event from `member` */
  onText(member, msg) {
    let e;
    try { e = JSON.parse(msg); } catch { return; }
    switch (e.t) {
      case 'hit': {                                 // shooter-favored: forward the claim to the enemy's owner
        const to = this.members.get(e.to);
        if (to) to.send(JSON.stringify({ t: 'hit', from: member.id, id: e.id, dmg: +e.dmg || 0, src: e.src, kill: !!e.kill }));
        break;
      }
      case 'kill': case 'msl': case 'fx':            // cosmetic / credit: everyone else hears it
        e.from = member.id;
        this.broadcast(JSON.stringify(e), member);
        break;
      case 'bonus': this.barrier.bonus(Math.max(0, Math.min(0.5, +e.add || 0))); break;
      case 'crash': this.tierEvents(this.barrier.drop()); break;
      default: break;
    }
  }

  flying(m) { const s = m.state; return !!s && (s.flags & SF.FLYING) && (s.flags & SF.ALIVE) && (s.flags & SF.ENGAGED) && this.now() - m.lastState < 2; }
  flyingCount() { let n = 0; for (const m of this.members.values()) if (this.flying(m)) n++; return n; }

  tierEvents(events) {
    for (const ev of events) this.broadcast(JSON.stringify({ t: 'tier', tier: ev.tier, up: ev.type === 'tierUp', reason: ev.reason || 'squad' }));
  }

  /** squad simulation step */
  tick(dt) {
    const t0 = performance.now();
    const now = this.now();
    // members extrapolated to now (each snapshot is ≤ 1 frame + latency old)
    const list = [];
    for (const m of this.members.values()) {
      const s = m.state;
      if (!s) continue;
      const age = Math.max(0, Math.min(0.5, now - s.t));
      const e = m.est || (m.est = {});
      e.member = m; e.flying = this.flying(m);
      e.x = s.x + s.vx * age; e.y = s.y + s.vy * age; e.z = s.z + s.vz * age;
      e.heading = s.heading + s.yawRate * age; e.pitch = s.pitch; e.speed = s.speed;
      e.throttle = !!(s.flags & SF.THROTTLE);
      e.chargeRate = chargeRateOf(bandOf(e.y, this.space));
      e.enemies = s.enemies;
      list.push(e);
    }
    for (const a of list) {                         // drafting: a teammate within draft radius
      a.draft = false;
      if (!a.flying) continue;
      for (const b of list) if (b !== a && b.flying && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < SQUAD.draft.radius) { a.draft = true; break; }
    }
    const line = this.line = consensus(list, this.line);
    this.tierEvents(this.barrier.update(dt, list, line));
    if (line.n) {
      this.runHazards(dt, line);
      this.runDirector(dt, line, list);
    }
    this.sinceSquad += dt;
    if (this.sinceSquad >= 1 / SQUAD.squadHz) {
      this.sinceSquad = 0;
      const b = this.barrier;
      this.broadcast(encodeSquad({
        seq: ++this.squadSeq, t: now, tier: b.tier, charge: b.charge, chargeRate: b.chargeRate,
        refHeading: b.refHeading, refPitch: b.refPitch, heading: line.heading || 0, pitch: line.pitch || 0,
        ax: line.cx || 0, ay: line.cy || 0, az: line.cz || 0, hazards: this.hz.id,
        members: list.map((e) => ({ id: e.member.id, flags: (e.aligned ? MF.ALIGNED : 0) | (e.draft ? MF.DRAFT : 0) | (e.flying ? MF.FLYING : 0) })),
      }));
    }
    const ms = performance.now() - t0;
    this.stats.ticks++; this.stats.tickMs += ms; this.stats.maxTickMs = Math.max(this.stats.maxTickMs, ms);
  }

  /** obstacle events along the SQUAD line, every few seconds of squad flight */
  runHazards(dt, line) {
    const h = this.hz;
    h.flown += line.speed * dt;
    if (h.flown < h.next) return;
    const tier = this.barrier.tier, diff = this.director.difficulty;
    const orbit = this.space && line.cy > SPACE.hazardFloor;
    const ahead = Math.min(5200 * S, Math.max(1400 * S, viewDistanceFor(tier) * 0.9));
    const hx = -Math.sin(line.heading), hz = -Math.cos(line.heading);
    const ev = {
      t: 'hz', id: ++h.id, orbit,
      kind: pickPattern(orbit ? SPACE.patterns : PATH.patterns, tier, diff, this.rng),
      seed: (this.rng() * 2 ** 32) >>> 0,
      cx: line.cx + hx * ahead, cy: orbit ? line.cy : FLIGHT.altitude, cz: line.cz + hz * ahead,
      heading: line.heading, difficulty: diff,
    };
    this.broadcast(JSON.stringify(ev));
    const sec = eventInterval(orbit, diff) * (1 + (this.rng() * 2 - 1) * PATH.jitter);
    h.next = h.flown + Math.max(300 * S, line.speed * sec);
  }

  /** enemy waves for the squad: harder with time and distance, sent to the least busy member */
  runDirector(dt, line, list) {
    const d = this.director, D = DIRECTOR;
    d.time += dt;
    d.difficulty = Math.min(1, d.time / D.rampTime * 0.65 + Math.hypot(line.cx, line.cz) / D.rampDistance * 0.65);
    const band = bandOf(line.cy, this.space);
    d.wave -= dt / (band === 'high' ? ALTITUDE.waveIntervalHigh : band === 'low' ? ALTITUDE.waveIntervalLow : 1);
    if (d.wave > 0) return;
    const flying = list.filter((e) => e.flying);
    const cap = Math.round(lerp(D.maxEnemiesStart, D.maxEnemiesEnd, d.difficulty) * 0.6) + 1;
    const target = flying.filter((e) => e.enemies < Math.min(cap, SQUAD.waves.perMember + 2)).sort((a, b) => a.enemies - b.enemies)[0];
    if (!target) { d.wave = 2; return; }
    const opts = [['drones', 1.0], ['ufo', d.time > 18 ? 0.7 + d.difficulty * 0.3 : 0], ['fighters', d.time > 35 ? 0.5 + d.difficulty : 0]];
    let r = this.rng() * opts.reduce((a, o) => a + o[1], 0), kind = 'drones';
    for (const [k, w] of opts) { if ((r -= w) <= 0) { kind = k; break; } }
    target.member.send(JSON.stringify({ t: 'wave', kind, difficulty: d.difficulty }));
    // more pilots, more waves (each one still fights its own share)
    d.wave = lerp(D.intervalStart, D.intervalEnd, d.difficulty) * (0.8 + this.rng() * 0.4) / Math.max(1, Math.sqrt(flying.length));
  }
}
