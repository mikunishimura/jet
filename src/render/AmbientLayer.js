// The always-on background layer (Beat Stomper's ambient motion, for a velocity
// game): beat wave on the floor, km numerals on the ground,
// live Mach number in the sky, sky drifting toward space, a megastructure ring
// on the horizon, light shafts, ink dust and dark halos on threats.
// Everything is driven by the AmbientConductor's output and scaled by its gate.
import * as THREE from 'three';
import { AMBIENT, PALETTE, MACH_FACTOR } from '../config.js';
import { SHAPE } from './Particles.js';

function textCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function drawText(canvas, text, px) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${px}px "JetBrains Mono", monospace`;
  g.fillText(text, canvas.width / 2, canvas.height / 2 + px * 0.04);
}

// megastructure: concentric circles + spokes, drawn at the far plane (behind all terrain)
const ringVert = /* glsl */`
  void main() { gl_Position = (projectionMatrix * modelViewMatrix * vec4(position, 1.0)).xyww; }
`;
const ringFrag = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha;
  void main() { gl_FragColor = vec4(uColor, uAlpha); }
`;
function ringGeometry(R, segs) {
  const pts = [];
  const circle = (r) => { for (let i = 0; i < segs; i++) { const a = (i / segs) * Math.PI * 2, b = ((i + 1) / segs) * Math.PI * 2; pts.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(b) * r, Math.sin(b) * r, 0); } };
  circle(R); circle(R * 0.93); circle(R * 0.78);
  for (let i = 0; i < 48; i++) {               // spokes between the two outer bands
    const a = (i / 48) * Math.PI * 2;
    pts.push(Math.cos(a) * R * 0.93, Math.sin(a) * R * 0.93, 0, Math.cos(a) * R, Math.sin(a) * R, 0);
  }
  for (let i = 0; i < 12; i++) {               // long struts to the inner band
    const a = (i / 12) * Math.PI * 2 + 0.13;
    pts.push(Math.cos(a) * R * 0.78, Math.sin(a) * R * 0.78, 0, Math.cos(a) * R * 0.93, Math.sin(a) * R * 0.93, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function haloTexture() {
  const c = textCanvas(64, 64), g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.45, 'rgba(255,255,255,0.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class AmbientLayer {
  constructor(game, cfg = AMBIENT) {
    this.game = game; this.cfg = cfg;
    const scene = game.scene;
    // live Mach number for the sky
    this.machCanvas = textCanvas(1024, 384);
    this.machTex = new THREE.CanvasTexture(this.machCanvas);
    this.lastMach = -1;
    const su = game.sky.material.uniforms;
    su.uMachTex.value = this.machTex;
    su.uSpaceZen.value.set(cfg.space.zenith); su.uStars.value = cfg.space.stars;
    su.uShafts.value.set(cfg.shafts.alpha, cfg.shafts.count);

    // km numerals lying on the floor ahead of you
    this.numerals = [];
    for (let i = 0; i < cfg.numerals.pool; i++) {
      const canvas = textCanvas(512, 256), tex = new THREE.CanvasTexture(canvas);
      const geo = new THREE.PlaneGeometry(cfg.numerals.width, cfg.numerals.width * 0.5); geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: PALETTE.ink, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
      const mesh = new THREE.Mesh(geo, mat); mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 1;
      scene.add(mesh);
      this.numerals.push({ mesh, canvas, tex, km: null, at: 0 });
    }
    this.nextMarker = cfg.numerals.spacing;

    // megastructure ring at "infinity"
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(PALETTE.ink) }, uAlpha: { value: 0 } },
      vertexShader: ringVert, fragmentShader: ringFrag, transparent: true, depthWrite: false,
    });
    this.ring = new THREE.LineSegments(ringGeometry(cfg.ring.radius, cfg.ring.segments), this.ringMat);
    this.ring.frustumCulled = false; this.ring.renderOrder = -1;
    this.ringPivot = new THREE.Object3D(); this.ringPivot.add(this.ring); scene.add(this.ringPivot);
    this.ringDir = new THREE.Vector3(0.55, 0.13, -0.82).normalize(); // fixed world bearing, low over the horizon

    // dark halos on threats
    const htex = haloTexture();
    this.halos = [];
    for (let i = 0; i < cfg.halos.max; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: htex, color: 0xffffff, blending: THREE.SubtractiveBlending, premultipliedAlpha: true, transparent: true, depthWrite: false }));
      s.visible = false; scene.add(s); this.halos.push(s);
    }
    this.dustAcc = 0;
    this._v = new THREE.Vector3();
  }

  reset() {
    for (const n of this.numerals) { n.mesh.visible = false; n.km = null; }
    this.nextMarker = this.cfg.numerals.spacing;
    this.lastMach = -1;
  }

  rebase(dx, dz) { for (const n of this.numerals) { n.mesh.position.x -= dx; n.mesh.position.z -= dz; } }

  /** dt: game time; amb: AmbientConductor output */
  update(dt, amb) {
    const g = this.game, cfg = this.cfg, p = g.player, s = p.speedSys, cam = g.camera;
    const gate = amb.gate;
    // --- sky + floor uniforms
    const su = g.sky.material.uniforms;
    su.uAmb.value = gate; su.uSpace.value = amb.space; su.uBeat.value = amb.pulse;
    const gu = g.ground.material.uniforms;
    gu.uPulse.value.set(amb.pulse * gate, amb.phase * cfg.pulse.far);
    // live Mach number in the sky (redrawn only when the integer changes)
    const mach = Math.round(s.speed * MACH_FACTOR);
    if (mach !== this.lastMach) { this.lastMach = mach; drawText(this.machCanvas, `M${mach}`, 300); this.machTex.needsUpdate = true; }
    su.uMachA.value = cfg.machGhost.alpha * (s.engaged ? 1 : 0);

    // --- km numerals on the floor, placed ahead along your heading
    const N = cfg.numerals;
    if (s.engaged && p.alive && p.traveled + N.ahead >= this.nextMarker) {
      const slot = this.numerals.reduce((a, b) => (a.at <= b.at ? a : b));
      const along = this.nextMarker - p.traveled;
      slot.mesh.position.set(p.pos.x + p.flatForward.x * along, 0.6, p.pos.z + p.flatForward.z * along);
      slot.mesh.rotation.y = p.heading;
      slot.km = Math.round(this.nextMarker / 1000);
      slot.at = this.nextMarker;
      drawText(slot.canvas, `${slot.km} KM`, 150); slot.tex.needsUpdate = true;
      slot.mesh.visible = true;
      this.nextMarker += N.spacing;
    }
    for (const n of this.numerals) n.mesh.material.opacity = N.alpha * gate;

    // --- megastructure: far, slowly turning, closer as you climb tiers
    const R = cfg.ring;
    const dist = R.dist[0] + (R.dist[1] - R.dist[0]) * amb.space;
    this.ringPivot.position.copy(cam.position).addScaledVector(this.ringDir, dist);
    this.ringPivot.lookAt(cam.position);
    this.ring.rotation.z += R.spin * dt;
    this.ring.rotation.x = 0.55 + 0.04 * Math.sin(g.time * 0.21);
    this.ringMat.uniforms.uAlpha.value = R.alpha * gate * (0.55 + 0.45 * amb.space);

    // --- ink dust: still air you rush through (world-fixed squares near your path)
    if (s.engaged && p.alive) {
      this.dustAcc += cfg.dust.rate * gate * dt;
      const sp = Math.max(400, s.speed);
      while (this.dustAcc >= 1) {
        this.dustAcc -= 1;
        const ahead = sp * (0.15 + Math.random() * 0.45), side = (Math.random() - 0.5) * (300 + sp * 0.06), up = (Math.random() - 0.5) * (160 + sp * 0.02);
        g.particles.normal.emit({
          x: p.pos.x + p.flatForward.x * ahead + p.right.x * side, y: Math.max(8, p.pos.y + up), z: p.pos.z + p.flatForward.z * ahead + p.right.z * side,
          rel: false, vx: 0, vy: 0, vz: 0, life: cfg.dust.life, size: 2 + Math.random() * 1.5, color: PALETTE.inkSoft, shape: SHAPE.SQUARE, drag: 0,
        });
      }
    }

    // --- dark halos (enemies: off by default; incoming missiles: faint), swelling on the beat
    const H = cfg.halos;
    let k = 0;
    const beat = 0.75 + 0.25 * amb.pulse / Math.max(1e-6, cfg.pulse.amp);
    const place = (pos, base, amount) => {
      const strength = amount * gate * beat;
      if (k >= this.halos.length || strength <= 0.005) return;
      const d = pos.distanceTo(cam.position);
      if (d > H.range) return;
      const h = this.halos[k++];
      h.position.copy(pos);
      h.scale.setScalar(Math.max(base, d * H.size) * (1 + 0.2 * amb.pulse / Math.max(1e-6, cfg.pulse.amp)));
      h.material.color.setScalar(strength);
      h.visible = true;
    };
    if (H.enemies > 0) for (const e of g.enemies.list) if (e.alive) place(e.pos, e.radius * 5, H.enemies);
    for (const m of g.projectiles.missiles) if (m.owner === 'enemy') place(m.p, 20, H.missiles);
    for (; k < this.halos.length; k++) this.halos[k].visible = false;
  }
}
