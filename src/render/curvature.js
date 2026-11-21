// Stylized planet curvature (visual only: collisions stay flat).
//
// Every world vertex is pulled down by d² / 2R, d = horizontal distance from
// the camera. R shrinks with altitude: on the floor the world reads flat with
// slightly rounded far edges (things rise over the horizon like ships); high
// up it is clearly a sphere.
//
// Custom ShaderMaterials call curveWorld() themselves (see CURVE_GLSL).
// Built-in materials (lines, basic meshes) get it through patchMaterial(),
// which swaps three's project_vertex chunk via onBeforeCompile.
import * as THREE from 'three';
import { FLIGHT } from '../config.js';

export const CURVE = { value: 0 }; // shared uniform: 1 / (2R)

export const CURVE_CFG = {
  radiusFloor: 2500e3,   // m: effective planet radius near the ground
  radiusHigh: 300e3,     // m: at the ceiling
};

/** effective radius for a camera altitude (log-ish blend, most change up high) */
export function curveRadius(alt) {
  const t = Math.min(1, Math.max(0, alt / FLIGHT.ceiling));
  const k = Math.sqrt(t);
  return Math.exp(Math.log(CURVE_CFG.radiusFloor) * (1 - k) + Math.log(CURVE_CFG.radiusHigh) * k);
}
export function updateCurvature(cameraY) { CURVE.value = 1 / (2 * curveRadius(cameraY)); return CURVE.value; }

/** drop (m) at horizontal distance d for the current curvature */
export const curveDrop = (dx, dz) => (dx * dx + dz * dz) * CURVE.value;

export const CURVE_GLSL = /* glsl */`
  uniform float uCurve;
  vec4 curveWorld(vec4 wp) {
    vec2 d = wp.xz - cameraPosition.xz;
    wp.y -= dot(d, d) * uCurve;
    return wp;
  }
`;

const PROJECT = /* glsl */`
  vec4 mvPosition = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    mvPosition = batchingMatrix * mvPosition;
  #endif
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  mvPosition = viewMatrix * curveWorld( modelMatrix * mvPosition );
  gl_Position = projectionMatrix * mvPosition;
`;

function onBeforeCompileCurved(shader) {
  shader.uniforms.uCurve = CURVE;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + CURVE_GLSL)
    .replace('#include <project_vertex>', PROJECT);
}

/** add curvature to a built-in material (idempotent) */
export function patchMaterial(m) {
  if (!m || m.userData.curved || m.isShaderMaterial || m.isRawShaderMaterial) return;
  m.userData.curved = true;
  m.onBeforeCompile = onBeforeCompileCurved;
  m.needsUpdate = true;
}

/** patch every built-in material in a subtree (cheap; run once per frame) */
export function patchTree(root) {
  root.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(patchMaterial); else patchMaterial(m);
  });
}
