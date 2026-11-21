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
import { FLIGHT, SPACE } from '../config.js';

export const CURVE = { value: 0 }; // shared uniform: 1 / (2R)
/**
 * Shared uniform: world heights (m) over which curvature fades out. The
 * planet's shell (ground, clouds, terrain) bends; things in orbit (asteroids,
 * rings, the jet up there) are not attached to it and stay straight, so what
 * you see ahead in space is where it is. Defaults sit far above any reachable
 * height (= no change on earth); Game sets them when space flight is on.
 */
export const CURVE_FADE = { value: new THREE.Vector2(1e9, 2e9) };

export const CURVE_CFG = {
  radiusFloor: 2500e3,   // m: effective planet radius near the ground
  radiusHigh: 300e3,     // m: at the ceiling
};

const logLerp = (a, b, k) => Math.exp(Math.log(a) * (1 - k) + Math.log(b) * k);
/**
 * effective radius for a camera altitude (log-ish blend, most change up high).
 * Up to the earth ceiling this is the original curve; above it (space flight)
 * the planet keeps shrinking into a ball below you.
 */
export function curveRadius(alt) {
  const E = FLIGHT.earthCeiling;
  if (alt <= E) return logLerp(CURVE_CFG.radiusFloor, CURVE_CFG.radiusHigh, Math.sqrt(Math.max(0, alt / E)));
  const t = Math.min(1, (alt - E) / (SPACE.ceiling - E));
  return logLerp(CURVE_CFG.radiusHigh, SPACE.curveRadius, Math.sqrt(t));
}
export function updateCurvature(cameraY) { CURVE.value = 1 / (2 * curveRadius(cameraY)); return CURVE.value; }

/** attach the shared curvature uniforms to a ShaderMaterial that includes CURVE_GLSL */
export function curveUniforms(material) {
  material.uniforms.uCurve = CURVE;
  material.uniforms.uCurveFade = CURVE_FADE;
  return material;
}

/** drop (m) at horizontal offset (dx, dz) for the current curvature, for a point at height y (same fade as the shader) */
export const curveDrop = (dx, dz, y = 0) => {
  const f = CURVE_FADE.value, t = Math.min(1, Math.max(0, (y - f.x) / (f.y - f.x)));
  return (dx * dx + dz * dz) * CURVE.value * (1 - t * t * (3 - 2 * t));
};

export const CURVE_GLSL = /* glsl */`
  uniform float uCurve;
  uniform vec2 uCurveFade;
  vec4 curveWorld(vec4 wp) {
    vec2 d = wp.xz - cameraPosition.xz;
    wp.y -= dot(d, d) * uCurve * (1.0 - smoothstep(uCurveFade.x, uCurveFade.y, wp.y));
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
  shader.uniforms.uCurveFade = CURVE_FADE;
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
