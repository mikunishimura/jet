// Wire protocol, shared by the browser client and the Node server (pure: no
// DOM, no three.js, no Node APIs). Two kinds of frames:
//
//   * BINARY (hot path, fixed layouts, little-endian): player state, owned
//     enemies, squad state, ping / pong. Byte 0 = message type, byte 1 =
//     sender id (the server stamps it when relaying, so clients can't spoof).
//   * TEXT (rare control + events): JSON { t: 'hello' | 'welcome' | ... }.
//
// Positions are ABSOLUTE world meters (the world is ~1000s of km wide and
// every client has its own floating origin), so x/z are float64. Everything
// else is float32 / quantized ints. Times are SERVER seconds (see clock.js).
//
// Transport-agnostic: the same frames work over WebSocket (LAN today) and an
// unreliable channel (WebRTC / WebTransport datagrams) later. Every hot frame
// is a full snapshot (no deltas), so a lost frame costs nothing but freshness.

export const PROTOCOL_VERSION = 1;

export const BIN = { STATE: 1, ENEMIES: 2, SQUAD: 3, PING: 4, PONG: 5 };

// ---- player state ------------------------------------------------------------
// flags bits
export const SF = { ALIVE: 1, ENGAGED: 2, FIRING: 4, BRAKING: 8, THROTTLE: 16, FLYING: 32 };
export const STATE_BYTES = 80;
const A16 = 10000; // angle quantization: int16 = rad * 1e4 (±3.27 rad)

/** encode into `buf` (ArrayBuffer of STATE_BYTES); returns buf */
export function encodeState(s, buf = new ArrayBuffer(STATE_BYTES)) {
  const d = new DataView(buf);
  d.setUint8(0, BIN.STATE); d.setUint8(1, 0); d.setUint16(2, s.seq & 0xffff, true);
  d.setFloat64(4, s.t, true);
  d.setFloat64(12, s.x, true); d.setFloat32(20, s.y, true); d.setFloat64(24, s.z, true);
  d.setFloat32(32, s.vx, true); d.setFloat32(36, s.vy, true); d.setFloat32(40, s.vz, true);
  d.setFloat32(44, s.heading, true); d.setFloat32(48, s.pitch, true);
  d.setFloat32(52, s.yawRate, true); d.setFloat32(56, s.pitchRate, true);
  d.setFloat32(60, s.steer, true); d.setFloat32(64, s.speed, true);
  d.setUint8(68, s.tier); d.setUint8(69, s.flags);
  d.setInt16(70, Math.round(s.aimYaw * A16), true); d.setInt16(72, Math.round(s.aimPitch * A16), true);
  d.setUint8(74, Math.max(0, Math.min(255, Math.round(s.hp))));
  d.setUint8(75, Math.max(0, Math.min(255, s.enemies | 0)));
  d.setFloat32(76, s.vstick, true);
  return buf;
}

export function decodeState(view, out = {}) {
  const d = view instanceof DataView ? view : new DataView(view);
  out.id = d.getUint8(1); out.seq = d.getUint16(2, true);
  out.t = d.getFloat64(4, true);
  out.x = d.getFloat64(12, true); out.y = d.getFloat32(20, true); out.z = d.getFloat64(24, true);
  out.vx = d.getFloat32(32, true); out.vy = d.getFloat32(36, true); out.vz = d.getFloat32(40, true);
  out.heading = d.getFloat32(44, true); out.pitch = d.getFloat32(48, true);
  out.yawRate = d.getFloat32(52, true); out.pitchRate = d.getFloat32(56, true);
  out.steer = d.getFloat32(60, true); out.speed = d.getFloat32(64, true);
  out.tier = d.getUint8(68); out.flags = d.getUint8(69);
  out.aimYaw = d.getInt16(70, true) / A16; out.aimPitch = d.getInt16(72, true) / A16;
  out.hp = d.getUint8(74); out.enemies = d.getUint8(75);
  out.vstick = d.getFloat32(76, true);
  return out;
}

// ---- owned enemies -------------------------------------------------------------
// Each client simulates the enemies attacking it (zero-latency combat for the
// player fighting them) and publishes them RELATIVE TO ITS OWN JET: they fly in
// that jet's frame, so relative motion is slow (~100s of m/s) even at Mach 100
// and the receiver re-anchors them on its prediction of that jet.
export const ENEMY_KINDS = ['drone', 'ufo', 'fighter'];
export const ENEMIES_HEADER = 16, ENEMY_BYTES = 28;

export function enemiesBytes(n) { return ENEMIES_HEADER + n * ENEMY_BYTES; }

/** list: [{ id, kind (index), hp01, rx, ry, rz, rvx, rvy, rvz, yaw, pitch, roll }] */
export function encodeEnemies(t, seq, list, buf = new ArrayBuffer(enemiesBytes(list.length))) {
  const d = new DataView(buf);
  d.setUint8(0, BIN.ENEMIES); d.setUint8(1, 0); d.setUint16(2, seq & 0xffff, true);
  d.setFloat64(4, t, true); d.setUint8(12, list.length);
  let o = ENEMIES_HEADER;
  for (const e of list) {
    d.setUint16(o, e.id, true); d.setUint8(o + 2, e.kind); d.setUint8(o + 3, Math.max(0, Math.min(255, Math.round(e.hp01 * 255))));
    d.setFloat32(o + 4, e.rx, true); d.setFloat32(o + 8, e.ry, true); d.setFloat32(o + 12, e.rz, true);
    d.setInt16(o + 16, clamp16(e.rvx), true); d.setInt16(o + 18, clamp16(e.rvy), true); d.setInt16(o + 20, clamp16(e.rvz), true);
    d.setInt16(o + 22, Math.round(wrapPi(e.yaw) * A16), true); d.setInt16(o + 24, Math.round(wrapPi(e.pitch) * A16), true); d.setInt16(o + 26, Math.round(wrapPi(e.roll) * A16), true);
    o += ENEMY_BYTES;
  }
  return buf;
}

export function decodeEnemies(view, out = { list: [] }) {
  const d = view instanceof DataView ? view : new DataView(view);
  out.id = d.getUint8(1); out.seq = d.getUint16(2, true); out.t = d.getFloat64(4, true);
  const n = d.getUint8(12);
  out.list.length = n;
  let o = ENEMIES_HEADER;
  for (let i = 0; i < n; i++) {
    const e = out.list[i] || (out.list[i] = {});
    e.id = d.getUint16(o, true); e.kind = d.getUint8(o + 2); e.hp01 = d.getUint8(o + 3) / 255;
    e.rx = d.getFloat32(o + 4, true); e.ry = d.getFloat32(o + 8, true); e.rz = d.getFloat32(o + 12, true);
    e.rvx = d.getInt16(o + 16, true); e.rvy = d.getInt16(o + 18, true); e.rvz = d.getInt16(o + 20, true);
    e.yaw = d.getInt16(o + 22, true) / A16; e.pitch = d.getInt16(o + 24, true) / A16; e.roll = d.getInt16(o + 26, true) / A16;
    o += ENEMY_BYTES;
  }
  return out;
}

// ---- squad (server -> all) -----------------------------------------------------
export const SQUAD_HEADER = 64, SQUAD_MEMBER_BYTES = 2;
export const MF = { ALIGNED: 1, DRAFT: 2, FLYING: 4 };

/** s: { seq, t, tier, charge, chargeRate, refHeading, refPitch, heading, pitch, ax, ay, az, members: [{id, flags}] } */
export function encodeSquad(s, buf = new ArrayBuffer(SQUAD_HEADER + s.members.length * SQUAD_MEMBER_BYTES)) {
  const d = new DataView(buf);
  d.setUint8(0, BIN.SQUAD); d.setUint8(1, 0); d.setUint16(2, s.seq & 0xffff, true);
  d.setFloat64(4, s.t, true);
  d.setUint8(12, s.tier); d.setUint8(13, s.members.length);
  d.setFloat32(16, s.charge, true); d.setFloat32(20, s.chargeRate, true);
  d.setFloat32(24, s.refHeading, true); d.setFloat32(28, s.refPitch, true);
  d.setFloat32(32, s.heading, true); d.setFloat32(36, s.pitch, true);
  d.setFloat64(40, s.ax, true); d.setFloat32(48, s.ay, true); d.setFloat64(52, s.az, true);
  d.setUint16(60, s.hazards & 0xffff, true);
  let o = SQUAD_HEADER;
  for (const m of s.members) { d.setUint8(o, m.id); d.setUint8(o + 1, m.flags); o += SQUAD_MEMBER_BYTES; }
  return buf;
}

export function decodeSquad(view, out = { members: [] }) {
  const d = view instanceof DataView ? view : new DataView(view);
  out.seq = d.getUint16(2, true); out.t = d.getFloat64(4, true);
  out.tier = d.getUint8(12); const n = d.getUint8(13);
  out.charge = d.getFloat32(16, true); out.chargeRate = d.getFloat32(20, true);
  out.refHeading = d.getFloat32(24, true); out.refPitch = d.getFloat32(28, true);
  out.heading = d.getFloat32(32, true); out.pitch = d.getFloat32(36, true);
  out.ax = d.getFloat64(40, true); out.ay = d.getFloat32(48, true); out.az = d.getFloat64(52, true);
  out.hazards = d.getUint16(60, true);
  out.members.length = n;
  let o = SQUAD_HEADER;
  for (let i = 0; i < n; i++) {
    const m = out.members[i] || (out.members[i] = {});
    m.id = d.getUint8(o); m.flags = d.getUint8(o + 1); o += SQUAD_MEMBER_BYTES;
  }
  return out;
}

// ---- clock ---------------------------------------------------------------------
export const PING_BYTES = 12, PONG_BYTES = 20;
export function encodePing(t0, buf = new ArrayBuffer(PING_BYTES)) {
  const d = new DataView(buf); d.setUint8(0, BIN.PING); d.setFloat64(4, t0, true); return buf;
}
export function encodePong(t0, ts, buf = new ArrayBuffer(PONG_BYTES)) {
  const d = new DataView(buf); d.setUint8(0, BIN.PONG); d.setFloat64(4, t0, true); d.setFloat64(12, ts, true); return buf;
}

// ---- helpers -----------------------------------------------------------------------
function clamp16(v) { return Math.max(-32767, Math.min(32767, Math.round(v))); }
function wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
/** message type of a binary frame */
export const typeOf = (view) => (view instanceof DataView ? view.getUint8(0) : new DataView(view).getUint8(0));
