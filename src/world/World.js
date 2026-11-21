// Streams chunks around (and mostly ahead of) the player, under a per-frame
// time budget, and answers collision / ray queries.
//
// Floating origin: the scene is rendered relative to `origin` (absolute meters).
// When the player drifts far from local (0,0), Game calls rebase() and every
// system shifts its local positions. Colliders are kept absolute.
//
// World scale: features generate in BASE meters (chunkSize 500); each chunk's
// render group is scaled by WORLD_SCALE and its colliders/triggers converted
// to absolute meters once, at build time. Queries take absolute meters.
//
// Layers: other streamed realms (the orbital asteroid field) plug in with
// addLayer(). A layer streams its own chunks (same shape as ours) and exposes
// forEachNear / rebase / reset / update; every query here includes it.
import * as THREE from 'three';
import { WORLD, WORLD_SCALE, tierLevel } from '../config.js';
import { chunkRng } from '../core/rng.js';
import { ChunkBuilder } from './ChunkBuilder.js';
import { RockLibrary } from './rocks.js';
import { Biomes } from './biomes.js';
import { listFeatures } from './features/index.js';
import { labMaterial, outlineMaterial } from '../render/materials.js';
import { contact, radiusAt, CAPSULE, SPHERE } from '../game/Collision.js';

const key = (cx, cz) => `${cx},${cz}`;
const S = WORLD_SCALE;

/** base-meter collider → absolute meters (in place) */
export function scaleCollider(c) {
  c.x *= S; c.z *= S; c.r *= S; c.top *= S; c.bottom *= S;
  if (c.kind === SPHERE) c.y *= S;
  if (c.kind === CAPSULE) { c.ax *= S; c.az *= S; c.bx *= S; c.bz *= S; c.br *= S; }
  if (c.rAt) { const f = c.rAt; c.rAt = (y) => f(y / S) * S; }
  if (c.radius) c.radius *= S;
  if (c.height) c.height *= S;
}
export function scaleTrigger(t) {
  if (t.kind === 'ring') { t.x *= S; t.y *= S; t.z *= S; t.r *= S; return; }
  t.ax *= S; t.az *= S; t.bx *= S; t.bz *= S;
  if (t.top !== undefined) t.top *= S;
  if (t.bottom !== undefined) t.bottom *= S;
}

export class World {
  constructor(scene, seed) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.materials = {
      // obstacles: near-black faces (subtle facet shading, no inner lines) + white silhouette rim
      solid: labMaterial({ vertexColors: true, contour: 0, lift: 0.1 }),
      outline: outlineMaterial(0xffffff, 2),
    };
    this.rocks = new RockLibrary(7);
    this.chunks = new Map();
    this.dynamic = [];   // pseudo-chunks spawned at runtime (path hazards)
    this.queue = [];
    this.layers = [];    // extra streamed realms (see addLayer)
    this.origin = { x: 0, z: 0 };
    this.csize = WORLD.chunkSize * S; // absolute chunk size
    this.reset(seed);
  }

  reset(seed) {
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    for (const d of this.dynamic) this.disposeChunk(d);
    this.dynamic.length = 0;
    this.queue.length = 0;
    this.seed = seed;
    this.biomes = new Biomes(seed);
    this.origin.x = 0; this.origin.z = 0;
    for (const l of this.layers) l.reset(seed);
    this.spawnHeading = 0;
    this.stats = { built: 0, lastBuildMs: 0 };
  }

  /** Spawn zone + launch runway (heading -Z from spawn) stay clear. */
  isReserved(x, z, r) {
    if (Math.hypot(x, z) < WORLD.spawnClearRadius + r) return true;
    const L = WORLD.launchCorridor;
    if (z < 0 && z > -L.length - r && Math.abs(x) < L.halfWidth + r) return true;
    return false;
  }

  buildChunk(cx, cz) {
    const size = WORLD.chunkSize;
    const builder = new ChunkBuilder(cx, cz, size);
    const ctx = {
      cx, cz, size, x0: cx * size, z0: cz * size,
      biomes: this.biomes, rocks: this.rocks, builder,
      isReserved: (x, z, r) => this.isReserved(x, z, r),
      rng: null,
    };
    const feats = listFeatures();
    for (let i = 0; i < feats.length; i++) {
      ctx.rng = chunkRng(cx, cz, this.seed, i * 977 + 13);
      feats[i].generate(ctx);
    }
    const chunk = { cx, cz, ...this.finalize(builder) };
    this.chunks.set(key(cx, cz), chunk);
    this.stats.built++;
    return chunk;
  }

  /** Plug in another streamed realm (it shares collisions, triggers, rebase). */
  addLayer(layer) { if (!this.layers.includes(layer)) this.layers.push(layer); layer.reset?.(this.seed); return layer; }
  removeLayer(layer) { const i = this.layers.indexOf(layer); if (i >= 0) this.layers.splice(i, 1); }

  /** bake a base-meter builder into a scaled render group + absolute colliders */
  finalize(builder, materials = this.materials) {
    const group = builder.bake(materials);
    group.scale.setScalar(S);
    const centerX = builder.centerX * S, centerZ = builder.centerZ * S;
    group.position.set(centerX - this.origin.x, 0, centerZ - this.origin.z);
    this.root.add(group);
    for (const c of builder.colliders) scaleCollider(c);
    for (const t of builder.triggers) scaleTrigger(t);
    return { group, centerX, centerZ, colliders: builder.colliders, triggers: builder.triggers, animated: builder.animated };
  }

  disposeChunk(c) {
    this.root.remove(c.group);
    c.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }

  viewDistance(tier) { return WORLD.viewDistBase + WORLD.viewDistPerTier * (tierLevel(tier) - 1); }

  /** absX/absZ: player absolute position. fx/fz: forward. y: altitude (for layers). */
  update(absX, absZ, fx, fz, tier, time, y = 0) {
    for (const l of this.layers) l.update(absX, y, absZ, fx, fz, tier, time);
    const size = this.csize;
    const view = this.viewDistance(tier);
    const pcx = Math.floor(absX / size), pcz = Math.floor(absZ / size);
    const R = Math.ceil(view / size) + 1;
    const wanted = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const cx = pcx + dx, cz = pcz + dz;
        const mx = (cx + 0.5) * size - absX, mz = (cz + 0.5) * size - absZ;
        const d = Math.hypot(mx, mz);
        if (d > view) continue;
        const ahead = (mx * fx + mz * fz) / (d || 1);
        // keep a near ring everywhere, a wide cone ahead
        if (d > 1100 * S && ahead < 0.25) continue;
        wanted.push({ cx, cz, score: d * (1.6 - ahead) });
      }
    }
    const want = new Set(wanted.map((w) => key(w.cx, w.cz)));
    // unload with hysteresis
    for (const [k, c] of this.chunks) {
      if (want.has(k)) continue;
      const d = Math.hypot(c.centerX - absX, c.centerZ - absZ);
      const ahead = ((c.centerX - absX) * fx + (c.centerZ - absZ) * fz) / (d || 1);
      if (d > view + 700 * S || (d > 1500 * S && ahead < 0)) { this.disposeChunk(c); this.chunks.delete(k); }
    }
    // build missing, closest-ahead first, within the time budget
    const missing = wanted.filter((w) => !this.chunks.has(key(w.cx, w.cz))).sort((a, b) => a.score - b.score);
    const t0 = performance.now();
    for (const w of missing) {
      this.buildChunk(w.cx, w.cz);
      if (performance.now() - t0 > WORLD.genBudgetMs) break;
    }
    this.stats.lastBuildMs = performance.now() - t0;
    this.stats.pending = Math.max(0, missing.length - 1);
    // animated chunk objects
    for (const c of this.chunks.values()) for (const fn of c.animated) fn(time);
    for (const d of this.dynamic) for (const fn of d.animated) fn(time);
  }

  /** Build the 3x3 static chunks around an absolute point if missing (deterministic
   *  checks there give the same answer on every co-op client). */
  ensureAround(absX, absZ) {
    const size = this.csize, pcx = Math.floor(absX / size), pcz = Math.floor(absZ / size);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (!this.chunks.has(key(pcx + dx, pcz + dz))) this.buildChunk(pcx + dx, pcz + dz);
  }

  /** Synchronously build everything near a point (used at spawn). */
  prewarm(absX, absZ, fx, fz, tier) {
    for (let i = 0; i < 60; i++) {
      const before = this.stats.built;
      const saved = WORLD.genBudgetMs; WORLD.genBudgetMs = 1000;
      this.update(absX, absZ, fx, fz, tier, 0);
      WORLD.genBudgetMs = saved;
      if (this.stats.built === before) break;
    }
  }

  rebase(dx, dz) {
    this.origin.x += dx; this.origin.z += dz;
    for (const c of this.chunks.values()) c.group.position.set(c.centerX - this.origin.x, 0, c.centerZ - this.origin.z);
    for (const d of this.dynamic) d.group.position.set(d.centerX - this.origin.x, 0, d.centerZ - this.origin.z);
    for (const l of this.layers) l.rebase(this.origin);
  }

  /**
   * Add a runtime-built structure (a ChunkBuilder in BASE meters whose
   * centerX/centerZ is the structure's base-meter center). It collides, raycasts and triggers exactly
   * like streamed terrain.
   */
  addDynamic(builder, reachBase, materials) {
    const d = { ...this.finalize(builder, materials), reach: reachBase * S };
    this.dynamic.push(d);
    return d;
  }
  removeDynamic(d) {
    const i = this.dynamic.indexOf(d);
    if (i >= 0) { this.dynamic.splice(i, 1); this.disposeChunk(d); }
  }

  /** Iterate colliders of the 3x3 chunks around an absolute point. */
  forEachNear(absX, absZ, fn) {
    const size = this.csize;
    const pcx = Math.floor(absX / size), pcz = Math.floor(absZ / size);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.chunks.get(key(pcx + dx, pcz + dz));
      if (c) fn(c);
    }
    for (const d of this.dynamic) {
      if (Math.abs(d.centerX - absX) < d.reach + size && Math.abs(d.centerZ - absZ) < d.reach + size) fn(d);
    }
    for (const l of this.layers) l.forEachNear(absX, absZ, fn);
  }

  /** Deepest contact for a sphere at an absolute point. */
  collide(absX, y, absZ, r) {
    let best = null;
    this.forEachNear(absX, absZ, (c) => {
      for (const col of c.colliders) {
        const h = contact(col, absX, y, absZ, r);
        if (h && (!best || h.depth > best.depth)) best = h;
      }
    });
    return best;
  }

  /**
   * Ray march along the XZ plane; returns distance to the first collider hit
   * (inflated sideways by r, vertically by vr) or Infinity. Used by the autopilot and projectiles.
   */
  raycast(absX, y, absZ, dx, dz, maxDist, r = 0, vr = r) {
    let best = Infinity;
    const size = this.csize;
    const seen = new Set();
    const steps = Math.ceil(maxDist / (size * 0.5));
    for (let s = 0; s <= steps; s++) {
      const px = absX + dx * (s * size * 0.5), pz = absZ + dz * (s * size * 0.5);
      this.forEachNear(px, pz, (c) => {
        if (seen.has(c)) return; seen.add(c);
        for (const col of c.colliders) {
          if (y > col.top + vr || y < col.bottom - vr) continue; // vertical clearance uses its own margin
          const cr = col.br ?? radiusAt(col, Math.min(col.top, Math.max(col.bottom, y)));
          if (cr <= 0) continue;
          const cxp = col.x, czp = col.z, rad = cr + r;
          const ox = cxp - absX, oz = czp - absZ;
          const t = ox * dx + oz * dz;
          if (t < -rad) continue;
          const perp2 = ox * ox + oz * oz - t * t;
          if (perp2 > rad * rad) continue;
          const hit = t - Math.sqrt(rad * rad - perp2);
          if (hit < best && hit < maxDist) best = Math.max(0, hit);
        }
      });
      if (best < s * size * 0.5) break;
    }
    return best;
  }

  /**
   * Triggers crossed by the player moving from (ax,ay0,az) to (bx,y,bz):
   * 'segment' gates (2D line + height window) and 'ring' gates (3D disk).
   */
  crossedTriggers(ax, az, bx, bz, out, y = 0, ay = y) {
    this.forEachNear(bx, bz, (c) => {
      for (const t of c.triggers) {
        if (t.used) continue;
        if (t.kind === 'ring') {
          if (ringCrossed(t, ax, ay, az, bx, y, bz)) { t.used = true; out.push(t); }
          continue;
        }
        if (t.kind !== 'segment') continue;
        if (y > (t.top ?? Infinity) || y < (t.bottom ?? -Infinity)) continue;
        if (segmentsIntersect(ax, az, bx, bz, t.ax, t.az, t.bx, t.bz)) { t.used = true; out.push(t); }
      }
    });
    return out;
  }
}

/** Did the segment A->B pass through ring t's disk (center x,y,z, normal nx,ny,nz, radius r)? */
export function ringCrossed(t, ax, ay, az, bx, by, bz) {
  const sa = (ax - t.x) * t.nx + (ay - t.y) * t.ny + (az - t.z) * t.nz;
  const sb = (bx - t.x) * t.nx + (by - t.y) * t.ny + (bz - t.z) * t.nz;
  if (sa * sb > 0 || sa === sb) return false;          // same side of the plane
  const k = sa / (sa - sb);
  const px = ax + (bx - ax) * k - t.x, py = ay + (by - ay) * k - t.y, pz = az + (bz - az) * k - t.z;
  return px * px + py * py + pz * pz < t.r * t.r;
}

function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
