// The low cloud deck as REAL geometry: a curved polar disk at the deck
// altitude, cel-shaded with exactly the sky's cloud functions. Alpha-tested
// (crisp toon edges, writes depth), so it hides the ground when you are above
// it and the sky when you are below, and you can punch through it.
import * as THREE from 'three';
import { polarDisk } from './Ground.js';
import { CLOUD_GLSL, LAYERS, SKY_COLORS } from './Sky.js';
import { SUN_DIR } from '../render/materials.js';
import { CURVE_GLSL, curveUniforms } from '../render/curvature.js';
import { TIERS } from '../config.js';

export const DECK_ALTITUDE = LAYERS.low.h * 1000; // m (8 km)

const vert = /* glsl */`
  #include <fog_pars_vertex>
  ${CURVE_GLSL}
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * curveWorld(wp);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const frag = /* glsl */`
  #include <fog_pars_fragment>
  uniform vec2 uOff;        // camera offset in noise units (wrapped to 256)
  uniform float uScale;     // km per noise unit
  uniform float uSpeed01;
  uniform vec2 uFlight;
  uniform vec3 uSun;
  uniform vec3 uShadow;
  uniform vec3 uOutline;
  uniform float uAbove;     // 1 when the camera is above the deck
  varying vec3 vWorld;
  ${CLOUD_GLSL}
  void main() {
    vec2 rel = (vWorld.xz - cameraPosition.xz) / 1000.0 / uScale;
    vec4 c = toonSmear(uOff + rel, 0.62, uSun.xz * 0.22, uSpeed01 * 1.2);
    if (c.a < 0.5) discard;                       // crisp toon edge, depth-correct
    vec3 col = c.rgb;
    col = mix(col, max(col, vec3(0.93, 0.95, 1.0)), uAbove * 0.6); // sunlit tops from above
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

export class Clouds {
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uOff: { value: new THREE.Vector2() },
        uScale: { value: LAYERS.low.scale },
        uSpeed01: { value: 0 },
        uFlight: { value: new THREE.Vector2(0, -1) },
        uSun: { value: SUN_DIR.clone() },
        uShadow: { value: new THREE.Color(SKY_COLORS.shadow) },
        uOutline: { value: new THREE.Color(SKY_COLORS.outline) },
        uAbove: { value: 0 },
      }]),
      vertexShader: vert, fragmentShader: frag, fog: true, side: THREE.DoubleSide,
    });
    curveUniforms(this.material);
    this.mesh = new THREE.Mesh(polarDisk(150000, 56, 96, 200), this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(camera, origin, time, flight, speed = 0) {
    this.mesh.position.set(camera.position.x, DECK_ALTITUDE, camera.position.z);
    const u = this.material.uniforms;
    const kx = (camera.position.x + origin.x) / 1000, kz = (camera.position.z + origin.z) / 1000;
    const wrap = (v) => ((v % 256) + 256) % 256;
    u.uOff.value.set(wrap(kx / LAYERS.low.scale + time * 0.01), wrap(kz / LAYERS.low.scale));
    u.uSpeed01.value = Math.min(1, speed / TIERS[TIERS.length - 1].speed);
    u.uAbove.value = camera.position.y > DECK_ALTITUDE ? 1 : 0;
    if (flight) u.uFlight.value.set(flight.x, flight.z);
  }
}
