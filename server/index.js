#!/usr/bin/env node
// JET//LAB co-op server (LAN). WebSocket front end for server/room.js.
//
//   npm run mp:server                       # 0.0.0.0:5200
//   node server/index.js --port 5200 --lag 40 --jitter 10 --loss 0.02
//
// --lag/--jitter/--loss simulate a WAN on the LAN (outgoing hot frames are
// delayed / dropped), so the prediction can be tested against real latency.
// Clients connect to ws://<this machine>:5200 and send a hello with a room
// name; everyone in a room flies one squad.
import { WebSocketServer } from 'ws';
import os from 'node:os';
import { Room } from './room.js';
import { SQUAD, PROTOCOL_VERSION_HINT } from './shared.js';

export function startServer({ port = SQUAD.port, host = '0.0.0.0', lag = 0, jitter = 0, loss = 0, log = console.log, space = true } = {}) {
  const T0 = process.hrtime.bigint();
  const now = () => Number(process.hrtime.bigint() - T0) / 1e9;
  const rooms = new Map();
  const wss = new WebSocketServer({ port, host, perMessageDeflate: false, maxPayload: 64 * 1024 });

  const getRoom = (name) => {
    let r = rooms.get(name);
    if (!r) { r = new Room(name, { now, space }); rooms.set(name, r); log(`room "${name}" open (seed ${r.seed})`); }
    return r;
  };

  wss.on('connection', (ws, req) => {
    ws._socket?.setNoDelay?.(true);
    let room = null, member = null;
    const raw = (data) => { if (ws.readyState === 1) ws.send(data, { binary: typeof data !== 'string' }); };
    // WAN simulation applies to binary hot frames only (events stay reliable + ordered)
    const send = (lag || jitter || loss) ? (data) => {
      if (typeof data === 'string') return raw(data);
      if (loss && Math.random() < loss) return;
      const copy = data instanceof ArrayBuffer ? data.slice(0) : Uint8Array.from(data);
      setTimeout(() => raw(copy), Math.max(0, lag + (Math.random() * 2 - 1) * jitter));
    } : raw;
    ws.on('message', (data, isBinary) => {
      if (!member) {                                  // first message: hello
        if (isBinary) return ws.close(1002, 'hello first');
        let hello; try { hello = JSON.parse(data.toString()); } catch { return ws.close(1002, 'bad hello'); }
        if (hello.t !== 'hello') return ws.close(1002, 'hello first');
        if (hello.v !== PROTOCOL_VERSION_HINT) return ws.close(1002, `protocol ${PROTOCOL_VERSION_HINT} required`);
        room = getRoom(String(hello.room || 'lan').slice(0, 24));
        member = room.join({ send }, hello);
        if (!member) { room = null; return ws.close(1013, 'room full'); }
        log(`+ ${member.name} (#${member.id}) -> ${room.name} [${room.size}] from ${req.socket.remoteAddress}`);
        return;
      }
      if (isBinary) return room.onBinary(member, data); // Buffer is a Uint8Array
      const text = data.toString();
      if (text === '{"t":"stats"}') {                 // ops / bench: room + process numbers
        const st = room.stats, cpu = process.cpuUsage(), mem = process.memoryUsage();
        return raw(JSON.stringify({ t: 'stats', ...st, avgTickMs: st.tickMs / Math.max(1, st.ticks), members: room.size, rooms: rooms.size,
          cpuUserMs: cpu.user / 1000, cpuSysMs: cpu.system / 1000, rssMB: mem.rss / 1048576, uptime: now() }));
      }
      room.onText(member, text);
    });
    ws.on('close', () => {
      if (!member) return;
      room.leave(member);
      log(`- ${member.name} (#${member.id}) <- ${room.name} [${room.size}]`);
      if (!room.size) { rooms.delete(room.name); log(`room "${room.name}" closed`); }
    });
    ws.on('error', () => {});
  });

  // fixed-rate squad simulation for every room
  const dt = 1 / SQUAD.serverHz;
  let last = now();
  const timer = setInterval(() => {
    const t = now(), step = Math.min(0.1, t - last); last = t;
    for (const r of rooms.values()) r.tick(step || dt);
  }, 1000 / SQUAD.serverHz);

  return {
    wss, rooms, now, port,
    close: () => new Promise((res) => { clearInterval(timer); for (const c of wss.clients) c.terminate(); wss.close(() => res()); }),
  };
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const port = +arg('port', SQUAD.port);
  startServer({ port, lag: +arg('lag', 0), jitter: +arg('jitter', 0), loss: +arg('loss', 0), space: arg('space', 'on') !== 'off' });
  console.log(`JET//LAB co-op server on :${port}`);
  for (const ip of lanAddresses()) console.log(`  LAN: open http://${ip}:5199/?mp  (or ?mp&server=ws://${ip}:${port})`);
}
