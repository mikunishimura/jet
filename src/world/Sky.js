// Anime-style sky: saturated blue gradient, crisp sun, and cel-shaded clouds
// (white tops, periwinkle shadows, thin outlines: the same "drawn edge" look
// as the terrain). Three layers carry the sense of speed:
//   * horizon cumulus towers: very far, only rotate when you turn
//   * high cumulus field: slow parallax
//   * low puff layer: fast parallax overhead, smeared along your flight
//     direction as speed rises (anime speed streaks). The smear is symmetric
//     around each point, so the cloud field never moves when only speed
//     changes (an earlier version rescaled it around the camera: clouds slid
//     at launch and at every barrier).
// Noise is 256-periodic so the camera offset can be wrapped: stays crisp
// after thousands of kilometres.
import * as THREE from 'three';
import { SUN_DIR } from '../render/materials.js';
import { WORLD_SCALE, TIERS } from '../config.js';

const vert = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // at far plane
  }
`;

/** shared cloud functions (noise + cel shading). The includer declares
 *  uShadow, uOutline, uFlight. */
export const CLOUD_GLSL = /* glsl */`
  float hash(vec2 i) { i = mod(i, 256.0); return fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  // lacunarity exactly 2 + integer offsets: stays 256-periodic.
  // 4 octaves, low gain: round, puffy shapes (no swiss-cheese holes)
  float fbm(vec2 p) {
    float s = 0.0, a = 0.55, n = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); n += a; p = p * 2.0 + vec2(17.0, 9.0); a *= 0.42; }
    return s / n;
  }

  // cel-shaded cloud layer: crisp edge, two tones, drawn outline
  // NOTE: no early returns / branches around fwidth (derivatives must be
  // computed in uniform control flow, or blocky artifacts appear)
  vec4 toon(vec2 p, float th, vec2 sunOff) {
    float n = fbm(p);
    float m = n - th;
    float w = fwidth(n) * 1.25 + 1e-4;
    float a = smoothstep(-w, w, m);
    float n2 = fbm(p + sunOff);
    float lit = 1.0 - smoothstep(-0.01, 0.01, n2 - n - 0.01); // denser toward the sun = shadow
    vec3 c = mix(uShadow, vec3(1.0), lit);
    float edge = 1.0 - smoothstep(0.0, w * 1.6, abs(m));
    c = mix(c, uOutline, edge * 0.8);
    return vec4(c, a);
  }

  // speed streaks: density averaged over a SYMMETRIC window along the flight
  // direction, so shapes elongate in place instead of sliding
  vec4 toonSmear(vec2 p, float th, vec2 sunOff, float len) {
    vec2 o = uFlight * len;
    float n = (fbm(p - o) + fbm(p - o * 0.5) + fbm(p) + fbm(p + o * 0.5) + fbm(p + o)) * 0.2;
    float m = n - th;
    float w = fwidth(n) * 1.25 + 1e-4;
    float a = smoothstep(-w, w, m);
    float n2 = fbm(p + sunOff);
    float lit = 1.0 - smoothstep(-0.01, 0.01, n2 - fbm(p) - 0.01);
    vec3 c = mix(uShadow, vec3(1.0), lit);
    float edge = 1.0 - smoothstep(0.0, w * 1.6, abs(m));
    c = mix(c, uOutline, edge * 0.8);
    return vec4(c, a);
  }

`;

const frag = /* glsl */`
  uniform vec2 uLowOff;    // low layer: camera offset in noise units (wrapped)
  uniform vec2 uHighOff;   // high layer: camera offset in noise units (wrapped)
  uniform float uLowH;     // layer heights (km)
  uniform float uHighH;
  uniform float uLowScale; // km per noise unit
  uniform float uHighScale;
  uniform float uTime;
  uniform float uSpeed01;  // 0..1 (tier V)
  uniform vec2 uFlight;    // horizontal flight direction (unit, world xz)
  uniform vec3 uSun;
  uniform vec3 uZenith;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uShadow;
  uniform vec3 uOutline;
  uniform float uTint;
  uniform float uCamAlt;   // camera altitude (km)
  varying vec3 vDir;

  ${CLOUD_GLSL}

  void main() {
    vec3 d = normalize(vDir);
    float up = d.y;
    // anime gradient: pale horizon band -> clear cyan-blue -> saturated zenith
    vec3 zen = mix(uZenith, uZenith * vec3(0.78, 0.86, 1.0), uTint);
    vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, up));
    col = mix(col, zen, smoothstep(0.18, 0.9, up));
    col += vec3(0.05) * exp(-max(up, 0.0) * 24.0); // bright haze line at the horizon

    // sun: crisp disc + soft white halo (no warm tint)
    float sd = max(dot(d, uSun), 0.0);
    col = mix(col, vec3(1.0), smoothstep(0.9985, 0.9990, sd));
    col += vec3(0.16) * pow(sd, 40.0);

    // horizon cumulus towers (azimuth silhouette; seamless around 360°)
    float az = atan(d.x, d.z);
    vec2 ring = vec2(cos(az), sin(az));
    float tower = pow(fbm(ring * 2.2 + 11.0), 1.6);
    float h = 0.03 + 0.30 * smoothstep(0.25, 0.85, tower) + 0.018 * vnoise(ring * 30.0 + 4.0) + 0.01 * vnoise(ring * 70.0);
    float wu = fwidth(up) * 1.3 + 1e-5;
    // towers sit on the horizon seen from low altitude; fade them out as you climb past them
    float inside = smoothstep(wu, -wu, up - h) * step(-0.05, up) * (1.0 - smoothstep(3.0, 12.0, uCamAlt));
    float band = h * (0.30 + 0.10 * vnoise(ring * 12.0));          // shadowed base
    vec3 tc = mix(uShadow, vec3(1.0), smoothstep(band - wu, band + wu, up));
    float edge = 1.0 - smoothstep(0.0, wu * 2.0, abs(up - h));
    tc = mix(tc, uOutline, edge * 0.75);
    tc = mix(tc, uHorizon, smoothstep(0.05, 0.0, up) * 0.6);      // haze at the base
    col = mix(col, tc, inside);

    // high cumulus field (slow parallax), always above you (ceiling < deck).
    // The LOW deck is real geometry (Clouds.js) so you can fly above it.
    float upc = max(up, 0.012);
    vec2 relH = d.xz * (max(0.5, uHighH - uCamAlt) / upc) / uHighScale;
    vec4 ch = toon(uHighOff + relH, 0.54, uSun.xz * 0.16);
    col = mix(col, ch.rgb, ch.a * smoothstep(0.035, 0.16, up));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const S = WORLD_SCALE;
export const LAYERS = {
  low: { h: 0.4 * S, scale: 0.22 * S },   // km height, km per noise unit
  high: { h: 1.6 * S, scale: 0.9 * S },
};

export const SKY_COLORS = {
  zenith: 0x1f7cf0,
  mid: 0x6fb8ff,
  horizon: 0xe8f4ff,   // == fog color so terrain melts into the sky
  shadow: 0xb9cdf2,
  outline: 0x5d77a6,
};

export class Sky {
  constructor(scene) {
    const c = (h) => new THREE.Color(h);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uLowOff: { value: new THREE.Vector2() },
        uHighOff: { value: new THREE.Vector2() },
        uLowH: { value: LAYERS.low.h }, uHighH: { value: LAYERS.high.h },
        uLowScale: { value: LAYERS.low.scale }, uHighScale: { value: LAYERS.high.scale },
        uTime: { value: 0 },
        uSpeed01: { value: 0 },
        uFlight: { value: new THREE.Vector2(0, -1) },
        uSun: { value: SUN_DIR.clone() },
        uZenith: { value: c(SKY_COLORS.zenith) },
        uMid: { value: c(SKY_COLORS.mid) },
        uHorizon: { value: c(SKY_COLORS.horizon) },
        uShadow: { value: c(SKY_COLORS.shadow) },
        uOutline: { value: c(SKY_COLORS.outline) },
        uTint: { value: 0 },
        uCamAlt: { value: 0 },
      },
      vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(5000, 64, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2;
    scene.add(this.mesh);
  }
  /** camera: render camera; origin: floating origin; flight: {x,z} unit; speed: m/s */
  update(camera, origin, time, tint, flight, speed = 0) {
    this.mesh.position.copy(camera.position);
    const u = this.material.uniforms;
    // camera absolute position in km, then per-layer noise units wrapped to 256
    const kx = (camera.position.x + origin.x) / 1000, kz = (camera.position.z + origin.z) / 1000;
    const wrap = (v) => ((v % 256) + 256) % 256;
    // slow drift so clouds live even when hovering
    u.uLowOff.value.set(wrap(kx / LAYERS.low.scale + time * 0.01), wrap(kz / LAYERS.low.scale));
    u.uHighOff.value.set(wrap(kx / LAYERS.high.scale + time * 0.004), wrap(kz / LAYERS.high.scale));
    u.uTime.value = time;
    u.uTint.value = tint;
    u.uCamAlt.value = camera.position.y / 1000;
    u.uSpeed01.value = Math.min(1, speed / TIERS[TIERS.length - 1].speed);
    if (flight) u.uFlight.value.set(flight.x, flight.z);
  }
}
