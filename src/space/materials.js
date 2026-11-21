// Orbit materials. Same drawing language as the planet (faceted bodies, a
// white silhouette rim, no inner lines) but lit like vacuum: a hard
// terminator, near-black night side, a faint blue planetshine from below and
// no fog (far bodies dissolve into the black instead).
//
// Bodies spin in the vertex shader (per-vertex center + axis/rate), so a
// whole streamed column of tumbling asteroids is still one draw call.
import * as THREE from 'three';
import { SUN_DIR } from '../render/materials.js';
import { CURVE_GLSL, curveUniforms } from '../render/curvature.js';
import { SPACE, PALETTE } from '../config.js';

/** shared, live uniforms: game time (spin) and the fade-out distance */
export const SPACE_TIME = { value: 0 };
export const SPACE_FAR = { value: 80000 };

const SPIN_GLSL = /* glsl */`
  attribute vec3 aCenter;
  attribute vec4 aSpin;      // xyz unit axis, w rad/s
  uniform float uTime;
  vec3 spinAround(vec3 v, vec3 k, float a) {
    float c = cos(a), s = sin(a);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }
`;

const FADE_GLSL = /* glsl */`
  uniform vec3 uSpace;
  uniform float uFar;
  vec3 fadeOut(vec3 col, vec3 world) {
    return mix(col, uSpace, smoothstep(uFar * 0.7, uFar, distance(world, cameraPosition)));
  }
`;

function shared(m) {
  m.uniforms.uTime = SPACE_TIME;
  m.uniforms.uFar = SPACE_FAR;
  return curveUniforms(m);
}

export function bodyMaterial() {
  return shared(new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SUN_DIR.clone() },
      uSpace: { value: new THREE.Color(SPACE.colors.space) },
      uShine: { value: new THREE.Color(SPACE.colors.planetshine) },
    },
    vertexShader: /* glsl */`
      ${CURVE_GLSL}
      ${SPIN_GLSL}
      attribute vec3 color;
      varying vec3 vColor;
      varying vec3 vN;
      varying vec3 vWorld;
      void main() {
        float a = aSpin.w * uTime;
        vec3 p = aCenter + spinAround(position - aCenter, aSpin.xyz, a);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * spinAround(normal, aSpin.xyz, a));
        vColor = color;
        gl_Position = projectionMatrix * viewMatrix * curveWorld(wp);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun;
      uniform vec3 uShine;
      varying vec3 vColor;
      varying vec3 vN;
      varying vec3 vWorld;
      ${FADE_GLSL}
      void main() {
        vec3 n = normalize(vN);
        float d = dot(n, uSun);
        float lit = smoothstep(-0.02, 0.08, d);                 // hard vacuum terminator
        vec3 col = vColor * (0.10 + 0.90 * lit * (0.70 + 0.30 * d));
        col += uShine * max(-n.y, 0.0) * 0.16 * (1.0 - 0.6 * lit); // planetshine on the belly
        gl_FragColor = vec4(fadeOut(col, vWorld), 1.0);
      }`,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }));
}

/** inverted-hull white rim, spun exactly like bodyMaterial; uWidth/uRes are shared with the planet's rim */
export function bodyOutlineMaterial(widthUniform, resUniform, color = 0xffffff) {
  const m = shared(new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSpace: { value: new THREE.Color(SPACE.colors.space) },
      uWidth: widthUniform || { value: 2 },
      uRes: resUniform || { value: new THREE.Vector2(1920, 1080) },
    },
    vertexShader: /* glsl */`
      ${CURVE_GLSL}
      ${SPIN_GLSL}
      attribute vec3 aSmooth;
      uniform float uWidth;
      uniform vec2 uRes;
      varying vec3 vWorld;
      void main() {
        float a = aSpin.w * uTime;
        vec3 p = aCenter + spinAround(position - aCenter, aSpin.xyz, a);
        vec4 wp = curveWorld(modelMatrix * vec4(p, 1.0));
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vec4 clip = projectionMatrix * mv;
        vec3 vn = normalize(mat3(viewMatrix) * normalize(mat3(modelMatrix) * spinAround(aSmooth, aSpin.xyz, a)));
        vec2 sdir = (projectionMatrix * vec4(vn, 0.0)).xy;
        float l = length(sdir);
        float w = uWidth * mix(1.0, 0.3, smoothstep(3000.0, 40000.0, -mv.z)); // far bodies: hairline rim, not a white donut
        if (l > 1e-5) clip.xy += (sdir / l) * w * 2.0 / uRes * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying vec3 vWorld;
      ${FADE_GLSL}
      void main() { gl_FragColor = vec4(fadeOut(uColor, vWorld), 1.0); }`,
    side: THREE.BackSide,
  }));
  return m;
}

/**
 * Boost ring: ink / white segments that crawl around the ring, plus a white
 * flash when you fly through (uPass = time of the pass). One instance per ring.
 */
export function ringMaterial(stripes = 16) {
  return shared(new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SUN_DIR.clone() },
      uSpace: { value: new THREE.Color(SPACE.colors.space) },
      uInk: { value: new THREE.Color(PALETTE.ink) },
      uStripes: { value: stripes },
      uPass: { value: -100 },
    },
    vertexShader: /* glsl */`
      ${CURVE_GLSL}
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * curveWorld(wp);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun;
      uniform vec3 uInk;
      uniform float uStripes;
      uniform float uPass;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vWorld;
      ${FADE_GLSL}
      void main() {
        float s = step(0.5, fract(vUv.x * uStripes - uTime * 0.35));
        vec3 col = mix(uInk, vec3(1.0), s);
        float d = max(dot(normalize(vN), uSun), 0.0);
        col *= 0.78 + 0.22 * d;
        float flash = exp(-max(0.0, uTime - uPass) * 3.5);
        col = mix(col, vec3(1.0), flash);
        gl_FragColor = vec4(fadeOut(col, vWorld), 1.0);
      }`,
  }));
}

/** white back-face shell around a ring tube: its silhouette rim */
export function ringRimMaterial() {
  return shared(new THREE.ShaderMaterial({
    uniforms: { uSpace: { value: new THREE.Color(SPACE.colors.space) } },
    vertexShader: /* glsl */`
      ${CURVE_GLSL}
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * curveWorld(wp);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vWorld;
      ${FADE_GLSL}
      void main() { gl_FragColor = vec4(fadeOut(vec3(1.0), vWorld), 1.0); }`,
    side: THREE.BackSide,
  }));
}

/** the material set a SpaceBuilder bakes with (World.finalize passes it through) */
export function spaceMaterials(world) {
  const ou = world.materials.outline.uniforms;
  return { body: bodyMaterial(), outline: bodyOutlineMaterial(ou.uWidth, ou.uRes), ringRim: ringRimMaterial() };
}
