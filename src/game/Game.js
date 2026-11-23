// Orchestrates systems, the frame loop, game state, director, scoring.
import * as THREE from 'three';
import { TIERS, WORLD, DIRECTOR, PALETTE, MACH_FACTOR, FLIGHT, ALTITUDE, WORLD_SCALE, JUICE, NEAR_MISS, AIM, FOV, AMBIENT, FLAGS, SPACE, HOSTILE, BREAKER } from '../config.js';
import { captureAltitude } from './hostile.js';
import { LineWatch } from './LineWatch.js';
import { resolveFlag } from '../core/flags.js';
import { Space } from '../space/Space.js';
import { Settings } from '../core/Settings.js';
import { TouchControls } from '../ui/TouchControls.js';
import { SettingsPanel } from '../ui/SettingsPanel.js';

const AIM_BASE_SENSITIVITY = AIM.sensitivity; // settings scale this
import { isMilestone } from '../render/Juice.js';
import { AmbientConductor } from '../render/Ambient.js';
import { AmbientLayer } from '../render/AmbientLayer.js';
import { Input } from '../core/input.js';
import { World } from '../world/World.js';
import { PathHazards } from '../world/PathHazards.js';
import { Ground } from '../world/Ground.js';
import { Sky } from '../world/Sky.js';
import { Clouds, DECK_ALTITUDE } from '../world/Clouds.js';
import { patchTree, updateCurvature } from '../render/curvature.js';
import { PostFX } from '../render/PostFX.js';
import { FXDirector } from '../render/FXDirector.js';
import { CameraRig } from '../render/CameraRig.js';
import { Cockpit } from '../render/Cockpit.js';
import { JetModel } from '../render/JetModel.js';
import { SpeedLines } from '../render/SpeedLines.js';
import { Particles, explosion, SHAPE } from '../render/Particles.js';
import { VectorFX } from '../render/VectorFX.js';
import { Player } from './Player.js';
import { Projectiles } from '../combat/Projectiles.js';
import { Weapons } from '../combat/Weapons.js';
import { Countermeasures } from '../combat/Countermeasures.js';
import { EnemyManager } from '../enemies/Enemies.js';
import { ufoMesh, droneMesh, fighterMesh } from '../enemies/meshes.js';
import { Pickups } from '../pickups/Pickups.js';
import { HUD, fmtTime, fmtKm } from '../ui/HUD.js';
import { Audio } from '../audio/Audio.js';
import { Autopilot } from './Autopilot.js';
import { Aim } from './Aim.js';

const BEST_KEY = 'jetlab.best.v1';
const lerp = (a, b, t) => a + (b - a) * t;

export class Game {
  constructor(container) {
    THREE.ColorManagement.enabled = false;
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.setSize(innerWidth, innerHeight);
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(PALETTE.fog, WORLD.fogDensityBase);
    this.camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 1, 140000);
    this.scene.add(this.camera);

    this.input = new Input();
    this.audio = new Audio();
    this.world = new World(this.scene, 1);
    this.syncOutline();
    this.hazards = new PathHazards(this.world);
    this.ground = new Ground(this.scene);
    this.sky = new Sky(this.scene);
    this.clouds = new Clouds(this.scene);
    this.post = new PostFX(renderer);
    this.fx = new FXDirector(this.post);
    this.rig = new CameraRig(this.camera);
    this.cockpit = new Cockpit(this.camera);
    this.jet = new JetModel(this.scene);
    this.speedLines = new SpeedLines(this.camera);
    // one glyph system (hard shapes, stepped fade) + vector shells/rings; `add` kept as an alias
    const glyphs = new Particles(this.scene, 7000);
    this.particles = { normal: glyphs, add: glyphs, vector: new VectorFX(this.scene, this.camera) };
    // always-on background layer (Beat Stomper-style ambient motion)
    this.ambientConductor = new AmbientConductor();
    this.ambientBands = new Float32Array(AMBIENT.eq.bands);
    this.ambient = new AmbientLayer(this);
    this.player = new Player((type, e) => this.onPlayerEvent(type, e));
    this.aim = new Aim();
    // mouse aim: capture the pointer when the player clicks into the game
    renderer.domElement.addEventListener('mousedown', () => { if (this.state === 'playing') this.input.requestLock(renderer.domElement); });
    this.projectiles = new Projectiles(this);
    this.weapons = new Weapons(this);
    this.counter = new Countermeasures(this); // incoming-missile warning + flares
    this.enemies = new EnemyManager(this);
    this.pickups = new Pickups(this);
    this.hud = new HUD(this);
    // player settings: applied live, persisted; the panel doubles as the pause screen
    this.settings = new Settings();
    this.space = null;          // space flight (FLAGS.space): created / disposed by syncFlags
    this.flagsPending = false;
    this.paused = false;
    this.settingsPanel = new SettingsPanel(this.settings, { onClose: () => this.closeSettings() });
    this.settings.onChange(() => this.applySettings());
    this.applySettings();
    // Esc releases the pointer lock mid-flight -> pause with the settings window
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'playing' && this.player.alive && !this.settingsPanel.isOpen) this.openSettings();
    });
    this.autopilot = new Autopilot(this);
    // phones / tablets: two virtual sticks (fly + aim); the jet shoots by itself
    this.touch = new TouchControls({ onPause: () => this.toggleSettings() });
    this.input.touch = this.touch;

    this.best = this.loadBest();
    this.state = 'menu';
    this.attract = true;
    this.useAutopilot = new URLSearchParams(location.search).has('autopilot');
    this.god = new URLSearchParams(location.search).has('god');
    this.time = 0; this.frame = 0;
    this.perf = { fps: 0, frames: 0, acc: 0, worst: 0 };
    this.reset(Math.floor(Math.random() * 1e9));

    addEventListener('resize', () => this.resize());
    this.last = performance.now();
    renderer.info.autoReset = false;
    this.debug = this.makeDebug();
    this.warmup();
    renderer.setAnimationLoop(() => this.loop());
  }

  /**
   * Compile every shader variant up front: first-use program compiles cost
   * 100-300 ms and would otherwise hitch the first enemy wave / missile.
   */
  warmup() {
    const tmp = [ufoMesh(), droneMesh(), fighterMesh()];
    const p = this.player;
    const m = this.projectiles.missile('player', p.pos.clone(), p.forward.clone(), null, { life: 0, relSpeed: 1, accel: 0, turnRate: 0, prox: 0, damage: 0, splash: 0, armDelay: 0 });
    const e = this.projectiles.missile('enemy', p.pos.clone(), p.forward.clone(), null, { life: 0, relSpeed: 1, accel: 0, turnRate: 0, prox: 0, damage: 0, splash: 0, armDelay: 0 });
    this.projectiles.orb(p.pos.clone(), p.forward.clone(), 0);
    const pk = this.pickups.spawn('repair');
    tmp.forEach((t, i) => { t.position.set(p.pos.x + i * 20, p.pos.y, p.pos.z - 60); this.scene.add(t); });
    const orbit = this.space?.warmupObject(p.pos);
    if (orbit) this.scene.add(orbit);
    const breaker = this.hazards.warmupBreaker(p.pos);
    this.scene.add(breaker);
    patchTree(this.scene); // planet curvature on built-in materials before they compile
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setRenderTarget(this.post.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    tmp.forEach((t) => this.scene.remove(t));
    if (orbit) this.scene.remove(orbit);
    this.scene.remove(breaker);
    this.projectiles.reset();
    this.pickups.reset();
    void m; void e; void pk;
  }

  toggleCamera() {
    const mode = this.rig.mode === 'chase' ? 'cockpit' : 'chase';
    this.settings.set('view.camera', mode); // applySettings switches the rig
    if (this.state === 'playing') this.hud.toast(mode === 'chase' ? 'CHASE CAMERA' : 'COCKPIT CAMERA');
  }

  /** push every setting into the systems that use it (cheap; runs on each change) */
  applySettings() {
    const v = this.settings.values;
    this.audio.setLevels(v.audio);
    AIM.sensitivity = AIM_BASE_SENSITIVITY * v.controls.sensitivity;
    AIM.invertY = v.controls.invertY;
    AIM.autoAim = v.controls.autoAim;
    AIM.autoFire = v.controls.autoFire;
    this.input.autoThrottle = v.controls.autoThrottle;
    AIM.assistCone = v.controls.autoAim ? AIM.autoCone : AIM.manualCone;
    AIM.recenterDelay = v.controls.autoRecenter ? v.controls.recenterDelay : Infinity;
    if (this.rig.mode !== v.view.camera) this.rig.setMode(v.view.camera);
    if (this.jet.skinId !== v.view.skin) this.jet.setSkin(v.view.skin);
    FOV.userOffset = v.view.fovOffset;
    const pr = Math.min(devicePixelRatio || 1, 1.5) * v.view.renderScale;
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 1e-3) { this.renderer.setPixelRatio(pr); this.resize(); }
    Object.assign(this.fx.prefs, v.fx);
    this.hud.showFps = v.view.showFps;
    this.syncFlags();
  }

  /**
   * Latch feature flags (URL > setting > default) into FLAGS and build / tear
   * down what they gate. A change that would teleport you (space off while
   * you are above the earth ceiling) waits until you are back below it.
   */
  syncFlags(force = false) {
    const want = resolveFlag('space', { setting: this.settings.get('flags.space') });
    if (want === FLAGS.space && want === !!this.space) { this.flagsPending = false; return; }
    const live = this.state === 'playing' && !this.attract;
    if (!force && !want && this.player.pos.y > FLIGHT.earthCeiling) {
      if (!this.flagsPending && live) this.hud.toast(`SPACE FLIGHT OFF · BELOW ${FLIGHT.earthCeiling / 1000} KM`, 'info');
      this.flagsPending = true;
      return;
    }
    this.flagsPending = false;
    FLAGS.space = want;
    if (want && !this.space) this.space = new Space(this);
    if (!want && this.space) { this.space.dispose(); this.space = null; }
    if (live && !force) this.hud.toast(want ? 'SPACE FLIGHT ON · CLIMB INTO ORBIT' : 'SPACE FLIGHT OFF', 'info');
    const note = document.getElementById('ceiling-note');
    if (note) note.textContent = want ? `past the clouds into orbit (${SPACE.ceiling / 1000} km)` : `past the clouds to the ${FLIGHT.earthCeiling / 1000} km ceiling`;
  }

  openSettings() {
    if (this.settingsPanel.isOpen) return;
    this.paused = this.state === 'playing' && this.player.alive;
    this.settingsPanel.open(this.paused);
    this.input.releaseLock();
  }
  closeSettings() {
    this.settingsPanel.close();
    if (this.paused) {
      this.paused = false;
      this.last = performance.now();
      this.input.requestLock(this.renderer.domElement); // the click / key that closed it is a user gesture
    }
  }
  toggleSettings() { if (this.settingsPanel.isOpen) this.closeSettings(); else this.openSettings(); }

  loadBest() { try { return JSON.parse(localStorage.getItem(BEST_KEY)) || {}; } catch { return {}; } }
  saveBest() { try { localStorage.setItem(BEST_KEY, JSON.stringify(this.best)); } catch { /* private mode */ } }

  reset(seed) {
    this.seed = seed;
    this.syncFlags(true); // a new flight always lands pending flag changes
    this.world.reset(seed);
    this.hazards.reset();
    this.lineWatch = new LineWatch();
    this.difficulty = 0;
    this.player.reset();
    this.ambient?.reset();
    this.aim?.reset();
    this.player.invincible = this.attract;
    this.projectiles.reset();
    this.enemies.reset();
    this.pickups.reset();
    this.weapons.reset();
    this.counter.reset();
    this.particles.normal.clear(); this.particles.vector.clear();
    this.autopilot = new Autopilot(this);
    this.stats = { time: 0, fromSpawn: 0, kills: 0, killScore: 0, gateScore: 0, gates: 0, nearMisses: 0, missScore: 0, maxTier: 1, milestone: 0 };
    this.lastMiss = -9;
    this.director = { wave: DIRECTOR.firstWave, pickup: 14 };
    this.deathTimer = 0;
    this.lastBand = 'mid';
    this.lastZone = 'clear';
    this.deckSide = -1; // -1 below the cloud deck, +1 above
    this.rig?.reset();
    this.world.prewarm(0, 0, 0, -1, 1);
  }

  start() {
    this.audio.init();
    this.attract = false;
    this.player.invincible = false;
    this.reset(Math.floor(Math.random() * 1e9));
    this.state = 'playing';
    this.input.requestLock(this.renderer.domElement); // still inside the click/keypress activation window
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('death').classList.add('hidden');
    this.hud.show(true);
    this.touch.show(true);
  }

  showMenu() {
    this.input.releaseLock();
    this.state = 'menu';
    this.attract = true;
    this.hud.show(false);
    this.touch.show(false);
    document.getElementById('menu').classList.remove('hidden');
  }

  get score() {
    const s = this.stats;
    return Math.round(s.fromSpawn * 0.1 / WORLD_SCALE + s.time * 5 + s.killScore + s.gateScore + s.missScore);
  }

  /** silhouette rim width is in drawing-buffer pixels */
  syncOutline() {
    const u = this.world.materials.outline.uniforms;
    this.renderer.getDrawingBufferSize(u.uRes.value);
    u.uWidth.value = 1.6 * this.renderer.getPixelRatio();
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.syncOutline();
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.post.setSize(innerWidth, innerHeight);
  }

  // ---------------------------------------------------------------- events
  onPlayerEvent(type, e) {
    const p = this.player;
    if (this.attract && (type === 'damage' || type === 'death')) return;
    switch (type) {
      case 'launch':
        this.audio.launch();
        if (!this.attract) this.hud.toast('ENGINES ENGAGED', 'info');
        break;
      case 'tierUp': {
        const t = TIERS[e.tier - 1];
        this.fx.tierUp(e.tier);
        if (isMilestone(e.tier)) this.audio.boost(e.tier); else this.audio.machPop(e.tier);
        this.hud.slam(`MACH ${(t.speed * MACH_FACTOR).toFixed(1)}`, `${t.roman} · ${t.name}`);
        this.stats.maxTier = Math.max(this.stats.maxTier, e.tier);
        this.vaporRing();
        break;
      }
      case 'tierDown': {
        const t = TIERS[e.tier - 1];
        this.fx.tierDown(e.reason);
        this.audio.tierDown();
        const why = { brake: 'AIRBRAKE', impact: 'TERRAIN IMPACT' }[e.reason] || '';
        this.hud.slam(`TIER ${t.roman}`, why, true);
        break;
      }
      case 'damage':
        this.fx.hurt(e.amount);
        this.audio.hit(e.amount);
        if (e.amount >= 10 && e.source !== 'impact') this.hud.toast(`HIT −${Math.round(e.amount)}`, 'danger');
        break;
      case 'impact': {
        this.fx.impact(e.hard);
        this.audio.impact(e.hard);
        const f = p.forward, pp = p.pos;
        const x = pp.x + f.x * 10, y = pp.y - 1, z = pp.z + f.z * 10;
        // scrape: a few ink glyphs; hard hit: red shell + ring + debris squares
        this.particles.normal.burst(x, y, z, e.hard ? 26 : 6, (bx, by, bz, k) => ({
          x: bx, y: by, z: bz, rel: true,
          vx: (Math.random() - 0.5) * 220, vy: Math.random() * 120, vz: (Math.random() - 0.5) * 220,
          life: 0.35 + Math.random() * 0.3, size: 2 + Math.random() * 2, color: k % 3 ? 0x15171a : 0xff3b30,
          shape: k % 2 ? SHAPE.SQUARE : SHAPE.PLUS, drag: 2.5,
        }));
        if (e.hard) {
          this.hud.toast(`${e.tag === 'mountain' ? 'MOUNTAIN' : 'TERRAIN'} IMPACT −${Math.round(e.damage)}`, 'danger');
          this.particles.vector.shell(x, y, z, 3, 26, 0.4, 0xff3b30);
          this.particles.vector.ring(x, y, z, 4, 44, 0.3, 0x15171a);
        }
        break;
      }
      case 'trigger':
        if (e.type === 'gate' || e.type === 'ring') {
          if (e.material) e.material.uniforms.uPass.value = this.time; // the ring flashes white
          const s = p.speedSys;
          if (s.next) s.charge = Math.min(0.98, s.charge + 0.35);
          this.stats.gateScore += 500;
          this.fx.gate(++this.stats.gates); this.audio.gate();
          // shards: pieces of ink thrown up and out of the gate line
          const f = p.forward, pp = p.pos;
          this.particles.normal.burst(pp.x + f.x * 14, pp.y + 1, pp.z + f.z * 14, JUICE.gate.shards, (bx, by, bz) => ({
            x: bx, y: by, z: bz, rel: true,
            vx: (Math.random() - 0.5) * 260, vy: 60 + Math.random() * 160, vz: (Math.random() - 0.5) * 260,
            life: 0.5 + Math.random() * 0.4, size: 2.5 + Math.random() * 2.5, color: PALETTE.ink, shape: SHAPE.SQUARE, drag: 2.2,
          }));
          if (!this.attract) this.hud.toast(`${e.type === 'ring' ? 'BOOST RING' : 'SURVEY GATE'} +500 · BARRIER +35%`, 'good');
        }
        break;
      case 'nearMiss': {
        // reaction time -> velocity: a close pass charges the barrier, closer = more
        if (this.time - this.lastMiss < NEAR_MISS.cooldown) break;
        this.lastMiss = this.time;
        const s = p.speedSys, [lo, hi] = NEAR_MISS.charge;
        const add = lo + (hi - lo) * e.closeness;
        if (s.next) s.charge = Math.min(0.98, s.charge + add);
        this.stats.nearMisses++;
        this.stats.missScore += Math.round(100 + 300 * e.closeness);
        this.fx.nearMiss(e.closeness); this.audio.nearMiss(e.closeness);
        if (!this.attract) this.hud.toast(`NEAR MISS ${Math.round(e.clearance)} m · BARRIER +${Math.round(add * 100)}%`, 'good');
        break;
      }
      case 'ceiling':
        if (!this.attract) this.hud.toast(FLAGS.space ? `ORBIT CEILING · ${FLIGHT.ceiling / 1000} KM` : `CONTAINMENT CEILING · ${FLIGHT.ceiling} m`, 'warn');
        break;
      case 'death':
        this.audio.death();
        explosion(this.particles, p.pos.x, p.pos.y, p.pos.z, 2.2);
        this.particles.vector.shell(p.pos.x, p.pos.y, p.pos.z, 4, 120, 0.9, 0x15171a, -0.1);
        this.fx.impact(true); this.fx.hurt(40);
        p.vel.multiplyScalar(0.35);
        this.deathTimer = 2.2;
        this.recordRun(e.source);
        break;
    }
  }

  vaporRing() {
    // barrier break: concentric vector rings around the jet + a ring of plus glyphs
    const p = this.player, f = p.forward, r = p.right;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), f);
    const v = this.particles.vector;
    v.ring(p.pos.x, p.pos.y, p.pos.z, 6, 90, 0.45, 0x15171a, 0, q);
    v.ring(p.pos.x, p.pos.y, p.pos.z, 4, 60, 0.55, 0x15171a, -0.07, q);
    v.ring(p.pos.x, p.pos.y, p.pos.z, 2, 34, 0.6, 0xff3b30, -0.14, q);
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const cx = Math.cos(a), cy = Math.sin(a);
      this.particles.normal.emit({ x: p.pos.x + r.x * cx * 8, y: p.pos.y + cy * 8, z: p.pos.z + r.z * cx * 8, rel: true,
        vx: r.x * cx * 160, vy: cy * 160, vz: r.z * cx * 160, life: 0.5, size: 2.6, color: 0x15171a, shape: SHAPE.PLUS, drag: 1.2 });
    }
  }

  onKill(enemy, cause) {
    if (this.attract) return;
    this.stats.kills++;
    const bonus = cause === 'crash' ? 1.5 : 1;
    this.stats.killScore += Math.round(enemy.score * bonus * (1 + 0.25 * (this.player.speedSys.level - 1)));
    this.hud.toast(cause === 'crash' ? `${enemy.name} CRASHED +${Math.round(enemy.score * bonus)}` : `${enemy.name} DOWN +${enemy.score}`, 'good');
  }

  /** any player round / blast that damaged an enemy: the hit has to be felt */
  /** a fresh break turn inside the window: the missile(s) overshot */
  onMissileBeaten(n) {
    if (this.attract) return;
    this.hud.toast(n > 1 ? `BREAK · ${n} MISSILES OVERSHOT` : 'BREAK · MISSILE OVERSHOT', 'good');
    this.audio.nearMiss(0.9);
    this.fx.hit(JUICE.near, 'EVADE'); this.fx.waveAtJet(0.45); this.fx.shake += 0.5;
  }

  /** a loose lock: the target jinked out of the missile's way */
  onEnemyEvaded(e) {
    if (!this.attract) this.hud.toast(`${e.name} DODGED · LOOSE LOCK`, 'warn');
  }

  onEnemyHit(e, amount, source, at, kill) {
    if (this.attract) return;
    this.hud.damageNumber(e, amount, at, kill, source);
    if (source === 'crit') this.audio.critTick();
    if (source === 'gun' || source === 'crit') {
      if (source === 'gun') this.audio.hitTick(Math.min(1, amount / 30));
      const v = this.particles.vector;
      v.ring(at.x, at.y, at.z, 1.5, 11, 0.2, PALETTE.enemy);
      this.particles.normal.burst(at.x, at.y, at.z, 7, (bx, by, bz, k) => ({
        x: bx, y: by, z: bz, rel: true,
        vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.3) * 160, vz: (Math.random() - 0.5) * 160,
        life: 0.25 + Math.random() * 0.15, size: 2.6 + Math.random() * 1.6, color: k % 2 ? PALETTE.enemy : PALETTE.ink,
        shape: k % 2 ? SHAPE.PLUS : SHAPE.SQUARE, drag: 3,
      }));
    }
  }

  damagePlayer(amount, source) {
    if (this.attract || this.god) { if (!this.attract) this.fx.hurt(amount); return; }
    this.player.takeDamage(amount, source);
  }

  recordRun(cause) {
    const s = this.stats, b = this.best;
    const rec = [];
    if (s.time > (b.time || 0)) { b.time = s.time; rec.push('LONGEST FLIGHT'); }
    if (s.fromSpawn > (b.dist || 0)) { b.dist = s.fromSpawn; rec.push('FARTHEST RANGE'); }
    if (this.score > (b.score || 0)) { b.score = this.score; rec.push('HIGH SCORE'); }
    this.saveBest();
    const causeText = { impact: 'TERRAIN COLLISION', missile: 'MISSILE STRIKE', plasma: 'PLASMA BURN', bullet: 'GUNFIRE', ram: 'DRONE RAM' }[cause] || 'AIRFRAME LOST';
    const $ = (id) => document.getElementById(id);
    $('d-cause').textContent = causeText.toLowerCase();
    $('d-time').textContent = fmtTime(s.time);
    $('d-dist').textContent = `${fmtKm(s.fromSpawn)} km`;
    $('d-trav').textContent = `${fmtKm(this.player.traveled)} km`;
    $('d-kills').textContent = s.kills;
    $('d-tier').textContent = TIERS[s.maxTier - 1].roman;
    $('d-score').textContent = this.score.toLocaleString('en-US');
    $('d-records').textContent = rec.length ? `new record · ${rec.join(' · ').toLowerCase()}` : '';
  }

  // ---------------------------------------------------------------- director
  runDirector(dt) {
    if (this.attract || !this.player.alive || !this.player.speedSys.engaged) return;
    const s = this.stats, D = DIRECTOR;
    const diff = Math.min(1, s.time / D.rampTime * 0.65 + s.fromSpawn / D.rampDistance * 0.65);
    this.difficulty = diff;
    const d = this.director;
    // radar: flying high brings waves sooner and more of them; low keeps you hidden
    const band = this.player.band;
    d.wave -= dt / (band === 'high' ? ALTITUDE.waveIntervalHigh : band === 'low' ? ALTITUDE.waveIntervalLow : 1);
    const maxE = Math.round(lerp(D.maxEnemiesStart, D.maxEnemiesEnd, diff)) + (band === 'high' ? ALTITUDE.extraEnemiesHigh : 0);
    if (d.wave <= 0) {
      if (this.enemies.count < maxE) {
        const opts = [['drones', 1.0], ['ufo', s.time > 18 ? 0.7 + diff * 0.3 : 0], ['fighters', s.time > 35 ? 0.5 + diff : 0]];
        let r = Math.random() * opts.reduce((a, o) => a + o[1], 0);
        let kind = 'drones';
        for (const [k, w] of opts) { if ((r -= w) <= 0) { kind = k; break; } }
        this.enemies.spawnWave(kind, diff);
        d.wave = lerp(D.intervalStart, D.intervalEnd, diff) * (0.8 + Math.random() * 0.4);
      } else d.wave = 2;
    }
    d.pickup -= dt;
    if (d.pickup <= 0) {
      const low = this.player.health < 40;
      const [a, b] = low ? D.pickupIntervalLow : D.pickupInterval;
      if (this.pickups.list.length < 2 && this.player.health < 100) {
        if (this.pickups.spawn('repair')) this.hud.toast('REPAIR BEACON DETECTED', 'good');
      }
      d.pickup = a + Math.random() * (b - a);
    }
  }

  /** line breakers: hold one course too long and the world puts a rock on it */
  watchLine(dt) {
    const p = this.player;
    if (this.attract || !p.alive || !p.speedSys.engaged) return;
    const d = this.difficulty || 0;
    const course = this.lineWatch.update(dt, p.heading, p.pitch, lerp(BREAKER.patience[0], BREAKER.patience[1], d));
    if (!course) return;
    const b = this.hazards.spawnBreaker(p, d, course);
    if (b) this.audio.breaker();
  }

  rebaseIfNeeded() {
    const p = this.player;
    if (Math.hypot(p.pos.x, p.pos.z) < WORLD.rebaseDistance) return;
    const dx = p.pos.x, dz = p.pos.z;
    this.world.rebase(dx, dz);
    p.pos.x -= dx; p.pos.z -= dz; p.prevPos.x -= dx; p.prevPos.z -= dz;
    this.enemies.rebase(dx, dz);
    this.projectiles.rebase(dx, dz);
    this.pickups.rebase(dx, dz);
    this.particles.normal.rebase(dx, dz); this.particles.vector.rebase(dx, dz);
    this.jet.rebase(dx, dz);
    this.ambient.rebase(dx, dz);
  }

  // ---------------------------------------------------------------- loop
  loop() {
    const now = performance.now();
    const real = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.paused) {
      // frozen frame behind the settings window: no simulation, just redraw
      if (this.input.wasPressed('KeyO')) this.toggleSettings();
      this.renderer.info.reset();
      this.post.render(this.scene, this.camera, this.time);
      this.input.endFrame();
      return;
    }
    this.perfTick(real);
    const dt = real * this.fx.timeScale;
    this.time += dt;
    this.frame++;

    // input & state transitions
    const inp = this.input;
    const ui = this.settingsPanel.isOpen;
    if (inp.wasPressed('KeyO')) this.toggleSettings();
    else if (!ui && this.state === 'menu' && (inp.wasPressed('KeyW') || inp.wasPressed('ArrowUp') || inp.wasPressed('Space'))) this.start();
    else if (!ui && this.state === 'dead' && (inp.wasPressed('KeyR') || inp.wasPressed('Space'))) this.start();
    if (inp.wasPressed('KeyC')) this.toggleCamera();
    if (inp.wasPressed('KeyM')) { this.audio.init(); this.settings.set('audio.muted', !this.settings.get('audio.muted')); }

    this.touch.update(real, inp); // right stick -> look deltas, like the mouse
    const ctl = (this.attract || this.useAutopilot) ? this.autopilot.control(dt) : inp.state();
    const p = this.player;
    // mouse aim: never touches the trajectory, only camera + weapons
    // the AIM does the fighting, not the nose: while engaged the view never drifts back
    // to the nose, and the crosshair stays fixed in the world as the jet maneuvers
    const engaged = this.weapons.engaged && !!this.weapons.primary;
    if (this.state === 'playing' && !this.attract && !this.useAutopilot && p.alive) {
      this.aim.update(dt, ctl, ctl.gun || engaged || (!AIM.autoFire && this.weapons.holding));
      this.aim.worldLock = engaged; // no magnet: tracking a moving enemy is your job
    } else this.aim.reset();

    if (this.flagsPending) this.syncFlags();
    p.update(dt, ctl, this.world);
    this.rebaseIfNeeded();
    const ox = this.world.origin.x, oz = this.world.origin.z;
    const absX = p.pos.x + ox, absZ = p.pos.z + oz;
    this.world.update(absX, absZ, p.flatForward.x, p.flatForward.z, p.speedSys.tier, this.time, p.pos.y);
    this.hazards.update(dt, p, this.difficulty || 0);
    this.watchLine(dt);

    this.weapons.update(dt, p.alive ? ctl : {});
    if (p.alive && ctl.flares) this.counter.deploy(); // manual only: defence is flying (break turns)
    this.enemies.update(dt);
    this.projectiles.update(dt);
    this.counter.update(dt);
    this.pickups.update(dt);
    this.runDirector(dt);

    // altitude band changes
    if (p.alive && !this.attract && p.speedSys.engaged) {
      const band = p.band;
      if (band !== this.lastBand) {
        if (band === 'space') { this.vaporRing(); this.hud.toast('KÁRMÁN LINE · ORBIT · ASTEROID FIELD', 'good'); }
        else if (this.lastBand === 'space') { this.vaporRing(); this.hud.toast('RE-ENTRY · RADAR EXPOSED', 'danger'); }
        else if (band === 'high') this.hud.toast('RADAR EXPOSED · MORE HOSTILES', 'danger');
        else if (band === 'low') this.hud.toast(`GROUND EFFECT · BARRIER ×${ALTITUDE.groundEffectCharge}`, 'good');
        this.lastBand = band;
      }
      // hostile band: you can't cruise between the clouds and orbit
      const zone = p.hostile.capture ? 'capture' : p.hostile.t > 0 ? 'gravity' : 'clear';
      if (zone !== this.lastZone) {
        if (zone === 'gravity' && this.lastZone !== 'capture') {
          this.hud.toast(FLAGS.space ? `GRAVITY WELL · CLIMB PAST ${Math.round(captureAltitude() / 1000)} KM OR DIVE` : `GRAVITY WELL · DIVE BELOW ${HOSTILE.floor / 1000} KM`, 'danger');
          this.audio.tierDown();
        } else if (zone === 'capture') { this.vaporRing(); this.hud.toast('ORBIT CAPTURE · PULLED INTO SPACE', 'good'); }
        else if (zone === 'clear' && this.lastZone === 'gravity') this.hud.toast('OUT OF THE GRAVITY WELL', 'good');
        this.lastZone = zone;
      }
    }
    // stats
    if (p.alive && p.speedSys.engaged && !this.attract) {
      this.stats.time += dt;
      this.stats.fromSpawn = Math.hypot(absX, absZ);
      const step = 5000 * WORLD_SCALE; // milestone rings every 100 km
      const ms = Math.floor(this.stats.fromSpawn / step);
      if (ms > this.stats.milestone) { this.stats.milestone = ms; this.hud.toast(`${ms * step / 1000} KM FROM SPAWN`, 'good'); this.audio.milestone(); }
    }
    if (this.state === 'playing' && !p.alive) {
      this.deathTimer -= real;
      if (this.deathTimer <= 0) { this.state = 'dead'; this.input.releaseLock(); this.touch.show(false); document.getElementById('death').classList.remove('hidden'); }
    }
    if (this.attract && !p.alive) this.reset(Math.floor(Math.random() * 1e9));

    // presentation
    const s = p.speedSys;
    this.scene.fog.density = WORLD.fogDensityBase + WORLD.fogDensityPerTier * (s.level - 1);
    this.rig.update(dt, p, this.fx, this.aim);
    this.camera.updateMatrixWorld();
    const amb = this.ambientConductor.update(real, {
      speed01: s.speed / TIERS[TIERS.length - 1].speed, level: s.level, tier: s.tier, charge: s.charge,
      throttle: p.throttle, braking: p.braking, boosting: this.fx.boosting, alive: p.alive && s.engaged,
      bands: this.audio.readBands(this.ambientBands) ? this.ambientBands : null, prefs: this.fx.prefs,
    });
    const live = p.alive && !this.attract;
    this.fx.update(real, this.time, {
      speed: s.speed, charge: s.charge, tier: s.tier, hasNext: !!s.next, center: this.jetOnScreen(), ambient: amb,
      hostile: live ? p.hostility : 0,
      lift: live ? Math.min(1, Math.max(0, p.drift) / (HOSTILE.lift * Math.max(1, s.speed))) : 0,
      lowHealthPulse: p.alive && p.health < 30 && !this.attract ? (0.25 + 0.15 * Math.sin(this.time * 8)) * (1 - p.health / 30) : 0,
    });
    const pov = this.rig.mode === 'cockpit';
    this.cockpit.update(dt, p, this.fx.shake, this.rig.cockpitLocal);
    this.cockpit.root.visible = p.alive && pov;
    this.jet.update(dt, p, !pov, this.fx.jetScale);
    this.speedLines.update(dt, s.speed, s.level, s.charge, p.vel);
    const H = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    this.particles.normal.update(dt, this.camera, this.scene.fog, H, p.vel);
    this.particles.vector.update(dt, p.vel);
    this.ground.update(this.camera, this.world.origin, s.speed);
    this.sky.update(this.camera, this.world.origin, this.time, (s.level - 1) / 4, p.flatForward, s.speed);
    this.clouds.update(this.camera, this.world.origin, this.time, p.flatForward, s.speed);
    this.space?.update(this.time); // orbit: sky, planet disks, fog, far plane (no-op on earth)
    this.ambient.update(dt, amb);
    updateCurvature(this.camera.position.y); // the higher you are, the rounder the world
    patchTree(this.scene);                   // newly spawned built-in materials get curvature too
    // punching through the cloud deck
    const side = p.pos.y > DECK_ALTITUDE ? 1 : -1;
    if (side !== this.deckSide && p.alive && this.state === 'playing') {
      this.vaporRing();
      if (!this.attract) this.hud.toast(side > 0 ? 'above the cloud deck' : 'below the cloud deck');
    }
    this.deckSide = side;
    this.audio.hostile = p.alive && !this.attract ? p.hostility : 0;
    this.audio.update(s.speed / TIERS[TIERS.length - 1].speed, s.level, s.charge, p.throttle, p.braking, p.alive && s.engaged && !this.attract);
    if (this.state !== 'menu') this.hud.update();

    this.renderer.info.reset();
    this.post.render(this.scene, this.camera, this.time);
    inp.endFrame();
  }

  /** The jet's screen position (uv, y up): event effects radiate from it. Cockpit: screen center. */
  jetOnScreen() {
    const out = this._jetUv || (this._jetUv = [0.5, 0.5]);
    out[0] = 0.5; out[1] = 0.5;
    if (this.rig.mode === 'cockpit' || !this.player.alive) return out;
    const v = (this._ndc || (this._ndc = new THREE.Vector3())).copy(this.player.pos).project(this.camera);
    if (v.z < 1) { out[0] = Math.min(1, Math.max(0, v.x * 0.5 + 0.5)); out[1] = Math.min(1, Math.max(0, v.y * 0.5 + 0.5)); }
    return out;
  }

  perfTick(dt) {
    const pf = this.perf;
    pf.frames++; pf.acc += dt; pf.worst = Math.max(pf.worst, dt);
    if (pf.acc >= 1) { pf.fps = pf.frames / pf.acc; pf.lastWorst = pf.worst; pf.frames = 0; pf.acc = 0; pf.worst = 0; }
  }

  makeDebug() {
    const g = this;
    return {
      setTier(n) { const s = g.player.speedSys; s.engaged = true; s.tier = Math.max(1, Math.min(5, n)); s.speed = TIERS[s.tier - 1].speed; g.fx.tierUp(s.tier); },
      spawn(kind) { g.enemies.spawnWave(kind, 0.5); },
      gate() { g.onPlayerEvent('trigger', { type: 'gate' }); },
      pickup() { return !!g.pickups.spawn('repair'); },
      god(on = true) { g.god = on; },
      autopilot(on = true) { g.useAutopilot = on; },
      /** teleport to an altitude (m), e.g. debug.altitude(90000) for orbit */
      altitude(y) { const p = g.player; p.pos.y = p.prevPos.y = Math.min(FLIGHT.ceiling, Math.max(FLIGHT.minAltitude, y)); p.pitch = 0; p.updateBasis(); },
      /** drop a line breaker on the current course now: 'block' | 'fork' | 'curtain' */
      breaker(kind) { return !!g.hazards.spawnBreaker(g.player, g.difficulty || 0, { rate: g.lineWatch.rate, kind: 'debug' }, kind); },
      orbitEvent(kind) { return g.hazards.space ? g.hazards.spawnOrbit(g.player, g.difficulty || 0, kind) : false; },
      info() {
        const i = g.renderer.info;
        return { fps: +g.perf.fps.toFixed(1), worstMs: +((g.perf.lastWorst || 0) * 1000).toFixed(1), calls: i.render.calls, tris: i.render.triangles,
          chunks: g.world.chunks.size, pending: g.world.stats.pending, enemies: g.enemies.count, tier: g.player.speedSys.tier,
          speed: Math.round(g.player.speed), health: Math.round(g.player.health), time: +g.stats.time.toFixed(1), fromSpawn: Math.round(g.stats.fromSpawn),
          origin: { ...g.world.origin }, state: g.state };
      },
    };
  }
}
