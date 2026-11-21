// Squad logic: the "overall trajectory" and how it pulls on each member.
// Pure (no DOM, no three.js): the server runs it as the authority and the
// client runs the same functions for its own flow current and HUD.
//
//   consensus()     the squad line: centroid + mean flight direction
//   cohesion()      the flow current toward the line (sideways + vertical drift,
//                   never turning the nose) and the rubber band along it
//   SquadBarrier    the shared speed barrier: it charges while members hold the
//                   squad line (drafting in formation charges faster); with one
//                   member it is exactly the solo SpeedSystem
import { TIERS, SPEED, SQUAD, DEG, ALTITUDE, SPACE, PATH, WORLD, tierLevel } from '../config.js';

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** forward unit vector for (heading, pitch) */
export function dirOf(heading, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(heading) * cp, Math.sin(pitch), -Math.cos(heading) * cp];
}

/**
 * Squad line of the members that are flying: { n, cx, cy, cz, fx, fy, fz,
 * heading, pitch, speed }. Positions are absolute meters. Mean forward, not
 * mean heading (no wrap-around problems at ±180°).
 */
export function consensus(members, out = {}) {
  let n = 0, cx = 0, cy = 0, cz = 0, fx = 0, fy = 0, fz = 0, sp = 0;
  for (const m of members) {
    if (!m.flying) continue;
    n++; cx += m.x; cy += m.y; cz += m.z; sp += m.speed || 0;
    const cp = Math.cos(m.pitch);
    fx += -Math.sin(m.heading) * cp; fy += Math.sin(m.pitch); fz += -Math.cos(m.heading) * cp;
  }
  out.n = n;
  if (!n) { out.cx = out.cy = out.cz = 0; out.fx = 0; out.fy = 0; out.fz = -1; out.heading = 0; out.pitch = 0; out.speed = 0; return out; }
  const l = Math.hypot(fx, fy, fz) || 1;
  out.cx = cx / n; out.cy = cy / n; out.cz = cz / n;
  out.fx = fx / l; out.fy = fy / l; out.fz = fz / l;
  out.heading = Math.atan2(-out.fx, -out.fz);
  out.pitch = Math.asin(Math.max(-1, Math.min(1, out.fy)));
  out.speed = sp / n;
  return out;
}

/**
 * The squad line's pull on one member at (x, y, z), flying at `speed`.
 * Returns { vx, vy, vz } (m/s drift to ADD to the jet's velocity: it never
 * rotates the nose, so it can't break your straight line), k (speed factor
 * for the rubber band along the line), lateral (m off the line), along (m
 * ahead (+) / behind (−) the centroid), pull (0..1 current strength).
 * `others`: the line computed from the OTHER members (you don't pull on yourself).
 * `heading` (optional): enables the rejoin assist, out.yaw (rad/s), which the
 * Player applies only while you are hands off the stick and far from the squad.
 */
export function cohesion(x, y, z, speed, line, cfg = SQUAD, out = {}, heading = null) {
  out.vx = out.vy = out.vz = 0; out.k = 1; out.lateral = 0; out.along = 0; out.pull = 0; out.yaw = 0;
  if (!line || line.n < 1 || speed <= 0) return out;
  const F = cfg.flow, R = cfg.rubber;
  const dx = x - line.cx, dy = y - line.cy, dz = z - line.cz;
  // along the (horizontal) line: rubber band
  const hl = Math.hypot(line.fx, line.fz) || 1, hx = line.fx / hl, hz = line.fz / hl;
  const along = dx * hx + dz * hz;
  out.along = along;
  out.k = 1 + Math.max(-1, Math.min(1, -along / (speed * R.horizon))) * R.gain;
  // sideways (horizontal, perpendicular to the line) and vertical offsets
  const sx = dx - along * hx, sz = dz - along * hz;
  const side = Math.hypot(sx, sz);
  const dead = Math.max(F.minDead, speed * F.dead), soft = speed * F.soft;
  const vmax = speed * F.max;
  // near: a soft current (free flight inside `dead`); far: the leash adds a stronger pull,
  // so a squad scattered by gusts or a long detour always regroups, unless you fight it
  const L = F.leash, lFrom = speed * L.from, lSoft = speed * L.soft;
  const pull = (d) => (d <= dead ? 0 : (1 - Math.exp(-(d - dead) / soft)) * vmax)
    + (L && d > lFrom ? (1 - Math.exp(-(d - lFrom) / lSoft)) * speed * L.max : 0);
  const ps = pull(side), pv = pull(Math.abs(dy)) * F.vertical;
  const ks = ps / (vmax + (L ? speed * L.max : 0)), kv = pv / (vmax + (L ? speed * L.max : 0));
  if (side > 1e-6) { out.vx = -(sx / side) * ps; out.vz = -(sz / side) * ps; }
  out.vy = -Math.sign(dy) * pv;
  out.lateral = Math.hypot(side, dy);
  out.pull = Math.max(ks, kv);
  // rejoin: lost AND not steering -> ease the nose toward an intercept point on the line
  const J = F.rejoin;
  if (J && heading !== null && side > lFrom) {
    const w = Math.min(1, (side - lFrom) / (lFrom * 0.5));
    const tx = line.cx + hx * speed * J.lookahead, tz = line.cz + hz * speed * J.lookahead;
    let err = Math.atan2(-(tx - x), -(tz - z)) - heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    out.yaw = Math.max(-J.rate, Math.min(J.rate, err * J.gain)) * w;
  }
  return out;
}

/** altitude band and its barrier-charge multiplier (same rules as Player.band) */
export function bandOf(y, space) {
  if (space && y > SPACE.edge) return 'space';
  return y < ALTITUDE.groundEffect ? 'low' : y > ALTITUDE.radar ? 'high' : 'mid';
}
export function chargeRateOf(band) {
  return band === 'low' ? ALTITUDE.groundEffectCharge : band === 'high' ? ALTITUDE.radarCharge : band === 'space' ? SPACE.chargeRate : 1;
}

/** formation slot k (0 = lead): [side, up, back] meters */
export function slot(k, cfg = SQUAD.slots) {
  if (k <= 0) return [0, 0, 0];
  const rank = Math.ceil(k / 2), s = k % 2 ? 1 : -1;
  return [s * rank * cfg.side, rank * cfg.up, rank * cfg.back];
}

/**
 * The shared speed barrier. Same rules as SpeedSystem, lifted to the squad:
 *  * the reference line is the squad's (re-anchored on the consensus
 *    direction whenever the charge is empty and nobody holds it)
 *  * each member holds it or not (its own heading / pitch within tolerance)
 *  * the charge fills at the MEAN contribution: holding = your altitude band's
 *    rate (×draft bonus when a teammate flies within draft radius), off the
 *    line = 0. Everyone has to fly the line together to break it fast.
 *  * nobody on it: the charge bleeds (tier missDecay)
 */
export class SquadBarrier {
  constructor(tiers = TIERS, cfg = SPEED) { this.tiers = tiers; this.cfg = cfg; this.reset(0, 0); }
  reset(heading = 0, pitch = 0) {
    this.tier = 1; this.charge = 0; this.chargeRate = 0;
    this.refHeading = heading; this.refPitch = pitch;
    this.maxTier = 1; this.dropCooldown = 0;
  }
  get next() { return this.tier < this.tiers.length ? this.tiers[this.tier] : null; }
  get tolerance() { const n = this.next; return n ? n.tolerance * DEG : 12 * DEG; }

  /** a teammate passed a gate / near miss: the whole squad's barrier charges */
  bonus(add) { if (this.next) this.charge = Math.min(0.98, this.charge + add); }

  /** head-on crash of any member: the squad drops a tier (rate-limited) */
  drop() {
    if (this.dropCooldown > 0 || this.tier <= 1) return [];
    this.dropCooldown = 2; this.tier--; this.charge = 0;
    return [{ type: 'tierDown', tier: this.tier, reason: 'impact' }];
  }

  /**
   * members: [{ heading, pitch, flying, throttle, chargeRate, draft }]
   * line: consensus() of the same members. Sets m.aligned on each.
   */
  update(dt, members, line) {
    const events = [];
    this.dropCooldown -= dt;
    const next = this.next, tol = this.tolerance, cfg = this.cfg;
    let n = 0, sum = 0, anyIn = false, throttle = false;
    for (const m of members) {
      if (!m.flying) { m.aligned = false; continue; }
      n++;
      const dh = angleDiff(m.heading, this.refHeading) * Math.cos(m.pitch), dp = m.pitch - this.refPitch;
      m.aligned = Math.hypot(dh, dp) <= tol;
      if (m.aligned) { anyIn = true; sum += (m.chargeRate ?? 1) * (m.draft ? SQUAD.draft.bonus : 1); }
      if (m.throttle) throttle = true;
    }
    if (!n) { this.chargeRate = 0; return events; }
    if (!anyIn && this.charge <= 0) { this.refHeading = line.heading; this.refPitch = line.pitch; }
    const before = this.charge;
    const autoFirst = cfg.autoFirstBarrier && this.tier === 1;
    if (next && (throttle || autoFirst) && anyIn) {
      this.charge += (dt / next.hold) * (sum / n);
      if (this.charge >= 1) {
        this.tier++; this.charge = 0;
        this.refHeading = line.heading; this.refPitch = line.pitch;
        this.maxTier = Math.max(this.maxTier, this.tier);
        events.push({ type: 'tierUp', tier: this.tier });
      }
    } else if (!anyIn) this.charge = Math.max(0, this.charge - (next?.missDecay ?? cfg.chargeDecayMiss) * dt);
    else this.charge = Math.max(0, this.charge - cfg.chargeDecayIdle * dt);
    if (!this.next) this.charge = 0;
    this.chargeRate = dt > 0 && !events.length ? (this.charge - before) / dt : 0;
    return events;
  }
}

// ---- path events along the squad line (planned by the server, built by every client)

/** view distance for a tier (same as World.viewDistance) */
export const viewDistanceFor = (tier) => WORLD.viewDistBase + WORLD.viewDistPerTier * (tierLevel(tier) - 1);

/** weighted pattern pick; walls / belts only once fast or deep into the run */
export function pickPattern(weights, tier, difficulty, rng = Math.random, has = () => true) {
  const entries = Object.entries(weights).filter(([k]) => has(k) && ((k !== 'wall' && k !== 'belt') || tierLevel(tier) >= 3 || difficulty > 0.35));
  let t = rng() * entries.reduce((s, e) => s + e[1], 0);
  for (const [k, w] of entries) if ((t -= w) <= 0) return k;
  return entries[0]?.[0] ?? 'spire';
}

/** seconds between path events at a difficulty (easy .. hard), before jitter */
export function eventInterval(orbit, difficulty) {
  const [easy, hard] = orbit ? SPACE.interval : PATH.interval;
  return easy + (hard - easy) * difficulty;
}
