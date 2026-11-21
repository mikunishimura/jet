// Client side of co-op. Owns the connection and everything remote; the game
// only calls a few hooks (Game.js: beforePlayer, update, rebase, spawn, ...).
//
// Per frame (O(members + their enemies), no allocations on the hot path):
//   * clock: slewed server time
//   * teammates: dead-reckoned + error-blended pose (predict.js) -> jet model,
//     contrails, cosmetic tracers when they fire
//   * their enemies: re-anchored on our prediction of the owner's jet
//   * us: the squad line's flow current + rubber band (squad.js), the shared
//     barrier (SpeedSystem follow mode), our state at a fixed rate (not per
//     frame: identical traffic at 60 or 360 fps), our enemies at a fixed rate
import * as THREE from 'three';
import { SQUAD, TIERS, FLIGHT, tierLevel } from '../config.js';
import { PROTOCOL_VERSION, BIN, SF, MF, encodeState, decodeState, encodeEnemies, decodeEnemies, decodeSquad, encodePing } from './protocol.js';
import { ClockSync } from './clock.js';
import { RemoteTrack } from './predict.js';
import { consensus, cohesion, slot, dirOf } from './squad.js';
import { WebSocketTransport } from './transport.js';
import { GhostEnemy, kindIndex } from './GhostEnemy.js';
import { JetModel } from '../render/JetModel.js';
import { WEAPONS } from '../config.js';

const wallS = () => performance.now() / 1000;
const _st = {};
const _en = { list: [] };
const _v = new THREE.Vector3();

class Remote {
  constructor(id, name, skin, bot) {
    // older servers don't relay the bot flag: demo wingmen are also known by name
    this.id = id; this.name = name; this.skin = skin; this.bot = bot ?? /^(bot|wing)-/.test(name);
    this.track = new RemoteTrack();
    this.state = null;
    this.jet = null;
    this.flying = false;
    this.abs = { x: 0, y: 0, z: 0 };
    this.avatar = {
      pos: new THREE.Vector3(), heading: 0, pitch: 0, steer: 0, vstick: 0, alive: true, throttle: true, braking: false,
      speedSys: { level: 1, tier: 1, charge: 0 },
    };
    this.ghosts = new Map();     // their enemy id -> GhostEnemy
    this.enemyPacket = null;
    this.fireAcc = 0; this.muzzle = 1;
    this.aligned = false; this.draft = false;
  }
}

export class NetSession {
  /** opts: { url, name, room, skin } */
  constructor(game, opts) {
    this.game = game;
    this.opts = opts;
    this.clock = new ClockSync();
    this.members = new Map();
    this.id = 0; this.seed = 1; this.space = true;
    this.ready = false; this.closed = false;
    this.status = 'connecting';
    this.squad = null;
    this.acc = { state: 0, enemy: 0, ping: 0 };
    this.seq = 0; this.eseq = 0;
    this.killed = new Map();     // `${owner}:${rid}` -> time of our predicted kill
    this.line = { n: 0 };
    this.flow = { vx: 0, vy: 0, vz: 0, k: 1, pull: 0, lateral: 0, along: 0 };
    this.rate = { heading: null, pitch: 0, yaw: 0, pitchRate: 0 };
    this.stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, updateMs: 0, pings: 0 };
    this.connect();
  }

  get rtt() { return this.clock.rtt; }
  get now() { return this.clock.now(wallS()); }
  /** flying in a co-op run right now (vs the menu's attract run) */
  get active() { const g = this.game; return this.ready && g.state !== 'menu' && !g.attract; }

  connect() {
    const t = this.transport = new WebSocketTransport(this.opts.url);
    t.onopen = () => {
      this.status = 'handshake';
      this.sendText({ t: 'hello', v: PROTOCOL_VERSION, name: this.opts.name, room: this.opts.room, skin: this.opts.skin, bot: !!this.opts.bot });
    };
    t.ontext = (s) => this.onText(s);
    t.onbinary = (b) => this.onBinary(b);
    t.onclose = (reason) => {
      const was = this.ready;
      this.ready = false; this.status = `offline · ${reason}`;
      for (const r of [...this.members.values()]) this.removeRemote(r);
      this.game.onNetChange?.();
      if (was) this.game.hud.toast('CO-OP LINK LOST', 'warn');
      if (!this.closed) setTimeout(() => !this.closed && this.connect(), 2000);
    };
  }

  close() { this.closed = true; this.transport?.close(); }

  sendText(o) { const s = JSON.stringify(o); this.transport.send(s); this.stats.framesOut++; this.stats.bytesOut += s.length; }
  sendBin(buf) { this.transport.send(buf); this.stats.framesOut++; this.stats.bytesOut += buf.byteLength; }

  // ------------------------------------------------------------ inbound
  onText(s) {
    let e; try { e = JSON.parse(s); } catch { return; }
    this.stats.framesIn++; this.stats.bytesIn += s.length;
    const g = this.game;
    switch (e.t) {
      case 'welcome':
        this.id = e.id; this.seed = e.seed; this.space = e.space; this.room = e.room;
        for (const m of e.members) if (m.id !== this.id) this.members.set(m.id, new Remote(m.id, m.name, m.skin, m.bot));
        this.ready = true; this.status = 'online';
        this.clock.samples.length = 0; this.clock.synced = false;
        for (let i = 0; i < 6; i++) setTimeout(() => this.ping(), i * 60); // quick clock lock
        g.onNetChange?.();
        break;
      case 'join':
        if (e.id !== this.id) this.members.set(e.id, new Remote(e.id, e.name, e.skin, e.bot));
        g.hud.toast(`${e.name} joined the squad`, 'good');
        g.onNetChange?.();
        break;
      case 'leave': {
        const r = this.members.get(e.id);
        if (r) { g.hud.toast(`${r.name} left the squad`, 'info'); this.removeRemote(r); }
        g.onNetChange?.();
        break;
      }
      case 'hz': if (this.active) g.hazards.applyEvent(e); break;
      case 'wave': if (this.active && g.player.alive && g.player.speedSys.engaged) g.enemies.spawnWave(e.kind, e.difficulty); break;
      case 'hit': {                                   // a teammate hit one of OUR enemies
        const en = g.enemies.list.find((x) => !x.ghost && x.alive && x.id === e.id);
        if (!en) break;
        en.damage(e.kill ? Math.max(e.dmg, en.hp) : e.dmg, e.src || 'gun', null, e.from);
        break;
      }
      case 'kill':
        if (e.by === this.id) g.creditKill?.(e.name, e.score);
        else g.hud.toast(`${this.nameOf(e.by)} · ${String(e.name).toLowerCase()} down`, 'info');
        break;
      case 'msl': this.ghostMissile(e); break;
      case 'tier': if (!e.up && this.active) g.hud.toast(`squad hit · tier ${TIERS[e.tier - 1]?.roman || e.tier}`, 'danger'); break;
      default: break;
    }
  }

  onBinary(buf) {
    this.stats.framesIn++; this.stats.bytesIn += buf.byteLength;
    const d = new DataView(buf);
    switch (d.getUint8(0)) {
      case BIN.STATE: {
        const s = decodeState(d, _st);
        const r = this.members.get(s.id);
        if (!r) break;
        r.track.push(s, this.now);
        r.state = Object.assign(r.state || {}, s);
        break;
      }
      case BIN.ENEMIES: {
        const p = decodeEnemies(d, _en);
        const r = this.members.get(p.id);
        if (r) this.applyEnemies(r, p);
        break;
      }
      case BIN.SQUAD: {
        this.squad = decodeSquad(d, this.squad || { members: [] });
        for (const m of this.squad.members) {
          const r = this.members.get(m.id);
          if (r) { r.aligned = !!(m.flags & MF.ALIGNED); r.draft = !!(m.flags & MF.DRAFT); }
          else if (m.id === this.id) { this.aligned = !!(m.flags & MF.ALIGNED); this.draft = !!(m.flags & MF.DRAFT); }
        }
        break;
      }
      case BIN.PONG: this.clock.sample(d.getFloat64(4, true), d.getFloat64(12, true), wallS()); break;
      default: break;
    }
  }

  ping() { if (this.transport.open) { this.sendBin(encodePing(wallS())); this.stats.pings++; } }

  nameOf(id) { return id === this.id ? 'you' : this.members.get(id)?.name || `#${id}`; }

  removeRemote(r) {
    r.jet?.dispose(); r.jet = null;
    for (const gh of r.ghosts.values()) gh.dispose();
    r.ghosts.clear();
    this.members.delete(r.id);
  }

  // ------------------------------------------------------------ enemies
  applyEnemies(r, p) {
    const g = this.game, t = g.time;
    r.enemyPacket = { t: p.t, list: p.list.map((e) => ({ ...e })) };
    const seen = new Set();
    for (const e of r.enemyPacket.list) {
      seen.add(e.id);
      let gh = r.ghosts.get(e.id);
      if (!gh) {
        const k = this.killed.get(`${r.id}:${e.id}`);
        if (k !== undefined && t - k < 1.2) continue;    // we just shot it down: wait for the owner to agree
        if (!this.active) continue;
        gh = new GhostEnemy(g, this, r.id, e.id, e.kind);
        r.ghosts.set(e.id, gh);
        g.enemies.list.push(gh);
      }
      const hp = e.hp01 * gh.maxHp;
      gh.hp = t - gh.localHitT < 0.6 ? Math.min(gh.hp, hp) : hp;  // keep our predicted damage until the owner catches up
      gh.data = e;
    }
    for (const [id, gh] of r.ghosts) if (!seen.has(id)) { if (gh.alive) gh.dispose(); r.ghosts.delete(id); }
  }

  /** an enemy owned by teammate r, placed on our prediction of r's jet */
  placeGhosts(r, now) {
    const P = r.enemyPacket, o = this.game.world.origin, s = r.state;
    if (!P) return;
    const age = Math.max(0, Math.min(0.3, now - P.t));
    for (const gh of r.ghosts.values()) {
      const e = gh.data;
      if (!e || !gh.alive) continue;
      gh.pos.set(r.abs.x + e.rx + e.rvx * age - o.x, r.abs.y + e.ry + e.rvy * age, r.abs.z + e.rz + e.rvz * age - o.z);
      gh.vel.set((s?.vx || 0) + e.rvx, (s?.vy || 0) + e.rvy, (s?.vz || 0) + e.rvz);
      gh.mesh.rotation.set(e.pitch, e.yaw, e.roll);
    }
  }

  claimHit(gh, dmg, src, kill) { this.sendText({ t: 'hit', to: gh.owner, id: gh.rid, dmg: Math.round(dmg * 10) / 10, src, kill }); }
  predictedKill(gh) { this.killed.set(`${gh.owner}:${gh.rid}`, this.game.time); }
  /** one of OUR enemies was finished by teammate `by`: they get the credit */
  creditTeammate(by, enemy) { this.sendText({ t: 'kill', by, name: enemy.name, score: enemy.score }); }
  bonus(add) { this.sendText({ t: 'bonus', add }); }
  /** we launched a kill missile: teammates draw it */
  sendMissile(target) {
    if (!target) return;
    this.sendText(target.ghost ? { t: 'msl', o: target.owner, id: target.rid } : { t: 'msl', o: this.id, id: target.id });
  }

  ghostMissile(e) {
    const g = this.game, r = this.members.get(e.from);
    if (!r || !r.flying) return;
    const target = e.o === this.id ? g.enemies.list.find((x) => !x.ghost && x.alive && x.id === e.id) : this.members.get(e.o)?.ghosts.get(e.id);
    if (!target || !target.alive) return;
    const origin = r.avatar.pos.clone();
    const K = WEAPONS.lockedMissile;
    const vel = _v.subVectors(target.pos, origin).normalize().multiplyScalar(K.speed * 0.5).add(g.player.vel).clone();
    g.projectiles.missile('ghost', origin, vel, target, { relSpeed: K.speed, accel: K.accel, turnRate: K.turnRate, damage: 0, splash: 0, prox: K.prox, life: K.life, armDelay: 0, kill: true });
  }

  // ------------------------------------------------------------ per frame
  /** before the player integrates: squad barrier (follow) + flow current */
  beforePlayer() {
    const g = this.game, p = g.player, s = p.speedSys;
    if (!this.active) { s.follow = null; p.flow = null; return; }
    const q = this.squad;
    if (q) {
      const ahead = Math.max(0, Math.min(0.25, this.now - q.t));
      const f = s.follow || (s.follow = {});
      f.tier = q.tier; f.charge = Math.min(0.999, Math.max(0, q.charge + q.chargeRate * ahead));
      f.refHeading = q.refHeading; f.refPitch = q.refPitch;
    } else if (!s.follow) s.follow = { tier: s.tier, charge: 0, refHeading: p.heading, refPitch: p.pitch };
    // the squad line from the OTHER flying members (you don't pull on yourself)
    const list = [];
    for (const r of this.members.values()) if (r.flying) list.push({ flying: true, x: r.abs.x, y: r.abs.y, z: r.abs.z, heading: r.avatar.heading, pitch: r.avatar.pitch, speed: r.state.speed });
    this.line = consensus(list, this.line);
    if (this.line.n && p.alive && s.engaged) {
      const o = g.world.origin;
      cohesion(p.pos.x + o.x, p.pos.y, p.pos.z + o.z, Math.max(s.speed, 1), this.line, SQUAD, this.flow, p.heading);
      // never push into the floor or the ceiling
      if (p.pos.y < FLIGHT.minAltitude + 30 && this.flow.vy < 0) this.flow.vy = 0;
      if (p.pos.y > FLIGHT.ceiling - 30 && this.flow.vy > 0) this.flow.vy = 0;
      p.flow = this.flow;
    } else p.flow = null;
  }

  /** after the player moved: teammates, their enemies, cosmetics, our outbound frames */
  update(dt, real) {
    const t0 = performance.now();
    const g = this.game;
    this.clock.tick(real);
    this.acc.ping += real;
    if (this.acc.ping > (this.clock.samples.length < 8 ? 0.15 : 1)) { this.acc.ping = 0; this.ping(); }
    if (!this.ready) return;
    const now = this.now, o = g.world.origin, active = this.active;
    for (const r of this.members.values()) {
      const s = r.state;
      r.flying = active && !!s && (s.flags & SF.FLYING) && (s.flags & SF.ALIVE) && (s.flags & SF.ENGAGED) && r.track.has;
      if (r.flying) {
        const pose = r.track.update(now, real);
        r.abs.x = pose.x; r.abs.y = Math.max(FLIGHT.minAltitude, pose.y); r.abs.z = pose.z;
        const a = r.avatar;
        a.pos.set(r.abs.x - o.x, r.abs.y, r.abs.z - o.z);
        a.heading = pose.heading; a.pitch = pose.pitch; a.steer = s.steer; a.vstick = s.vstick;
        a.alive = true; a.throttle = !!(s.flags & SF.THROTTLE); a.braking = !!(s.flags & SF.BRAKING);
        a.speedSys.tier = s.tier; a.speedSys.level = tierLevel(s.tier); a.speedSys.charge = this.squad?.charge || 0;
        if (!r.jet) r.jet = new JetModel(g.scene, r.skin || undefined);
        r.jet.update(real, a, true);
        this.placeGhosts(r, now);
        this.remoteFire(r, real);
      } else if (r.jet) { r.avatar.alive = false; r.jet.update(real, r.avatar, false); }
    }
    for (const [k, t] of this.killed) if (g.time - t > 3) this.killed.delete(k);
    // outbound at fixed rates
    this.acc.state += real; this.acc.enemy += real;
    const stateDt = 1 / (active ? SQUAD.stateHz : 4);
    if (this.acc.state >= stateDt) { this.acc.state %= stateDt; this.sendState(now, active); }
    if (active && this.acc.enemy >= 1 / SQUAD.enemyHz) { this.acc.enemy %= 1 / SQUAD.enemyHz; this.sendEnemies(now); }
    const sys = g.player.speedSys;
    if (sys.dropRequested) { sys.dropRequested = false; if (active && !g.god) this.sendText({ t: 'crash' }); } // god-mode bots never cost the squad a tier
    this.stats.updateMs = this.stats.updateMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** a teammate's gun: cosmetic tracers from their muzzles along their aim (no damage) */
  remoteFire(r, real) {
    const s = r.state;
    if (!(s.flags & SF.FIRING)) { r.fireAcc = 0; return; }
    const W = WEAPONS.minigun, g = this.game;
    r.fireAcc += real * W.rate;
    const d = dirOf(s.aimYaw, s.aimPitch);
    while (r.fireAcc >= 1) {
      r.fireAcc -= 1;
      r.muzzle = -r.muzzle;
      const hp = r.jet.hardpoints.gun[r.muzzle < 0 ? 0 : 1];
      const origin = r.jet.hardpoint(hp, r.avatar, new THREE.Vector3());
      const vel = new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(W.speed).add(_v.set(s.vx, s.vy, s.vz));
      g.projectiles.bullet('ghost', origin, vel, 0, 0x6b7178, W.range / W.speed);
    }
  }

  sendState(now, active) {
    const g = this.game, p = g.player, s = p.speedSys, o = g.world.origin;
    // turn rates from the actual frame-to-frame change (includes gusts and collisions)
    const R = this.rate, tw = wallS();
    if (R.heading !== null && tw - R.tw > 1e-3) {
      const dh = Math.atan2(Math.sin(p.heading - R.heading), Math.cos(p.heading - R.heading));
      R.yaw = dh / (tw - R.tw); R.pitchRate = (p.pitch - R.pitch) / (tw - R.tw);
    }
    R.heading = p.heading; R.pitch = p.pitch; R.tw = tw;
    const aim = g.rig?.aimDir || p.forward;
    const flying = active && g.state === 'playing';
    let own = 0;
    for (const e of g.enemies.list) if (!e.ghost && e.alive) own++;
    this.sendBin(encodeState({
      seq: ++this.seq, t: now,
      x: p.pos.x + o.x, y: p.pos.y, z: p.pos.z + o.z,
      vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
      heading: p.heading, pitch: p.pitch, yawRate: R.yaw || 0, pitchRate: R.pitchRate || 0,
      steer: p.steer, vstick: p.vstick, speed: s.speed * (p.flow?.k || 1), tier: s.tier,
      flags: (p.alive ? SF.ALIVE : 0) | (s.engaged ? SF.ENGAGED : 0) | (g.weapons.firing ? SF.FIRING : 0) | (p.braking ? SF.BRAKING : 0) | (p.throttle ? SF.THROTTLE : 0) | (flying ? SF.FLYING : 0),
      aimYaw: Math.atan2(-aim.x, -aim.z), aimPitch: Math.asin(Math.max(-1, Math.min(1, aim.y))),
      hp: p.health, enemies: own,
    }));
  }

  sendEnemies(now) {
    const g = this.game, p = g.player;
    const list = [];
    for (const e of g.enemies.list) {
      if (e.ghost || !e.alive || list.length >= 64) continue;
      list.push({
        id: e.id, kind: kindIndex(e.name), hp01: Math.max(0, e.hp / e.maxHp),
        rx: e.pos.x - p.pos.x, ry: e.pos.y - p.pos.y, rz: e.pos.z - p.pos.z,
        rvx: e.vel.x - p.vel.x, rvy: e.vel.y - p.vel.y, rvz: e.vel.z - p.vel.z,
        yaw: e.mesh.rotation.y, pitch: e.mesh.rotation.x, roll: e.mesh.rotation.z,
      });
    }
    this.sendBin(encodeEnemies(now, ++this.eseq, list));
  }

  /** (re)spawn: slot in formation on the squad line, or at the origin when nobody flies */
  spawnPoint() {
    const ids = [this.id, ...this.members.keys()].sort((a, b) => a - b);
    const k = ids.indexOf(this.id);
    const list = [];
    for (const r of this.members.values()) {
      const s = r.state;
      if (s && (s.flags & SF.FLYING) && (s.flags & SF.ALIVE) && r.track.has) {
        const pose = RemoteTrack.predict(r.track.s, this.now, SQUAD.predict.maxExtrap, {});
        list.push({ flying: true, x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, pitch: 0, speed: s.speed });
      }
    }
    const line = consensus(list, {});
    const heading = line.n ? line.heading : 0;
    const [side, up, back] = slot(line.n ? Math.max(1, k) : k);
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = Math.cos(heading), rz = -Math.sin(heading);
    const cx = line.n ? line.cx : 0, cz = line.n ? line.cz : 0, cy = line.n ? Math.max(FLIGHT.minAltitude + 50, line.cy) : FLIGHT.altitude;
    return { x: cx + rx * side - fx * back, y: cy + up, z: cz + rz * side - fz * back, heading, joining: line.n > 0, speed: line.speed || 0 };
  }

  /**
   * Demo wingman (?bot): where to fly. The first human pilot flying is the
   * leader; bots take formation slots on them (alternating sides, stepping
   * back). Null when no human flies (the bot then flies the squad line alone).
   * Returns absolute { x, y, z } of the slot plus the leader's heading / speed.
   */
  wingTarget(out = {}) {
    let lead = null;
    for (const r of this.members.values()) if (r.flying && !r.bot && (!lead || r.id < lead.id)) lead = r;
    if (!lead) return null;
    const bots = [this.id, ...[...this.members.values()].filter((r) => r.bot).map((r) => r.id)].sort((a, b) => a - b);
    const [side, up, back] = slot(1 + bots.indexOf(this.id), { side: 650, up: 40, back: 420 });
    const h = lead.avatar.heading, fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
    out.x = lead.abs.x + rx * side - fx * back; out.y = lead.abs.y + up; out.z = lead.abs.z + rz * side - fz * back;
    out.heading = h; out.fx = fx; out.fz = fz; out.speed = lead.state.speed; out.name = lead.name;
    return out;
  }

  /** a reset wiped the enemy list: our ghost maps must forget them too */
  onReset() { for (const r of this.members.values()) r.ghosts.clear(); this.killed.clear(); this.rate.heading = null; }

  rebase(dx, dz) { for (const r of this.members.values()) r.jet?.rebase(dx, dz); }

  // ------------------------------------------------------------ HUD
  /** teammates: ink diamonds with name + distance, chevrons at the edge when off screen */
  drawOverlay(hud, ctx, cam, W, H, dpr) {
    if (!this.active) return;
    const p = this.game.player, INK = '#15171a', INK2 = '#5b6168';
    for (const r of this.members.values()) {
      if (!r.flying) continue;
      const pos = r.avatar.pos, d = pos.distanceTo(p.pos);
      const pr = hud.project(pos, cam);
      const label = `${r.name} ${d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`}${r.aligned ? '' : ' · off line'}`;
      if (pr.behind || pr.x < 0 || pr.x > W || pr.y < 0 || pr.y > H) {
        _v.copy(pos).applyMatrix4(cam.matrixWorldInverse);
        let ax = _v.x, ay = -_v.y; const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l;
        const m = 40 * dpr, k = Math.min((W / 2 - m) / Math.max(1e-3, Math.abs(ax)), (H / 2 - m) / Math.max(1e-3, Math.abs(ay)));
        const x = W / 2 + ax * k, y = H / 2 + ay * k;
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(ay, ax));
        hud.stroke(ctx, INK, 1.8, () => { const s = 8 * dpr; ctx.beginPath(); ctx.moveTo(-s * 0.6, -s); ctx.lineTo(s * 0.5, 0); ctx.lineTo(-s * 0.6, s); });
        ctx.restore();
        ctx.save(); ctx.textAlign = 'center'; hud.label(ctx, r.name, x - ax * 22 * dpr, y - ay * 22 * dpr + 4 * dpr, INK2); ctx.restore();
        continue;
      }
      const s = Math.max(7 * dpr, Math.min(16 * dpr, 2400 * dpr / Math.max(1, d) * 6));
      hud.stroke(ctx, INK, 1.6, () => { ctx.beginPath(); ctx.moveTo(pr.x, pr.y - s); ctx.lineTo(pr.x + s, pr.y); ctx.lineTo(pr.x, pr.y + s); ctx.lineTo(pr.x - s, pr.y); ctx.closePath(); });
      if (r.draft) hud.stroke(ctx, INK, 1, () => { ctx.beginPath(); ctx.arc(pr.x, pr.y, s * 1.7, 0, Math.PI * 2); });
      hud.label(ctx, label, pr.x + s + 5 * dpr, pr.y + 4 * dpr, r.aligned ? INK : INK2);
    }
  }

  /** extra lines for the stats block */
  hudText() {
    if (!this.ready) return `<span class="d">co-op </span>${this.status}`;
    const flying = [...this.members.values()].filter((r) => r.flying);
    const onLine = flying.filter((r) => r.aligned).length + (this.aligned ? 1 : 0);
    const f = this.flow;
    const drift = this.active && this.game.player.flow && f.pull > 0.15 ? ` <span class="d">· drift</span> ${Math.round(f.lateral / 100) / 10} km` : '';
    return `<span class="d">squad </span>${flying.length + 1} · on line ${onLine}/${flying.length + 1}${this.draft ? ' · <b>draft</b>' : ''}${drift}\n` +
      `<span class="d">link  </span>${Math.round(this.rtt * 1000)} ms`;
  }
}
