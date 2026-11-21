// Player airframe skins. A skin builds its geometry into the banking `body`
// group (model-local, nose toward -Z, ~15 m span so gameplay is identical)
// and returns what the rest of the game needs from it:
//   flames      exhaust meshes (their local Z scale = thrust)
//   nozzles     contrail emitters (model-local points), one per contrail
//   hardpoints  { gun: [left, right], rail: [left, right] } muzzle points
// Add a skin: add an entry to SKINS and its id to SKIN_IDS (config.js).
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { labMaterial, edgeMaterial } from './materials.js';
import { PALETTE, SKIN_IDS } from '../config.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function outlined(geo, color, edge = PALETTE.ink, threshold = 25, lift = 0) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, labMaterial({ color, contour: 0, lift })));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), edgeMaterial(edge, 1)));
  return g;
}
function tri(points) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  g.computeVertexNormals();
  return g;
}
/** exhaust: a white cone pointing back (+Z) from (x,y,z) plus a white core disc */
function exhaust(body, x, y, z, r, flatten = [1, 1]) {
  const cone = new THREE.ConeGeometry(r, 1, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
  cone.scale(flatten[0], flatten[1], 1);
  const flame = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
  flame.position.set(x, y, z);
  body.add(flame);
  const disc = new THREE.CircleGeometry(r * 0.9, 14); disc.scale(flatten[0], flatten[1], 1);
  const core = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  core.position.set(x, y, z + 0.01);
  body.add(core);
  return flame;
}

/**
 * B-2 lofted surface. Units: half-span = 1, scaled by S. Leading edges run
 * along D (both sides); the trailing edge zigzag (right half, x >= 0) uses only
 * the two leading-edge directions. Each spanwise station is a thin airfoil
 * (top = 2.6·sqrt(u)·(1-u), bottom = 0.55·top) scaled by the local thickness.
 * Centered so the model origin sits mid-length.
 */
function b2Surface(S) {
  const D = 0.779; // leading-edge slope dz/dx (photo proportions: span ≈ 2.6 × length)
  // trailing edge, right half: center tail -> notch -> tooth -> notch -> tip TE -> tip LE
  const TE = [[0, 0.637], [0.135, 0.549], [0.26, 0.63], [0.48, 0.487], [0.865, 0.737], [1, 0.649]].map(([x, z]) => [x, z * (D / 0.649)]);
  const zTEu = (x) => {
    for (let i = 0; i < TE.length - 1; i++) {
      const [x0, z0] = TE[i], [x1, z1] = TE[i + 1];
      if (x <= x1) return z0 + (z1 - z0) * ((x - x0) / (x1 - x0));
    }
    return TE[TE.length - 1][1];
  };
  const zLEu = (x) => D * x;
  const thick = (x) => 0.02 + 0.115 * Math.exp(-((x / 0.11) ** 2)) + 0.03 * Math.exp(-(((x - 0.2) / 0.075) ** 2));
  const top = (u) => 2.6 * Math.sqrt(Math.max(0, u)) * (1 - u);
  const Z0 = -0.5 * zTEu(0) * S; // shift so the origin is mid-length
  // stations: uniform + every planform break point (keeps the zigzag corners sharp)
  const xs = [...new Set([...Array.from({ length: 41 }, (_, i) => i / 40), ...TE.map(([x]) => x)].map((v) => +v.toFixed(5)))].sort((a, b) => a - b);
  const NU = 16;
  const us = Array.from({ length: NU + 1 }, (_, k) => (1 - Math.cos((Math.PI * k) / NU)) / 2); // cosine spacing
  const pos = [], idx = [];
  const grid = (side, sy) => {           // side: +1 right / -1 left; sy: +1 top / -1 bottom
    const base = pos.length / 3;
    for (const x of xs) {
      const zl = zLEu(x), zt = zTEu(x), t = thick(x);
      for (const u of us) pos.push(side * x * S, sy * t * top(u) * (sy > 0 ? 1 : 0.55) * S, (zl + u * (zt - zl)) * S + Z0);
    }
    const W = us.length;
    for (let i = 0; i < xs.length - 1; i++) for (let k = 0; k < NU; k++) {
      const a = base + i * W + k, b = a + 1, c = a + W, d = c + 1;
      // outward winding: top faces up, bottom faces down; mirrored side flips
      if (side * sy > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
  };
  grid(1, 1); grid(1, -1); grid(-1, 1); grid(-1, -1);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g = mergeVertices(g, 1e-4);
  g.computeVertexNormals();
  g.userData = {
    Z0,
    zLE: (xm) => zLEu(Math.abs(xm) / S) * S + Z0,
    zTE: (xm) => zTEu(Math.abs(xm) / S) * S + Z0,
    /** height of the upper surface at model-local (x, z) */
    yTop: (xm, zm) => {
      const x = Math.min(1, Math.abs(xm) / S), zl = zLEu(x), zt = zTEu(x);
      const u = Math.min(1, Math.max(0, ((zm - Z0) / S - zl) / Math.max(1e-6, zt - zl)));
      return thick(x) * top(u) * S;
    },
  };
  return g;
}

export const SKINS = {
  /**
   * Northrop B-2 Spirit: one smooth lofted flying-wing surface.
   * Planform follows the real aircraft's rule that every edge is parallel to
   * one of the two leading edges: constant-chord outer wings (trailing edge
   * parallel to the leading edge), wingtips cut parallel to the opposite
   * leading edge, and the double-W sawtooth whose two teeth and center tail
   * line up at the same depth. Thickness swells into the center body and over
   * the engines, tapering to razor-thin edges.
   */
  'b2-spirit': {
    name: 'northrop b-2 spirit',
    build(body) {
      const DARK = 0x3d444a, EDGE = 0xd9dde1, S = 7.8;  // dark slate; S = half-span (m)
      const geo = b2Surface(S);
      body.add(outlined(geo, DARK, EDGE, 24, 0.12));
      const { yTop, zLE, zTE, Z0 } = geo.userData;
      // flush details on the upper surface: cockpit windows, intakes, exhaust trenches
      const flush = (x, z, w, d, color, yaw = 0) => {
        const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
        const e = 0.25, slopeZ = (yTop(x, z + e) - yTop(x, z - e)) / (2 * e), slopeX = (yTop(x + e, z) - yTop(x - e, z)) / (2 * e);
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
        m.rotation.set(-Math.atan(slopeZ), yaw, Math.atan(slopeX), 'YXZ');
        m.position.set(x, yTop(x, z) + 0.03, z);
        body.add(m);
      };
      // positions are measured back from the leading edge at that span station
      for (const sx of [-1, 1]) {
        flush(sx * 0.32, zLE(0.32) + 0.75, 0.42, 0.34, 0x8d939a, sx * -0.35);  // front windscreen panes
        flush(sx * 0.62, zLE(0.62) + 0.7, 0.26, 0.3, 0x8d939a, sx * -0.8);     // side panes
        flush(sx * 1.55, zLE(1.55) + 0.9, 1.0, 0.32, PALETTE.ink, sx * -0.45); // engine intakes (sawtooth lip)
      }
      const flames = [], nozzles = [];
      for (const sx of [-1, 1]) {
        const x = sx * 1.7, z = zTE(Math.abs(x)) - 0.55;
        flush(x, z - 0.35, 1.3, 0.5, PALETTE.ink);                         // exhaust trench
        flames.push(exhaust(body, x, yTop(x, z) + 0.05, z - 0.1, 0.4, [1.9, 0.4]));
        nozzles.push(V(x, yTop(x, z) + 0.05, z + 0.8));
      }
      return {
        flames, nozzles,
        hardpoints: {
          gun: [V(-2.6, 0, zLE(2.6) + 0.15), V(2.6, 0, zLE(2.6) + 0.15)], // wing leading edge
          rail: [V(-0.75, -0.45, Z0 + 1.6), V(0.75, -0.45, Z0 + 1.6)],    // bomb bays (belly)
        },
      };
    },
  },

  /** The original lab interceptor: white delta, ink outlines, dark engine pods. */
  'lab-interceptor': {
    name: 'lab interceptor',
    build(body) {
      const fus = new THREE.CylinderGeometry(0.95, 1.15, 9, 8, 1); fus.rotateX(Math.PI / 2);
      body.add(outlined(fus, 0xffffff));
      const nose = new THREE.ConeGeometry(0.95, 5.5, 8, 1); nose.rotateX(-Math.PI / 2); nose.translate(0, 0, -7.25);
      body.add(outlined(nose, 0xffffff));
      const tail = new THREE.ConeGeometry(1.15, 2.4, 8, 1, true); tail.rotateX(Math.PI / 2); tail.translate(0, 0, 5.7);
      body.add(outlined(tail, 0x3a3e44));
      const canopy = new THREE.SphereGeometry(0.75, 10, 6); canopy.scale(1, 0.7, 2.6); canopy.translate(0, 0.8, -3.2);
      body.add(outlined(canopy, 0x2a2d31, PALETTE.ink, 40));
      for (const s of [-1, 1]) {
        const w = tri([0, 0, -2.5, s * 7.2, -0.25, 3.6, 0, 0, 3.8, 0, 0, -2.5, 0, 0, 3.8, s * 7.2, -0.25, 3.6]);
        body.add(outlined(w, 0xf4f4f4, PALETTE.ink, 1));
        const fin = tri([s * 0.6, 0.6, 2.2, s * 1.4, 3.6, 4.6, s * 0.6, 0.6, 4.6, s * 0.6, 0.6, 2.2, s * 0.6, 0.6, 4.6, s * 1.4, 3.6, 4.6]);
        body.add(outlined(fin, 0xf4f4f4, PALETTE.ink, 1));
      }
      const flames = [], nozzles = [];
      for (const s of [-1, 1]) {
        const pod = new THREE.CylinderGeometry(0.62, 0.75, 4.4, 10, 1); pod.rotateX(Math.PI / 2); pod.translate(s * 3.3, -0.55, 2.0);
        body.add(outlined(pod, 0x2a2d31));
        flames.push(exhaust(body, s * 3.3, -0.55, 4.2, 0.55));
        nozzles.push(V(s * 3.3, -0.55, 5.0));
      }
      return {
        flames, nozzles,
        hardpoints: {
          gun: [V(-3.3, -0.55, -0.35), V(3.3, -0.55, -0.35)],  // front of the engine pods
          rail: [V(-2.2, -0.95, 0.9), V(2.2, -0.95, 0.9)],     // under the wings
        },
      };
    },
  },
};

export const DEFAULT_SKIN = SKIN_IDS[0];
for (const id of SKIN_IDS) if (!SKINS[id]) throw new Error(`skin ${id} listed in SKIN_IDS but not defined`);
