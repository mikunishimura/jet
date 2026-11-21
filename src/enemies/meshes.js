// Enemy airframes, built from primitives in the lab style: charcoal bodies,
// red signal outlines and lights.
import * as THREE from 'three';
import { labMaterial, edgeMaterial } from '../render/materials.js';
import { PALETTE } from '../config.js';

const bodyMat = () => labMaterial({ color: 0x33363d, contour: 0 });
const redEdge = () => edgeMaterial(PALETTE.enemy, 1);
const glow = (c = PALETTE.enemy) => new THREE.MeshBasicMaterial({ color: c, fog: true });

function part(group, geo, mat, edges = true, threshold = 25) {
  const m = new THREE.Mesh(geo, mat);
  group.add(m);
  if (edges) group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, threshold), redEdge()));
  return m;
}

export function ufoMesh() {
  const g = new THREE.Group();
  const prof = [[0, -2.6], [6, -2.2], [15, -0.4], [17, 0], [15, 0.6], [7, 2.2], [0, 2.6]].map(([x, y]) => new THREE.Vector2(x, y));
  part(g, new THREE.LatheGeometry(prof, 18), bodyMat(), true, 15);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(5.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.85, fog: true }));
  dome.position.y = 2.2; g.add(dome);
  const lights = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const l = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 1.4), glow(i % 3 ? PALETTE.enemy : 0xffffff));
    l.position.set(Math.cos(a) * 15.6, 0.1, Math.sin(a) * 15.6);
    lights.add(l);
  }
  g.add(lights);
  g.userData.spin = lights;
  const under = new THREE.Mesh(new THREE.CircleGeometry(4, 16), glow(0xff3b30));
  under.rotation.x = Math.PI / 2; under.position.y = -2.65; g.add(under);
  return g;
}

export function droneMesh() {
  const g = new THREE.Group();
  part(g, new THREE.OctahedronGeometry(2.6, 0).scale(1.3, 0.6, 1.6), bodyMat());
  const rotors = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 4.2), bodyMat());
    arm.position.set(x * 1.6, 0, z * 1.6); arm.rotation.y = Math.atan2(x, z);
    g.add(arm);
    const rotor = new THREE.Mesh(new THREE.CircleGeometry(1.7, 10), new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.45, side: THREE.DoubleSide, fog: true }));
    rotor.rotation.x = -Math.PI / 2; rotor.position.set(x * 3, 0.4, z * 3);
    g.add(rotor); rotors.push(rotor);
  }
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), glow(0xffffff));
  eye.position.set(0, 0, -3.8); g.add(eye);
  g.userData.rotors = rotors;
  g.scale.setScalar(1.5);
  return g;
}

export function fighterMesh() {
  const g = new THREE.Group();
  const fus = new THREE.ConeGeometry(1.6, 16, 6, 1); fus.rotateX(-Math.PI / 2);
  part(g, fus, bodyMat());
  const wing = new THREE.BufferGeometry();
  wing.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, -3, -9, 0, 5, 9, 0, 5,
    0, 0, -3, 9, 0, 5, -9, 0, 5,
  ]), 3));
  wing.computeVertexNormals();
  part(g, wing, bodyMat(), true, 1);
  const fin = new THREE.BufferGeometry();
  fin.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 3, 0, 4.5, 7, 0, 0, 7.5, 0, 0, 3, 0, 0, 7.5, 0, 4.5, 7,
  ]), 3));
  fin.computeVertexNormals();
  part(g, fin, bodyMat(), true, 1);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(18.2, 0.2, 1.2), glow());
  stripe.position.set(0, 0.05, 4.3); g.add(stripe);
  const burner = new THREE.Mesh(new THREE.ConeGeometry(1.1, 6, 8, 1, true).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.85, fog: true, depthWrite: false }));
  burner.position.set(0, 0, 10.5); g.add(burner);
  g.userData.burner = burner;
  g.scale.setScalar(1.25);
  return g;
}
