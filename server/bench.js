#!/usr/bin/env node
// Load test: the co-op server in its own process, N bot pilots per room
// flying at full rates (30 Hz state, 20 Hz × 10 enemies, 10 Hz ping).
//   npm run mp:bench -- --bots 8 --rooms 2 --seconds 10
// Reports what matters for "fast": RTT, one-way relay latency (bots share a
// synced clock), server tick cost, CPU and bandwidth.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from '../src/net/protocol.js';
import { ClockSync } from '../src/net/clock.js';
import { SQUAD } from '../src/config.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? +process.argv[i + 1] : d; };
const BOTS = arg('bots', 8), ROOMS = arg('rooms', 1), SECONDS = arg('seconds', 10), PORT = arg('port', 5291);
const ENEMIES = arg('enemies', 10);

const server = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url)), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('co-op server') && r()));

const wall = () => performance.now() / 1000;
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN);
const rtts = [], oneWay = [];
let recvFrames = 0, recvBytes = 0, sentFrames = 0, sentBytes = 0;

function bot(room, k) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`); ws.binaryType = 'arraybuffer';
    const b = { ws, clock: new ClockSync(), id: 0, k, t0: wall() };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: P.PROTOCOL_VERSION, name: `bot${k}`, room }));
    ws.onmessage = (m) => {
      recvFrames++;
      if (typeof m.data === 'string') { recvBytes += m.data.length; const e = JSON.parse(m.data); if (e.t === 'welcome') { b.id = e.id; resolve(b); } if (e.t === 'stats') b.stats = e; return; }
      recvBytes += m.data.byteLength;
      const d = new DataView(m.data), type = d.getUint8(0);
      if (type === P.BIN.PONG) { const t0 = d.getFloat64(4, true), t1 = wall(); b.clock.sample(t0, d.getFloat64(12, true), t1); if (b.warm) rtts.push((t1 - t0) * 1000); }
      else if (type === P.BIN.STATE && b.warm && b.clock.synced) oneWay.push((b.clock.now(wall()) - d.getFloat64(4, true)) * 1000);
    };
  });
}
const send = (b, buf) => { b.ws.send(buf); sentFrames++; sentBytes += buf.byteLength ?? buf.length; };

const bots = [];
for (let r = 0; r < ROOMS; r++) for (let k = 0; k < BOTS; k++) bots.push(await bot(`bench${r}`, k));
console.log(`${bots.length} bots in ${ROOMS} room(s) · ${SECONDS}s · state ${SQUAD.stateHz} Hz · ${ENEMIES} enemies @ ${SQUAD.enemyHz} Hz`);
for (const b of bots) for (let i = 0; i < 8; i++) setTimeout(() => send(b, P.encodePing(wall())), i * 40);
await new Promise((r) => setTimeout(r, 600));
for (const b of bots) b.warm = true;

const enemyList = Array.from({ length: ENEMIES }, (_, i) => ({ id: i + 1, kind: i % 3, hp01: 1, rx: 100 * i, ry: 20, rz: -900, rvx: 10, rvy: 0, rvz: -50, yaw: 0, pitch: 0, roll: 0 }));
let seq = 0;
const timers = [
  setInterval(() => { for (const b of bots) { const t = b.clock.now(wall()), v = 19000;
    send(b, P.encodeState({ seq: ++seq, t, x: b.k * 400, y: 900, z: -v * (wall() - b.t0), vx: 0, vy: 0, vz: -v, heading: 0, pitch: 0, yawRate: 0, pitchRate: 0, steer: 0, vstick: 0,
      speed: v, tier: 5, flags: P.SF.ALIVE | P.SF.ENGAGED | P.SF.FLYING | P.SF.THROTTLE | P.SF.FIRING, aimYaw: 0, aimPitch: 0, hp: 100, enemies: ENEMIES })); } }, 1000 / SQUAD.stateHz),
  setInterval(() => { for (const b of bots) send(b, P.encodeEnemies(b.clock.now(wall()), ++seq, enemyList)); }, 1000 / SQUAD.enemyHz),
  setInterval(() => { for (const b of bots) send(b, P.encodePing(wall())); }, 100),
];
const c0 = Date.now();
await new Promise((r) => setTimeout(r, SECONDS * 1000));
timers.forEach(clearInterval);
bots[0].ws.send('{"t":"stats"}');
await new Promise((r) => setTimeout(r, 200));
const st = bots[0].stats, secs = (Date.now() - c0) / 1000;
const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
console.log(`rtt (ping→pong)     p50 ${f(pct(rtts, 0.5))} ms · p99 ${f(pct(rtts, 0.99))} ms · max ${f(Math.max(...rtts))} ms  (${rtts.length} samples)`);
console.log(`relay (one-way)     p50 ${f(pct(oneWay, 0.5))} ms · p99 ${f(pct(oneWay, 0.99))} ms  (${oneWay.length} frames)`);
console.log(`server tick         avg ${f(st.avgTickMs)} ms · max ${f(st.maxTickMs)} ms @ ${SQUAD.serverHz} Hz (room 0)`);
console.log(`server cpu          ${f((st.cpuUserMs + st.cpuSysMs) / (st.uptime * 1000) * 100)} % of one core · rss ${f(st.rssMB)} MB`);
console.log(`per client          in ${f(recvBytes / bots.length / secs / 1024)} KB/s · out ${f(sentBytes / bots.length / secs / 1024)} KB/s`);
console.log(`server total        ${f(recvFrames / secs)} frames/s delivered`);
for (const b of bots) b.ws.close();
server.kill();
process.exit(0);
