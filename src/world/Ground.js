// Infinite lab floor: a tessellated polar disk that follows the camera (dense
// near you, coarse at the horizon) so it can bend with the planet curvature;
// the grid is computed in absolute coordinates (precision-safe via split
// uniforms), so moving the mesh never makes the lines swim.
// Distance rings every 5 km around spawn mark your progress.
import * as THREE from 'three';
import { PALETTE, WORLD_SCALE } from '../config.js';
import { CURVE, CURVE_GLSL } from '../render/curvature.js';

/** rings spaced exponentially from 0 to `radius`: fine detail near the camera */
export function polarDisk(radius, rings = 64, segs = 96, first = 30) {
  const pos = [0, 0, 0];
  const k = Math.pow(radius / first, 1 / (rings - 1));
  for (let r = 0; r < rings; r++) {
    const rad = first * Math.pow(k, r);
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }
  const idx = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const a = 1 + r * segs + s, b = 1 + r * segs + ((s + 1) % segs);
      const c = a + segs, d = b + segs;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const vert = /* glsl */`
  #include <fog_pars_vertex>
  ${CURVE_GLSL}
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;                       // flat coords for the grid
    vec4 mvPosition = viewMatrix * curveWorld(wp);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const frag = /* glsl */`
  #include <fog_pars_fragment>
  uniform vec2 uOriginMod;   // origin mod 10000 (small, precise)
  uniform vec2 uTileOffset;  // (origin - originMod) / 250, exact integers
  uniform float uSpeed;      // m/s: grid levels that would strobe fade out
  uniform float uScale;      // world scale for spawn rings / runway
  uniform vec2 uOrigin;      // origin, for spawn-distance rings (coarse ok)
  uniform vec3 uBase;
  uniform vec3 uLine;
  uniform vec3 uAccent;
  uniform vec3 uCamPos;
    varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float gridLine(vec2 p, float spacing, float width) {
    vec2 g = p / spacing;
    vec2 w = fwidth(g);
    vec2 d = abs(fract(g + 0.5) - 0.5);
    vec2 l = 1.0 - smoothstep(vec2(0.0), w * width, d);
    return max(l.x, l.y) * (1.0 - smoothstep(0.15, 0.45, max(w.x, w.y)));
  }
  // how many lines of this spacing cross per second: fade before it strobes
  float lod(float spacing) { return 1.0 - smoothstep(18.0, 45.0, uSpeed / spacing); }
  void main() {
    vec2 p = vWorld.xz + uOriginMod;
    float dist = length(vWorld.xz - uCamPos.xz);

    // floor plates (250 m) with subtle value variation
    vec2 tile = floor(p / 250.0) + uTileOffset;
    float h = hash(tile);
    vec3 col = uBase;                                  // pure white floor
    if (h > 0.93) col *= 1.0 - 0.04 * lod(250.0);     // rare, faintly darker service plates (neutral)
    // plate seams
    col = mix(col, uLine, gridLine(p, 250.0, 0.6) * 0.35 * lod(250.0));
    // 25 m measurement grid, fading with distance and speed
    float minor = gridLine(p, 25.0, 0.5) * (1.0 - smoothstep(600.0, 1800.0, dist)) * lod(25.0);
    col = mix(col, uLine, minor * 0.18);
    // 1 km and 5 km grids: the lines that carry speed at Mach 50+
    col = mix(col, uLine * 0.8, gridLine(p, 1000.0, 0.7) * 0.45 * lod(1000.0));
    col = mix(col, uLine * 0.6, gridLine(p, 5000.0, 0.8) * 0.55);
    // tiny crosses at 25 m intersections when close (lab tape markers)
    vec2 q = abs(fract(p / 25.0 + 0.5) - 0.5) * 25.0;
    float cross = step(min(q.x, q.y), 0.18) * step(max(q.x, q.y), 1.4) * (1.0 - smoothstep(150.0, 400.0, dist)) * lod(25.0);
    col = mix(col, uLine * 0.5, cross * 0.6);

    // spawn pad + distance rings every 5 km
    vec2 abs2 = vWorld.xz + uOrigin;
    float r = length(abs2);
    float ringSp = 5000.0 * uScale;
    float ringD = abs(mod(r + ringSp * 0.5, ringSp) - ringSp * 0.5);
    float ringW = fwidth(r) * 0.8 + 1.0;
    float ring = (1.0 - smoothstep(ringW, ringW + fwidth(r) * 1.2, ringD)) * step(1000.0 * uScale, r);
    col = mix(col, uAccent, ring * 0.6);
    float pad = (1.0 - smoothstep(118.0 * uScale, 122.0 * uScale, r)) * smoothstep(110.0 * uScale, 114.0 * uScale, r);
    col = mix(col, uAccent, pad);
    // hazard stripes along the launch runway
    if (abs2.y < 0.0 && abs2.y > -3200.0 * uScale) {
      float edge = step(abs(abs(abs2.x) - 250.0 * uScale), max(fwidth(abs2.x) * 0.8, 6.0));
      float dash = step(0.5, fract(abs2.y / (60.0 * uScale)));
      col = mix(col, uAccent, edge * dash * 0.9);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

export class Ground {
  constructor(scene) {
    const geo = polarDisk(160000);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uOriginMod: { value: new THREE.Vector2() },
        uTileOffset: { value: new THREE.Vector2() },
        uOrigin: { value: new THREE.Vector2() },
        uBase: { value: new THREE.Color(PALETTE.ground) },
        uLine: { value: new THREE.Color(0x808080) },
        uAccent: { value: new THREE.Color(PALETTE.hazard) },
        uCamPos: { value: new THREE.Vector3() },
        uSpeed: { value: 0 },
        uScale: { value: WORLD_SCALE },
      }]),
      vertexShader: vert, fragmentShader: frag, fog: true, side: THREE.DoubleSide,
    });
    this.material.uniforms.uCurve = CURVE;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);
  }
  update(camera, origin, speed = 0) {
    this.material.uniforms.uSpeed.value = speed;
    // disk centered exactly under the camera (densest rings right below you)
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    const u = this.material.uniforms;
    const mx = ((origin.x % 10000) + 10000) % 10000, mz = ((origin.z % 10000) + 10000) % 10000;
    u.uOriginMod.value.set(mx, mz);
    u.uTileOffset.value.set((origin.x - mx) / 250, (origin.z - mz) / 250);
    u.uOrigin.value.set(origin.x, origin.z);
    u.uCamPos.value.copy(camera.position);
  }
}
