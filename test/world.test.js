// World density + path-hazard pacing. The map is meant for long, mostly
// straight runs: few static obstacles, plus paced events down your path.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/world/World.js';
import { PathHazards } from '../src/world/PathHazards.js';
import { radiusAt } from '../src/game/Collision.js';
import { TIERS, WORLD_SCALE } from '../src/config.js';

const ALT = 26, HALF = 40;

function blockingInLane(w, ox, oz, dx, dz, L) {
  const seen = new Set(); let n = 0;
  const cs = w.csize;
  for (let d = 0; d <= L; d += cs / 2) {
    const cx = Math.floor((ox + dx * d) / cs), cz = Math.floor((oz + dz * d) / cs);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const k = `${cx + i},${cz + j}`;
      if (seen.has(k)) continue; seen.add(k);
      const c = w.chunks.get(k) || w.buildChunk(cx + i, cz + j);
      for (const col of c.colliders) {
        const r = col.br ?? radiusAt(col, Math.min(col.top, ALT));
        if (ALT > col.top + 7 || ALT < col.bottom - 7 || r <= 0) continue;
        const rx = col.x - ox, rz = col.z - oz;
        const along = rx * dx + rz * dz, lat = Math.abs(-rx * dz + rz * dx);
        if (along >= 0 && along <= L && lat < r + HALF) n++;
      }
    }
  }
  return n;
}

test('static world is sparse: few obstacles in a straight lane (30 km × world scale)', () => {
  let total = 0, lanes = 0;
  for (const seed of [1, 2, 3, 4]) {
    const w = new World(new THREE.Scene(), seed);
    total += blockingInLane(w, 0, 0, 0, -1, 30000 * WORLD_SCALE);
    total += blockingInLane(w, 20000 * WORLD_SCALE, 5000 * WORLD_SCALE, Math.SQRT1_2, -Math.SQRT1_2, 30000 * WORLD_SCALE);
    lanes += 2;
  }
  const avg = total / lanes;
  assert.ok(avg < 10, `avg ${avg.toFixed(1)} blocking obstacles per 30 km lane`);
});

function fakePlayer(tier) {
  const s = { engaged: true, tier };
  return {
    alive: true, speedSys: s, speed: TIERS[tier - 1].speed, heading: 0,
    pos: new THREE.Vector3(0, ALT, 0), flatForward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0),
  };
}

test('path events are paced by time, not distance (same rhythm at tier I and V)', () => {
  const counts = {};
  for (const tier of [1, 5]) {
    const w = new World(new THREE.Scene(), 9);
    const h = new PathHazards(w);
    const p = fakePlayer(tier);
    const dt = 1 / 30;
    for (let t = 0; t < 120; t += dt) {
      p.pos.z -= p.speed * dt;
      h.update(dt, p, 0);
    }
    counts[tier] = h.spawned;
  }
  // 120 s at 9 s ± 35% (minus the first ~1.8 km of warm-up): roughly 9-16 events
  for (const t of [1, 5]) assert.ok(counts[t] >= 8 && counts[t] <= 18, `tier ${t}: ${counts[t]} events`);
  assert.ok(Math.abs(counts[1] - counts[5]) <= 6, JSON.stringify(counts));
});

test('path structures are placed ahead on the current heading and cleaned up behind', () => {
  const w = new World(new THREE.Scene(), 3);
  const h = new PathHazards(w);
  const p = fakePlayer(3);
  for (let t = 0; t < 60; t += 1 / 30) { p.pos.z -= p.speed / 30; h.update(1 / 30, p, 0); }
  assert.ok(w.dynamic.length > 0 && w.dynamic.length <= 6, `${w.dynamic.length} live structures`);
  for (const d of w.dynamic) assert.ok(d.centerZ < p.pos.z + d.reach + 1000 * WORLD_SCALE, 'nothing far behind');
});
