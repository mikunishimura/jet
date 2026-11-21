// Co-op multiplayer: wire protocol, squad rules, prediction under real
// latency, clock sync, deterministic shared obstacles, and the live server.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as P from '../src/net/protocol.js';
import { SquadBarrier, consensus, cohesion, slot } from '../src/net/squad.js';
import { RemoteTrack } from '../src/net/predict.js';
import { ClockSync } from '../src/net/clock.js';
import { SpeedSystem } from '../src/game/SpeedSystem.js';
import { Player } from '../src/game/Player.js';
import { TIERS, SQUAD, DEG, WORLD_SCALE } from '../src/config.js';
import { mulberry32 } from '../src/core/rng.js';

const DT = 1 / 60;
const close = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

test('protocol: state / enemies / squad frames round-trip', () => {
  const s = { seq: 70000, t: 12345.678901, x: 1.23456789e7, y: 98765.5, z: -4.4e6, vx: 1, vy: -2, vz: -19000, heading: 2.5, pitch: -0.3,
    yawRate: 0.01, pitchRate: -0.02, steer: -0.4, vstick: 0.5, speed: 19000, tier: 5, flags: P.SF.ALIVE | P.SF.FIRING, aimYaw: -3.1, aimPitch: 1.2, hp: 77, enemies: 3 };
  const d = P.decodeState(P.encodeState(s));
  assert.equal(P.encodeState(s).byteLength, P.STATE_BYTES);
  for (const k of ['t', 'x', 'z']) assert.equal(d[k], s[k], k);                       // float64: exact
  for (const k of ['y', 'vx', 'vz', 'heading', 'pitch', 'speed', 'steer', 'vstick']) assert.ok(close(d[k], s[k], Math.abs(s[k]) * 1e-6 + 1e-6), k);
  assert.equal(d.seq, s.seq & 0xffff); assert.equal(d.tier, 5); assert.equal(d.flags, s.flags); assert.equal(d.hp, 77); assert.equal(d.enemies, 3);
  assert.ok(close(d.aimYaw, -3.1) && close(d.aimPitch, 1.2));
  const list = [{ id: 7, kind: 1, hp01: 0.5, rx: 1500.5, ry: -30, rz: -2400.25, rvx: -120, rvy: 3, rvz: 40000, yaw: 1, pitch: -0.5, roll: 3.5 }];
  const e = P.decodeEnemies(P.encodeEnemies(9.5, 3, list));
  assert.equal(e.list.length, 1); assert.equal(e.list[0].id, 7); assert.equal(e.list[0].kind, 1);
  assert.ok(close(e.list[0].rx, 1500.5) && e.list[0].rvz === 32767, 'relative velocity clamps to int16');
  assert.ok(close(e.list[0].roll, 3.5 - 2 * Math.PI), 'angles wrap');
  const q = { seq: 1, t: 3, tier: 4, charge: 0.5, chargeRate: 0.2, refHeading: 1, refPitch: 0, heading: 1.1, pitch: 0.1, ax: 5e6, ay: 900, az: -7e6, hazards: 12, members: [{ id: 1, flags: 3 }, { id: 2, flags: 4 }] };
  const qd = P.decodeSquad(P.encodeSquad(q));
  assert.equal(qd.tier, 4); assert.equal(qd.ax, 5e6); assert.equal(qd.hazards, 12); assert.deepEqual(qd.members, q.members);
});

test('squad barrier with one member is exactly the solo speed system', () => {
  // same flight trace through both: wandering heading + pitch, with spells off the line
  const rng = mulberry32(42);
  const solo = new SpeedSystem(), squad = new SquadBarrier();
  let h = 0, p = 0, w = 0;
  const upsA = [], upsB = [];
  for (let i = 0; i < 60 * 40; i++) {
    w += (rng() - 0.5) * 0.004; w *= 0.97; h += w * DT * 30; p = 0.02 * Math.sin(i / 300);
    if (i % 900 > 760) h += 0.004;                       // periodic hard turns
    for (const e of solo.update(DT, { heading: h, pitch: p, throttle: true, brake: false, chargeRate: 1 })) if (e.type === 'tierUp') upsA.push(i);
    const m = [{ flying: true, heading: h, pitch: p, throttle: true, chargeRate: 1 }];
    for (const e of squad.update(DT, m, consensus([{ ...m[0], x: 0, y: 0, z: 0 }]))) if (e.type === 'tierUp') upsB.push(i);
    assert.ok(close(solo.charge, squad.charge, 1e-9), `frame ${i}: ${solo.charge} vs ${squad.charge}`);
  }
  assert.ok(upsA.length >= 2, `tier-ups ${upsA}`);
  assert.deepEqual(upsB, upsA);
});

test('squad barrier: everyone on the line charges fastest; a straggler halves it; drafting speeds it up', () => {
  const rate = (members) => {
    const b = new SquadBarrier(); b.tier = 3;               // charging IV
    const line = consensus(members.map((m) => ({ ...m, x: 0, y: 0, z: 0, speed: 1 })));
    b.refHeading = 0; b.refPitch = 0;
    b.update(0.1, members, line);
    return b.charge;
  };
  const on = { flying: true, heading: 0, pitch: 0, throttle: true, chargeRate: 1 };
  const off = { ...on, heading: 20 * DEG };
  const both = rate([{ ...on }, { ...on }]), half = rate([{ ...on }, { ...off }]), none = rate([{ ...off }, { ...off }]);
  assert.ok(close(half, both / 2, 1e-9), `${half} vs ${both}`);
  assert.equal(none, 0);
  const draft = rate([{ ...on, draft: true }, { ...on, draft: true }]);
  assert.ok(close(draft, both * SQUAD.draft.bonus, 1e-9));
});

test('flow current: free near the line, pulls back beyond it, bounded, never turns the nose', () => {
  const speed = 19000;
  const line = { n: 1, cx: 0, cy: 1000, cz: 0, fx: 0, fy: 0, fz: -1, heading: 0, pitch: 0, speed };
  const near = cohesion(500, 1000, 0, speed, line);
  assert.ok(near.vx === 0 && near.vy === 0, 'inside the free zone');
  const far = cohesion(60000, 1000, 0, speed, line);
  assert.ok(far.vx < 0 && far.vz === 0, 'pulls sideways toward the line only');
  assert.ok(Math.abs(far.vx) <= speed * SQUAD.flow.max + 1e-9, 'near: the soft current only');
  const lost = cohesion(speed * 60, 1000, 0, speed, line);
  assert.ok(Math.abs(lost.vx) > speed * SQUAD.flow.max * 2, 'far: the leash pulls harder');
  assert.ok(Math.abs(lost.vx) <= speed * (SQUAD.flow.max + SQUAD.flow.leash.max) + 1e-9, 'bounded: a hard turn still takes you away');
  const farther = cohesion(200000, 1000, 0, speed, line);
  assert.ok(Math.abs(farther.vx) >= Math.abs(far.vx), 'monotonic');
  const mirror = cohesion(-60000, 1000, 0, speed, line);
  assert.ok(close(mirror.vx, -far.vx), 'symmetric');
  const high = cohesion(0, 60000, 0, speed, line);
  assert.ok(high.vy < 0 && Math.abs(high.vy) < Math.abs(far.vx), 'vertical pull is gentler');
  const behind = cohesion(0, 1000, 30000, speed, line), ahead = cohesion(0, 1000, -30000, speed, line);
  assert.ok(behind.k > 1 && ahead.k < 1 && close(behind.k - 1, 1 - ahead.k), 'rubber band along the line');
  // the Player applies it as drift: heading untouched
  const pl = new Player(() => {}); pl.seedTurbulence(1);
  pl.speedSys.engaged = true; pl.speedSys.speed = speed; pl.flow = far;
  const h0 = pl.heading;
  pl.update(DT, { throttle: true }, { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] });
  assert.ok(Math.abs(pl.heading - h0) < 0.01 && pl.pos.x < 0, 'drifts toward the line without turning');
});

test('formation slots alternate sides and step back', () => {
  assert.deepEqual(slot(0), [0, 0, 0]);
  const [s1, , b1] = slot(1), [s2, , b2] = slot(2), [s3, , b3] = slot(3);
  assert.ok(s1 > 0 && s2 < 0 && Math.abs(s3) > Math.abs(s1) && b3 > b1 && b1 === b2);
});

/** fly a real Player at tier V with random stick inputs; returns per-frame truth */
function flight(seconds, seed, hz = 240) {
  const rng = mulberry32(seed), dt = 1 / hz;
  const p = new Player(() => {}); p.seedTurbulence(seed);
  p.speedSys.engaged = true; p.speedSys.tier = 5; p.speedSys.speed = TIERS[4].speed;
  p.pos.y = 5000;
  const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
  const out = [];
  let ctl = { throttle: true }, change = 0;
  for (let i = 0; i < seconds * hz; i++) {
    if ((change -= dt) <= 0) { change = 0.2 + rng() * 0.8; const r = rng(); ctl = { throttle: true, left: r < 0.3, right: r > 0.7, up: rng() < 0.15, down: rng() < 0.1 }; }
    const h0 = p.heading, p0 = p.pitch;
    p.update(dt, ctl, W);
    out.push({ t: (i + 1) * dt, x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z, heading: p.heading, pitch: p.pitch,
      yawRate: (p.heading - h0) / dt, pitchRate: (p.pitch - p0) / dt, speed: p.speed, steer: p.steer, vstick: p.vstick });
  }
  return out;
}

test('prediction: a teammate at Mach 100 shows where they ARE, through 40 ms ± 15 ms lag and 3 % loss', () => {
  const truth = flight(20, 7);
  const rng = mulberry32(99);
  const hz = 240, sendEvery = Math.round(hz / SQUAD.stateHz);
  // delivered snapshots (latency + jitter + loss), sorted by arrival
  const packets = [];
  let seq = 0;
  for (let i = sendEvery - 1; i < truth.length; i += sendEvery) {
    seq++;
    if (rng() < 0.03) continue;
    packets.push({ at: truth[i].t + 0.04 + (rng() * 2 - 1) * 0.015, s: { ...truth[i], seq } });
  }
  packets.sort((a, b) => a.at - b.at);
  const track = new RemoteTrack();
  let k = 0, lastHeld = null;
  const err = [], held = [], interp = [];
  const hist = [];
  for (let i = 0; i < truth.length; i += 2) {                // render at 120 fps
    const T = truth[i];
    while (k < packets.length && packets[k].at <= T.t) { track.push(packets[k].s, T.t); hist.push(packets[k].s); lastHeld = packets[k].s; k++; }
    if (!track.has || T.t < 1) continue;
    const r = track.update(T.t, 2 / hz);
    err.push(Math.hypot(r.x - T.x, r.y - T.y, r.z - T.z));
    held.push(Math.hypot(lastHeld.x - T.x, lastHeld.z - T.z));
    // the classic alternative: render 100 ms in the past, interpolated
    const tb = T.t - 0.1, a = hist.findLast((s) => s.t <= tb), b = hist.find((s) => s.t > tb);
    if (a && b) { const u = (tb - a.t) / (b.t - a.t); interp.push(Math.hypot(a.x + (b.x - a.x) * u - T.x, a.z + (b.z - a.z) * u - T.z)); }
  }
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const p99 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.99)];
  const report = `predicted rms ${rms(err).toFixed(1)} m (p99 ${p99(err).toFixed(1)}) · last-snapshot ${rms(held).toFixed(0)} m · interpolated(100 ms) ${rms(interp).toFixed(0)} m`;
  console.log(`  ${report}`);
  assert.ok(rms(err) < 60, report);                           // at 19 km/s: < 0.2 % of a second of flight
  assert.ok(rms(err) < rms(held) / 10 && rms(err) < rms(interp) / 10, report);
});

test('clock sync: converges to within 2 ms through asymmetric jitter', () => {
  const c = new ClockSync(), rng = mulberry32(3);
  const trueOffset = 1234.5678;
  let local = 10;
  for (let i = 0; i < 40; i++) {
    const up = 0.002 + rng() * 0.02, down = 0.002 + rng() * 0.004;   // uplink much noisier
    const t0 = local, ts = t0 + up + trueOffset, t1 = t0 + up + down;
    c.sample(t0, ts, t1);
    local = t1 + 0.1;
  }
  for (let i = 0; i < 100; i++) c.tick(0.1);
  assert.ok(Math.abs(c.offset - trueOffset) < 0.002, `${(c.offset - trueOffset) * 1000} ms`);
});

test('shared obstacles: the same server event builds identical structures on independent clients', async () => {
  const { World } = await import('../src/world/World.js');
  const { PathHazards } = await import('../src/world/PathHazards.js');
  const { BodyLibrary } = await import('../src/space/bodies.js');
  const { spaceMaterials } = await import('../src/space/materials.js');
  const client = () => {
    const w = new World(new THREE.Scene(), 77);
    const h = new PathHazards(w); h.remote = true;
    h.space = { library: new BodyLibrary(11), materials: spaceMaterials(w) };
    return h;
  };
  const sig = (h) => h.items.map((d) => d.colliders.map((c) => [c.kind, c.x, c.y ?? 0, c.z, c.r, c.top].map((v) => +(+v).toFixed(3)).join(',')).join(';') + `|${d.triggers.length}`).join('/');
  const a = client(), b = client();
  const S = WORLD_SCALE;
  const events = [
    { id: 1, orbit: false, kind: 'pair', seed: 123456, cx: 90000 * S, cy: 750, cz: -40000 * S, heading: 0.7, difficulty: 0.4 },
    { id: 2, orbit: false, kind: 'gate', seed: 99, cx: 95000 * S, cy: 750, cz: -45000 * S, heading: 0.7, difficulty: 0.4 },
    { id: 3, orbit: true, kind: 'belt', seed: 4242, cx: 1e6, cy: 90000, cz: -2e6, heading: -2.1, difficulty: 0.9 },
    { id: 4, orbit: true, kind: 'ringRun', seed: 7, cx: 1.1e6, cy: 90000, cz: -2.2e6, heading: -2.1, difficulty: 0.9 },
  ];
  for (const ev of events) { a.applyEvent({ ...ev }); b.applyEvent({ ...ev }); }
  assert.ok(a.items.length >= 3, `built ${a.items.length}`);
  assert.equal(sig(a), sig(b));
  // and a different seed gives a different structure
  const c = client(); c.applyEvent({ ...events[2], seed: 4243 });
  assert.notEqual(sig(c), sig({ items: [a.items.find((d) => d.eventId === 3)] }));
});

test('live server: relay, squad tiers, shared events (two bots, real sockets)', async () => {
  const { startServer } = await import('../server/index.js');
  const srv = startServer({ port: 0, log: () => {} });
  await new Promise((r) => srv.wss.on('listening', r));
  const port = srv.wss.address().port;
  const bot = (name) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.binaryType = 'arraybuffer';
    const b = { ws, name, texts: [], states: [], squads: [], id: 0 };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: P.PROTOCOL_VERSION, name, room: 'test' }));
    ws.onmessage = (m) => {
      if (typeof m.data === 'string') { const e = JSON.parse(m.data); b.texts.push(e); if (e.t === 'welcome') { b.id = e.id; resolve(b); } return; }
      const type = new DataView(m.data).getUint8(0);
      if (type === P.BIN.STATE) b.states.push({ ...P.decodeState(m.data), got: performance.now() });
      if (type === P.BIN.SQUAD) b.squads.push(P.decodeSquad(m.data));
    };
  });
  const A = await bot('alpha'), B = await bot('bravo');
  assert.notEqual(A.id, B.id);
  // both fly the same straight line side by side for 3.5 s
  const t0 = performance.now();
  let heading = { A: 0, B: 0 };
  const send = (b, side, h) => {
    const t = (performance.now() - t0) / 1000, v = 3000;
    b.ws.send(P.encodeState({ seq: Math.floor(t * 30), t: srv.now(), x: side, y: 750, z: -v * t, vx: -Math.sin(h) * v, vy: 0, vz: -Math.cos(h) * v, heading: h, pitch: 0,
      yawRate: 0, pitchRate: 0, steer: 0, vstick: 0, speed: v, tier: 1, flags: P.SF.ALIVE | P.SF.ENGAGED | P.SF.FLYING | P.SF.THROTTLE, aimYaw: 0, aimPitch: 0, hp: 100, enemies: 0 }));
  };
  const timer = setInterval(() => { send(A, -300, heading.A); send(B, 300, heading.B); }, 33);
  await new Promise((r) => setTimeout(r, 3500));
  const ups = A.texts.filter((e) => e.t === 'tier' && e.up).map((e) => e.tier);
  assert.ok(ups.includes(2) && ups.includes(3), `tier-ups: ${ups}`);
  assert.deepEqual(B.texts.filter((e) => e.t === 'tier').map((e) => e.tier), A.texts.filter((e) => e.t === 'tier').map((e) => e.tier), 'everyone sees the same squad tiers');
  // relay: B sees A's states, stamped with A's id, fast
  const fromA = B.states.filter((s) => s.id === A.id);
  assert.ok(fromA.length > 60, `${fromA.length} relayed states`);
  // squad state: both aligned, drafting (600 m apart)
  const q = B.squads.at(-1);
  assert.ok(q.members.every((m) => m.flags & P.MF.ALIGNED) && q.members.every((m) => m.flags & P.MF.DRAFT), JSON.stringify(q.members));
  // bravo veers 25° off: the squad charge rate halves (one of two on the line)
  const before = B.squads.at(-1).chargeRate;
  heading.B = 25 * DEG;
  await new Promise((r) => setTimeout(r, 600));
  const after = B.squads.at(-1);
  assert.ok(after.members.some((m) => !(m.flags & P.MF.ALIGNED)), 'bravo is off the line');
  if (before > 0 && after.chargeRate > 0) assert.ok(after.chargeRate < before * 0.75, `${before} -> ${after.chargeRate}`);
  // shared path events: both got the same ones
  const hzA = A.texts.filter((e) => e.t === 'hz'), hzB = B.texts.filter((e) => e.t === 'hz');
  assert.deepEqual(hzA, hzB);
  clearInterval(timer);
  A.ws.close(); B.ws.close();
  await srv.close();
});

test('a hands-off squad scattered by gusts stays together (real flight physics, tier IV, 90 s)', () => {
  const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
  const run = (withFlow) => {
    const pilots = [0, 1, 2].map((i) => {
      const p = new Player(() => {}); p.seedTurbulence(1000 + i * 77);
      p.speedSys.engaged = true; p.speedSys.tier = 4; p.speedSys.speed = TIERS[3].speed;
      p.speedSys.follow = { tier: 4, charge: 0, refHeading: 0, refPitch: 0 };
      p.pos.set(i * 400, 5000, 0);
      return p;
    });
    let worst = 0;
    for (let f = 0; f < 90 * 60; f++) {
      for (const p of pilots) {
        if (withFlow) {
          const others = pilots.filter((q) => q !== p).map((q) => ({ flying: true, x: q.pos.x, y: q.pos.y, z: q.pos.z, heading: q.heading, pitch: q.pitch, speed: q.speed }));
          p.flow = cohesion(p.pos.x, p.pos.y, p.pos.z, p.speed, consensus(others), SQUAD, p.flow || {}, p.heading);
        }
        p.update(DT, { throttle: true }, W);
      }
      if (f > 60 * 60) for (const a of pilots) for (const b of pilots) worst = Math.max(worst, Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z));
    }
    return worst;
  };
  const speed = TIERS[3].speed;
  const free = run(false), squad = run(true);
  console.log(`  last 30 s, widest gap: no squad pull ${(free / 1000).toFixed(0)} km · with the squad line ${(squad / 1000).toFixed(1)} km (${(squad / speed).toFixed(1)} s of flight)`);
  assert.ok(squad < free / 4, `${squad} vs ${free}`);
  assert.ok(squad < speed * 15, 'within ~15 s of flight even with nobody steering');
});

test('freedom: a pilot who steers away really can leave the squad (the pull never traps you)', () => {
  const W = { origin: { x: 0, z: 0 }, collide: () => null, crossedTriggers: () => [] };
  const lead = { flying: true, x: 0, y: 5000, z: 0, heading: 0, pitch: 0, speed: TIERS[3].speed };
  const p = new Player(() => {}); p.seedTurbulence(5);
  p.speedSys.engaged = true; p.speedSys.tier = 4; p.speedSys.speed = TIERS[3].speed;
  p.speedSys.follow = { tier: 4, charge: 0, refHeading: 0, refPitch: 0 };
  p.pos.set(400, 5000, 0);
  for (let f = 0; f < 20 * 60; f++) {
    lead.z -= lead.speed * DT;                              // the squad flies on, straight
    p.flow = cohesion(p.pos.x, p.pos.y, p.pos.z, p.speed, consensus([lead]), SQUAD, p.flow || {}, p.heading);
    // break right, then hold a 60° course away from the squad
    const off = ((p.heading - -Math.PI / 3 + Math.PI) % (2 * Math.PI)) - Math.PI;
    p.update(DT, { throttle: true, right: off > 0.02, left: off < -0.02 }, W);
  }
  const gap = Math.hypot(p.pos.x - lead.x, p.pos.z - lead.z);
  assert.ok(gap > TIERS[3].speed * 8, `left the squad: ${(gap / 1000).toFixed(0)} km`);
});
