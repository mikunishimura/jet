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
  // ambient layer (AmbientLayer.js): all scaled by uAmb, 0 = untouched sky
  uniform float uAmb;      // ambient gate 0..1
  uniform float uSpace;    // 0 day .. 1 edge of space (with tier)
  uniform vec3 uSpaceZen;
  uniform float uStars;
  uniform float uBeat;     // beat swell 0..pulse amp
  uniform vec2 uShafts;    // x alpha, y count
  uniform sampler2D uMachTex;
  uniform float uMachA;
  // orbit (space flight, src/space/Space.js): 0 below the earth ceiling = untouched sky
  uniform float uOrbit;    // 0 day .. 1 black space sky
  uniform float uLimb;     // sin(elevation) of the planet's limb (<= 0)
  uniform vec3 uVoid;      // the black of space
  varying vec3 vDir;

  ${CLOUD_GLSL}

  float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  // one star per lit cell of a 3D grid over the sphere (no pole pinching, no
  // derivatives). n: cells per radian, keep: share of lit cells, size: radius in cells
  float starLayer(vec3 d, float n, float keep, float size) {
    vec3 c = floor(d * n);
    float h = hash3(c);
    if (h > keep) return 0.0;
    vec3 sp = normalize(c + vec3(hash3(c + 1.7), hash3(c + 9.2), hash3(c + 4.3)));
    float k = length(d * n - sp * n);
    return smoothstep(size, size * 0.25, k) * (0.45 + 0.55 * hash3(c + 2.9));
  }
  // anime night: crisp white stars in three sizes, a faint periwinkle galaxy band,
  // a bright atmosphere rim right above the planet's limb
  vec3 orbitSky(vec3 d, float sd) {
    vec3 col = uVoid;
    vec3 mwN = normalize(vec3(0.42, 0.78, -0.46));
    float b = dot(d, mwN);
    float band = exp(-b * b / 0.018);
    vec2 mp = vec2(atan(d.z, d.x) * 2.6, b * 9.0);
    float neb = fbm(mp * 1.8 + 7.0);
    col += vec3(0.17, 0.2, 0.36) * band * smoothstep(0.38, 0.78, neb) * 0.6;
    float st = starLayer(d, 260.0, 0.05 + 0.12 * band, 0.32) * 0.55
             + starLayer(d, 110.0, 0.05, 0.26)
             + starLayer(d, 34.0, 0.035, 0.11) * 1.6;
    col += vec3(0.9, 0.93, 1.0) * st * (0.9 + 0.1 * sin(uTime * 3.1 + d.x * 400.0));
    // sun in vacuum: harder disc, tighter glare
    col = mix(col, vec3(1.0), smoothstep(0.9982, 0.9987, sd));
    col += vec3(0.22) * pow(sd, 90.0) + vec3(0.06) * pow(sd, 12.0);
    // atmosphere: a thin pale rim on the limb, a wider blue glow over it
    float h = d.y - uLimb;
    float rim = exp(-max(h, 0.0) * 55.0), glow = exp(-max(h, 0.0) * 9.0);
    col = mix(col, uMid, glow * 0.42);
    col = mix(col, uHorizon, rim * 0.9);
    col = mix(col, uHorizon, smoothstep(0.0, -0.004, h)); // below the limb: planet haze
    return col;
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = d.y;
    // anime gradient: pale horizon band -> clear cyan-blue -> saturated zenith
    vec3 zen = mix(uZenith, uZenith * vec3(0.78, 0.86, 1.0), uTint);
    // climbing out (uOrbit > 0): the gradient's horizon slides down onto the planet's limb
    float upG = mix(up, (up - uLimb) / (1.0 - uLimb), uOrbit);
    vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, upG));
    col = mix(col, zen, smoothstep(0.18, 0.9, upG));
    col += vec3(0.05) * exp(-max(upG, 0.0) * 24.0); // bright haze line at the horizon

    // ambient: the sky drifts toward space as you climb tiers (zenith darkens, stars come out)
    float azA = atan(d.x, d.z);
    float spc = uSpace * uAmb;
    col = mix(col, uSpaceZen, spc * 0.88 * smoothstep(0.06, 0.85, up));
    vec2 sg = vec2(azA * 90.0, up * 90.0);
    vec2 scell = floor(sg);
    float shs = fract(sin(dot(scell, vec2(12.9898, 78.233))) * 43758.5453);
    float star = step(0.986, shs) * (1.0 - smoothstep(0.06, 0.2, length(fract(sg) - 0.5)));
    col += vec3(star) * spc * uStars * smoothstep(0.12, 0.45, up) * (0.75 + 0.25 * sin(uTime * 2.3 + shs * 40.0));
    // ambient: soft light shafts at fixed world azimuths, sliding past as you turn
    float sa = (azA + 3.14159265) / 6.2831853 * uShafts.y + uTime * 0.008;
    float sid = floor(sa);
    float son = step(0.4, fract(sin(sid * 91.7) * 4375.85));
    float sw = abs(fract(sa) - 0.5);
    float shaft = son * (1.0 - smoothstep(0.0, 0.05 + 0.04 * fract(sid * 7.31), sw)) * smoothstep(0.0, 0.06, up) * (1.0 - smoothstep(0.25, 0.7, up));
    col += vec3(uShafts.x * uAmb * (1.0 - 0.6 * spc)) * shaft;

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
    // ambient: the live Mach number painted huge and faint in the far sky, ahead of you,
    // behind the clouds (typography as scenery)
    vec2 dh = normalize(d.xz + vec2(1e-6));
    float relA = atan(uFlight.x * dh.y - uFlight.y * dh.x, dot(uFlight, dh));
    vec2 guv = vec2(0.5 + relA / 1.1, (up - 0.16) / 0.34);
    if (guv.x > 0.0 && guv.x < 1.0 && guv.y > 0.0 && guv.y < 1.0) col = mix(col, uOutline * 0.45, texture2D(uMachTex, guv).a * uMachA * uAmb);

    float upc = max(up, 0.012);
    vec2 relH = d.xz * (max(0.5, uHighH - uCamAlt) / upc) / uHighScale;
    vec4 ch = toon(uHighOff + relH, 0.54, uSun.xz * 0.16);
    // past the earth ceiling you climb through this layer: it thins out (no-op below 24 km)
    col = mix(col, ch.rgb, ch.a * smoothstep(0.035, 0.16, up) * (1.0 - smoothstep(24.0, 31.0, uCamAlt)));
    if (uOrbit > 0.0) col = mix(col, orbitSky(d, sd), uOrbit);
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
        uAmb: { value: 0 }, uSpace: { value: 0 }, uSpaceZen: { value: c(0x060914) }, uStars: { value: 0.9 },
        uBeat: { value: 0 }, uShafts: { value: new THREE.Vector2(0.07, 7) },
        uMachTex: { value: null }, uMachA: { value: 0 },
        uOrbit: { value: 0 }, uLimb: { value: 0 }, uVoid: { value: c(0x04060c) },
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
