// One full-screen pass that does all the "barrier break" screen work:
// shockwave rings (refraction), sine-wave ripple, heat haze, radial speed
// blur with chromatic aberration, negative-color flashes and glitch slices,
// damage vignette, film grain. One pass = one texture read loop, cheap.
// Event juice (see Juice.js): vortex refraction, flood-to-white, and inversion
// masks (hollow ring, beam, ghost numeral) that stay inside the ink/white palette.
import * as THREE from 'three';

const MAX_WAVES = 4;

const vert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const frag = /* glsl */`
  uniform sampler2D tScene;
  uniform vec2 uRes;
  uniform float uTime;
  uniform vec4 uWaves[${MAX_WAVES}];   // xy center, z age (s), w strength (signed)
  uniform float uNegative;   // 0..1
  uniform float uGlitch;     // 0..1
  uniform float uRipple;     // sine wobble amplitude
  uniform float uAberration;
  uniform float uBlur;       // radial blur 0..1
  uniform float uHaze;       // heat haze at edges 0..1 (barrier charge)
  uniform float uDamage;     // red vignette 0..1
  uniform float uVignette;
  uniform float uDesat;
  uniform float uCone;       // vapor cone ring 0..1
  uniform vec2 uCenter;      // the jet on screen (uv): event effects radiate from here
  uniform vec2 uSwirl;       // x radius (screen heights), y refraction strength
  uniform float uFlood;      // wash toward paper-white, edges first
  uniform float uWhite;      // full white frame (the cut)
  uniform vec2 uRing;        // x radius (screen heights), y strength: hollow inverting ring
  uniform vec2 uBeam;        // x vertical beam, y horizontal hairline (inverting)
  uniform float uGhost;      // giant ghost numeral (inverting)
  uniform sampler2D tGhost;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec2 uv = vUv;
    vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
    vec2 c = (uv - 0.5) * aspect;
    float rc = length(c);
    vec2 jc = (vUv - uCenter) * aspect;   // around the jet
    float rj = length(jc);

    // shockwave rings: refract outward along the ring front
    for (int i = 0; i < ${MAX_WAVES}; i++) {
      vec4 w = uWaves[i];
      if (w.w == 0.0) continue;
      vec2 dv = (uv - w.xy) * aspect;
      float d = length(dv);
      float radius = w.z * 1.9;
      float life = clamp(1.0 - w.z / 1.1, 0.0, 1.0);
      float front = d - radius;
      float ring = exp(-front * front * 90.0) * life * smoothstep(0.08, 0.15, d); // calm eye: the jet stays crisp
      uv -= normalize(dv + 1e-5) / aspect * ring * w.w * 0.09;
    }
    // vortex (barrier break): tangential refraction in a donut growing from the jet
    if (uSwirl.y > 0.0) {
      vec2 d = (uv - uCenter) * aspect;
      float r = length(d);
      float x = r / max(uSwirl.x, 1e-4);
      float donut = smoothstep(0.0, 0.35, x) * (1.0 - smoothstep(0.55, 1.0, x)) * smoothstep(0.1, 0.18, r); // the jet sits in a calm eye (half-span ~0.09)
      vec2 dir = d / max(r, 1e-5);
      float lobes = sin(atan(d.y, d.x) * 3.0 + uTime * 6.0 - r * 18.0);
      vec2 off = (vec2(-dir.y, dir.x) * (0.8 + 0.4 * lobes) + dir * 0.35 * lobes) * donut * uSwirl.y;
      uv += off / aspect;
    }
    // sine ripple (the "wave" after a barrier break)
    uv.x += sin(uv.y * 38.0 + uTime * 24.0) * uRipple;
    uv.y += cos(uv.x * 31.0 - uTime * 19.0) * uRipple * 0.6;
    // heat haze, strongest near the edges, grows with barrier charge
    float edge = smoothstep(0.25, 0.75, rc);
    uv += vec2(sin(uv.y * 90.0 + uTime * 40.0), cos(uv.x * 80.0 + uTime * 35.0)) * 0.0018 * uHaze * edge;

    // glitch: displaced horizontal slices
    float slice = floor(uv.y * 24.0 + floor(uTime * 30.0) * 7.0);
    float gx = (hash(vec2(slice, floor(uTime * 30.0))) - 0.5) * 0.08 * uGlitch;
    float gOn = step(1.0 - uGlitch * 0.6, hash(vec2(slice * 1.7, floor(uTime * 24.0))));
    uv.x += gx * gOn;

    // radial blur + chromatic aberration in one loop
    vec2 dir = uv - 0.5;
    float blur = uBlur * smoothstep(0.08, 0.6, rc);
    float ab = uAberration; // event-only (tier breaks, hits): no constant color fringing on the white world
    vec3 col = vec3(0.0);
    const int N = 8;
    for (int i = 0; i < N; i++) {
      float t = float(i) / float(N - 1);
      float s = 1.0 - blur * 0.09 * t;
      vec2 suv = 0.5 + dir * s;
      col.r += texture2D(tScene, 0.5 + (suv - 0.5) * (1.0 + ab)).r;
      col.g += texture2D(tScene, suv).g;
      col.b += texture2D(tScene, 0.5 + (suv - 0.5) * (1.0 - ab)).b;
    }
    col /= float(N);

    // vapor cone: bright ring of condensation as you approach a barrier
    float cone = smoothstep(0.42, 0.55, rc) * (1.0 - smoothstep(0.55, 0.9, rc));
    float streak = 0.6 + 0.4 * sin(atan(c.y, c.x) * 40.0 + uTime * 6.0);
    col = mix(col, vec3(1.0), cone * uCone * 0.55 * streak);

    // desaturation (tier loss)
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l), uDesat);

    // negative color disturbance: full inversion + per-slice partial inversions
    float neg = uNegative;
    float bandNeg = step(0.7, hash(vec2(floor(vUv.y * 16.0), floor(uTime * 20.0)))) * uGlitch;
    col = mix(col, 1.0 - col, clamp(neg + bandNeg * 0.9, 0.0, 1.0));
    // channel swap flicker during glitches
    if (gOn > 0.5 && uGlitch > 0.3) col = col.brg;

    // flood toward paper-white before the cut; the jet and the line ahead stay clear
    col = mix(col, vec3(1.0), uFlood * smoothstep(0.08, 0.55, min(rc, rj)));
    // inversion masks: ink on the white world, white on rocks; never a new color
    float inv = 0.0;
    if (uRing.y > 0.0) {   // hollow ring: Ripple2's clear eye and hard rim; ramp cubed because a
      float x = rj / max(uRing.x, 1e-4);   // half-inverted pixel reads as gray mud, not as glow
      float r = clamp((x - 0.27) / 0.73, 0.0, 1.0);
      inv += r * r * r * step(x, 1.0) * uRing.y;
    }
    if (uBeam.x + uBeam.y > 0.0) {
      float across = 1.0 - min(1.0, abs(jc.x) / 0.05);
      float along = 1.0 - smoothstep(0.25, 0.5, abs(jc.y));
      inv += (pow(across, 8.0) + across * across * 0.35) * along * uBeam.x;
      inv += exp(-jc.y * jc.y * 6000.0) * (1.0 - smoothstep(0.2, 0.8, abs(jc.x))) * uBeam.y;
    }
    if (uGhost > 0.0) {    // ghost canvas spans 1.6 x 0.8 screen heights around the center
      vec2 g = c / vec2(1.6, 0.8) + 0.5;
      if (g.x > 0.0 && g.x < 1.0 && g.y > 0.0 && g.y < 1.0) inv += texture2D(tGhost, g).a * uGhost;
    }
    col = mix(col, 1.0 - col, clamp(inv, 0.0, 1.0));
    col = mix(col, vec3(1.0), uWhite);

    // damage: red pulse from edges
    col = mix(col, vec3(1.0, 0.1, 0.15), uDamage * smoothstep(0.3, 0.85, rc) * 0.8);
    // vignette + grain
    col *= 1.0 - uVignette * smoothstep(0.45, 1.05, rc);
    col += (hash(vUv * uRes + uTime) - 0.5) * 0.012;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, type: THREE.HalfFloatType });
    this.waves = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4(0.5, 0.5, 0, 0));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.target.texture },
        uRes: { value: size.clone() },
        uTime: { value: 0 },
        uWaves: { value: this.waves },
        uNegative: { value: 0 }, uGlitch: { value: 0 }, uRipple: { value: 0 }, uAberration: { value: 0 },
        uBlur: { value: 0 }, uHaze: { value: 0 }, uDamage: { value: 0 }, uVignette: { value: 0.35 },
        uDesat: { value: 0 }, uCone: { value: 0 },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uSwirl: { value: new THREE.Vector2() }, uFlood: { value: 0 }, uWhite: { value: 0 },
        uRing: { value: new THREE.Vector2() }, uBeam: { value: new THREE.Vector2() },
        uGhost: { value: 0 }, tGhost: { value: null },
      },
      vertexShader: vert, fragmentShader: frag, depthTest: false, depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(tri, this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.nextWave = 0;
    // ghost numeral: drawn once per event into a small canvas, sampled as an inversion mask
    this.ghostCanvas = document.createElement('canvas');
    this.ghostCanvas.width = 1024; this.ghostCanvas.height = 512;
    this.ghostTex = new THREE.CanvasTexture(this.ghostCanvas);
    this.u.tGhost.value = this.ghostTex;
  }
  setGhost(text) {
    const g = this.ghostCanvas.getContext('2d');
    g.clearRect(0, 0, 1024, 512);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${text.length > 3 ? 300 : 420}px "JetBrains Mono", monospace`;
    g.fillText(text, 512, 270);
    this.ghostTex.needsUpdate = true;
  }
  get u() { return this.material.uniforms; }
  setSize(w, h) {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target.setSize(size.x, size.y);
    this.u.uRes.value.copy(size);
  }
  /** strength > 0 pushes outward, < 0 implodes */
  wave(x = 0.5, y = 0.5, strength = 1) {
    const w = this.waves[this.nextWave++ % MAX_WAVES];
    w.set(x, y, 0, strength);
  }
  update(dt) {
    for (const w of this.waves) if (w.w !== 0) { w.z += dt; if (w.z > 1.2) w.w = 0; }
  }
  render(scene, camera, time) {
    this.u.uTime.value = time;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}
