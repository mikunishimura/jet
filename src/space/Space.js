// Space flight (FLAGS.space): everything that exists only when the ceiling
// opens into orbit. Game creates one of these when the flag is on and
// disposes it when the flag goes off; nothing else in the game needs to know.
//
//   * the orbital asteroid field (a World layer)
//   * orbital path events (PathHazards.space -> asteroids, moons, boost rings)
//   * the planet seen from above: curvature fade for free-flying objects,
//     wider ground / cloud disks, thinner fog, a far plane that reaches the
//     limb, a sky that turns black with stars and an atmosphere rim, and
//     wind noise / gusts that fade with the air
import { SPACE, WORLD_SCALE } from '../config.js';
import { CURVE_FADE, curveRadius } from '../render/curvature.js';
import { DECK_ALTITUDE } from '../world/Clouds.js';
import { SpaceField } from './SpaceField.js';
import { BodyLibrary, SpaceBuilder } from './bodies.js';
import { spaceMaterials, SPACE_TIME, SPACE_FAR } from './materials.js';
import { airDensity, orbitFactor, limbSin, horizonDistance, farPlane } from './orbit.js';

const GROUND_R = 160000, CLOUD_R = 150000, EARTH_FAR = 140000;

export class Space {
  constructor(game) {
    this.game = game;
    const w = game.world;
    this.library = new BodyLibrary(11);
    this.materials = spaceMaterials(w);
    this.field = w.addLayer(new SpaceField(w, this.materials, this.library));
    game.hazards.space = this;
    // free-flying things stop following the planet's curve as they leave the air
    CURVE_FADE.value.set(SPACE.skyFrom + 2000, SPACE.edge - 8000);
    this.env = { orbit: 0, air: 1, limb: 0 };
  }

  /** a throwaway rock + ring in front of `pos`, so Game.warmup compiles the orbit shaders up front */
  warmupObject(pos) {
    const S = WORLD_SCALE, b = new SpaceBuilder(pos.x / S, pos.z / S);
    b.addBody(this.library.pick('rock'), { x: pos.x / S, y: pos.y / S, z: pos.z / S - 20, radius: 2 });
    b.addRing({ x: pos.x / S, y: pos.y / S, z: pos.z / S - 30, heading: 0, radius: 4, tube: 0.5, id: 'warmup' });
    const g = b.bake(this.materials);
    g.scale.setScalar(S);
    g.position.set(pos.x, 0, pos.z); // builder geometry is relative to its center
    return g;
  }

  dispose() {
    const g = this.game;
    g.world.removeLayer(this.field);
    this.field.disposeAll();
    g.hazards.clearOrbit();
    if (g.hazards.space === this) g.hazards.space = null;
    CURVE_FADE.value.set(1e9, 2e9);
    this.applyEnvironment(0, true);
  }

  /** per frame, after the earth systems updated (they own position; we own scale / far / orbit) */
  update(time) {
    SPACE_TIME.value = time;
    const g = this.game;
    SPACE_FAR.value = g.world.viewDistance(g.player.speedSys.tier) * 1.05;
    this.applyEnvironment(g.camera.position.y);
  }

  applyEnvironment(alt, restore = false) {
    const g = this.game, R = curveRadius(alt);
    const orbit = restore ? 0 : orbitFactor(alt), air = restore ? 1 : airDensity(alt);
    const limb = restore ? 0 : limbSin(alt, R);
    this.env.orbit = orbit; this.env.air = air; this.env.limb = limb;
    const su = g.sky.material.uniforms;
    su.uOrbit.value = orbit; su.uLimb.value = limb;
    // the planet disks reach past the visual horizon (or the edge would show)
    const kg = restore ? 1 : Math.max(1, (1.25 * horizonDistance(alt, R)) / GROUND_R);
    const kc = restore ? 1 : Math.max(1, (1.25 * horizonDistance(alt - DECK_ALTITUDE, R)) / CLOUD_R);
    g.ground.mesh.scale.set(kg, 1, kg);
    g.clouds.mesh.scale.set(kc, 1, kc);
    // thin air: the planet stays crisp from orbit, only its limb is hazy
    if (!restore) g.scene.fog.density *= 0.08 + 0.92 * air;
    const far = restore ? EARTH_FAR : farPlane(alt, EARTH_FAR);
    if (Math.abs(g.camera.far - far) > far * 0.01) { g.camera.far = far; g.camera.updateProjectionMatrix(); }
    g.audio.air = air;
    // HUD: ink on white reads as nothing on black space
    const dark = orbit > 0.55;
    if (dark !== this.darkHud) { this.darkHud = dark; g.hud.root.classList.toggle('orbit', dark); }
  }
}
