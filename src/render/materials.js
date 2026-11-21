// "Experimental lab" look: pale faceted surfaces, topographic contour lines,
// ink-black edge outlines, all fogged consistently with scene.fog.
import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { CURVE, CURVE_GLSL } from './curvature.js';

export const SUN_DIR = new THREE.Vector3(0.45, 0.78, 0.32).normalize();

const labVertex = /* glsl */`
  #include <fog_pars_vertex>
  ${CURVE_GLSL}
  attribute vec3 color;
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    #ifdef USE_VCOLOR
      vColor = color;
    #else
      vColor = vec3(1.0);
    #endif
    vec4 mvPosition = viewMatrix * curveWorld(wp);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const labFragment = /* glsl */`
  #include <fog_pars_fragment>
  uniform vec3 uColor;
  uniform vec3 uEmissive;
  uniform vec3 uSun;
  uniform float uContour;
  uniform float uContourStep;
  uniform float uFlash;
  uniform float uLift;      // additive light on lit faces: lets near-black surfaces still read as 3D
  varying vec3 vColor;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 base = uColor * vColor;
    float diff = max(dot(n, uSun), 0.0);
    float hemi = 0.5 + 0.5 * n.y;
    vec3 col = base * (0.50 + 0.18 * hemi + 0.42 * diff);
    // neutral studio lighting: shadows go gray, never tinted
    col *= mix(vec3(0.93), vec3(1.0), diff);
    // topographic contour lines
    if (uContour > 0.0) {
      float y = vWorld.y / uContourStep;
      float w = fwidth(y);
      float d = abs(fract(y + 0.5) - 0.5); // distance to nearest contour
      float line = 1.0 - smoothstep(0.0, 1.5 * w, d);
      line *= 1.0 - smoothstep(0.08, 0.5, w); // fade when too dense
      col = mix(col, col * 0.72, line * uContour);
    }
    col += uLift * diff + uEmissive + uFlash;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

export function labMaterial({ color = 0xffffff, emissive = 0x000000, vertexColors = false, contour = 1, contourStep = 16, side = THREE.FrontSide, lift = 0 } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uColor: { value: new THREE.Color(color) },
        uEmissive: { value: new THREE.Color(emissive) },
        uSun: { value: SUN_DIR.clone() },
        uContour: { value: contour },
        uContourStep: { value: contourStep },
        uFlash: { value: 0 },
        uLift: { value: lift },
      },
    ]),
    vertexShader: labVertex,
    fragmentShader: labFragment,
    fog: true,
    side,
    defines: vertexColors ? { USE_VCOLOR: '' } : {},
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  m.uniforms.uCurve = CURVE; // shared, live planet curvature (merge() would have cloned it)
  return m;
}

export function edgeMaterial(color = PALETTE.ink, opacity = 0.85) {
  return new THREE.LineBasicMaterial({ color, fog: true, transparent: opacity < 1, opacity });
}

/** Build a lab-style mesh (+ edge outline) from any geometry. */
export function labMesh(geometry, { color, emissive, edgeColor = PALETTE.ink, threshold = 20, contour = 0 } = {}) {
  const group = new THREE.Group();
  const mat = labMaterial({ color, emissive, contour });
  const mesh = new THREE.Mesh(geometry, mat);
  group.add(mesh);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, threshold), edgeMaterial(edgeColor, 1));
  group.add(edges);
  group.userData.material = mat;
  return group;
}

/**
 * Silhouette outline ("inverted hull"): renders BACK faces pushed outward
 * along smoothed normals by a constant number of screen pixels. Front faces
 * of the real mesh hide everything except a clean rim at the silhouette, so
 * only the outer border is drawn, never the facet edges inside.
 * Needs an `aSmooth` attribute (see ChunkBuilder).
 */
export function outlineMaterial(color = 0xffffff, widthPx = 2) {
  const om = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: widthPx },
      uRes: { value: new THREE.Vector2(1920, 1080) },
    }]),
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      ${CURVE_GLSL}
      attribute vec3 aSmooth;
      uniform float uWidth;
      uniform vec2 uRes;
      void main() {
        vec4 wp = curveWorld(modelMatrix * vec4(position, 1.0));
        vec4 mvPosition = viewMatrix * wp;
        vec4 clip = projectionMatrix * mvPosition;
        vec3 vn = normalize(mat3(viewMatrix) * normalize(mat3(modelMatrix) * aSmooth));
        vec2 sdir = (projectionMatrix * vec4(vn, 0.0)).xy;
        float l = length(sdir);
        // thinner with distance so far, tiny rocks don't turn into rim-colored dots
        float w = uWidth * mix(1.0, 0.45, smoothstep(3000.0, 40000.0, -mvPosition.z));
        if (l > 1e-5) clip.xy += (sdir / l) * w * 2.0 / uRes * clip.w;
        gl_Position = clip;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <fog_fragment>
      }`,
    side: THREE.BackSide,
    fog: true,
  });
  om.uniforms.uCurve = CURVE;
  return om;
}
