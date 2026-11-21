// Turns gameplay events into screen-effect envelopes (post uniforms, camera
// shake, FOV punches, hit-stop). Everything decays on its own.
import { TIERS, JUICE, MACH_FACTOR, tierLevel, AMBIENT } from '../config.js';
import { gateFrame, boostFrame, isMilestone } from './Juice.js';

const decay = (v, rate, dt) => v * Math.exp(-rate * dt);

export class FXDirector {
  constructor(post) {
    this.post = post;
    this.neg = 0; this.negFlicker = 0; this.glitch = 0; this.ripple = 0; this.ab = 0;
    this.damage = 0; this.desat = 0; this.shake = 0;
    this.fovPunch = 0; this.fovVel = 0;
    this.hitStop = 0; // real seconds of slow motion remaining
    // user preferences (settings panel): intensity scales the screen effects,
    // flashes=false removes color inversion and dims white flashes (photosensitivity)
    this.prefs = { intensity: 1, flashes: true, shake: 1, blur: 1 };
    this.scheduled = [];
    this.flash = 0;
    // event timelines (seconds since the event, real time); Infinity = idle
    this.hitT = Infinity; this.hitJ = JUICE.gate;   // one "hit" slot: gate / Mach pop / near miss
    this.boostT = Infinity; this.boostTier = JUICE.boost.milestones[0];
    this.jetScale = [1, 1];
    this.center = [0.5, 0.5];                       // the jet on screen (uv), set every frame
  }
  get boosting() { return !boostFrame(this.boostT, this.boostTier).done; }
  after(t, fn) { this.scheduled.push({ t, fn }); }

  /** shockwave from the jet: space bends around it */
  waveAtJet(strength) { this.post.wave(this.center[0], this.center[1], strength); }
  hit(J, ghost) {
    this.hitT = 0; this.hitJ = J;
    if (ghost && !this.boosting) this.post.setGhost(ghost);
  }

  /** Every Mach change pops around the jet; milestone tiers get the full boost. */
  tierUp(tier) {
    const milestone = isMilestone(tier);
    const k = (0.7 + tierLevel(tier) * 0.15) * (milestone ? 1 : 0.7);
    this.waveAtJet(1.1 * k);
    this.after(0.09, () => this.waveAtJet(0.7 * k));
    this.after(0.2, () => this.waveAtJet(0.4 * k));
    this.ab = 0.035;
    this.fovVel -= milestone ? 160 : 110;
    if (milestone) {
      // vortex -> flood -> white frame -> negative flipping on the beat (Juice.boostFrame)
      this.boostT = 0; this.boostTier = tier;
      this.post.setGhost(TIERS[tier - 1].roman);
      this.glitch = Math.max(this.glitch, 0.6);
      this.shake += 1.4;
      this.hitStop = 0.16;
    } else {
      this.hit(JUICE.pop, `M${Math.round(TIERS[tier - 1].speed * MACH_FACTOR)}`);
      this.shake += 0.8;
      this.hitStop = 0.05;
    }
  }
  tierDown(reason) {
    this.post.wave(0.5, 0.5, -0.9);
    this.desat = 0.85;
    this.negFlicker = 0.12; this.neg = 0.7;
    this.glitch = Math.max(this.glitch, 0.7);
    this.ab = Math.max(this.ab, 0.02);
    this.shake += reason === 'brake' ? 0.4 : 1.0;
    this.fovVel += 70;
  }
  hurt(amount) {
    this.damage = Math.min(1, this.damage + amount / 22);
    this.shake += Math.min(1.5, amount / 18);
    this.ab = Math.max(this.ab, Math.min(0.03, amount / 900));
    this.glitch = Math.max(this.glitch, Math.min(0.8, amount / 40));
  }
  impact(hard) {
    if (hard) { this.shake += 2.5; this.negFlicker = 0.18; this.neg = 1; this.glitch = 1; this.post.wave(0.5, 0.5, -1.2); this.hitStop = 0.1; }
    else { this.shake += 0.5; this.glitch = Math.max(this.glitch, 0.25); }
  }
  explosionNear(intensity) { this.shake += intensity; }
  /** survey gate = the "landing" hit: hollow ring, beam, ghost count, smear (Juice.gateFrame) */
  gate(count) {
    this.hit(JUICE.gate, String(count).padStart(2, '0'));
    this.waveAtJet(0.35);
    this.fovVel -= 60;
  }
  /** near miss: a small fast hit around the jet, stronger the closer you passed */
  nearMiss(closeness) {
    this.hit(JUICE.near, 'CLOSE');
    this.waveAtJet(0.2 + 0.35 * closeness);
    this.fovVel -= 25 + 45 * closeness;
    this.shake += 0.2 + 0.4 * closeness;
  }

  /** dt is REAL time. */
  update(dt, time, s) {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const e = this.scheduled[i];
      if ((e.t -= dt) <= 0) { e.fn(); this.scheduled.splice(i, 1); }
    }
    this.post.update(dt);
    if (this.negFlicker > 0) {
      this.negFlicker -= dt;
      // stuttering on/off inversions while the flicker window is open
      this.neg = Math.random() < 0.55 ? 1 : 0.15;
    } else this.neg = decay(this.neg, 14, dt);
    this.glitch = decay(this.glitch, 3.2, dt);
    this.ripple = decay(this.ripple, 2.2, dt);
    this.ab = decay(this.ab, 4, dt);
    this.damage = decay(this.damage, 2.2, dt);
    this.desat = decay(this.desat, 1.4, dt);
    this.shake = decay(this.shake, 3.5, dt);
    // FOV punch spring
    this.fovVel += (-this.fovPunch * 90 - this.fovVel * 11) * dt;
    this.fovPunch += this.fovVel * dt;
    if (this.hitStop > 0) this.hitStop -= dt;
    if (this.hitT < 60) this.hitT += dt;
    if (this.boostT < 60) this.boostT += dt;
    if (s.center) { this.center[0] = s.center[0]; this.center[1] = s.center[1]; }
    const gf = gateFrame(this.hitT, this.hitJ);
    const bf = boostFrame(this.boostT, this.boostTier);
    this.jetScale[0] = gf.jet[0] * bf.jet[0];
    this.jetScale[1] = gf.jet[1] * bf.jet[1];

    const speed01 = s.speed / TIERS[TIERS.length - 1].speed;
    const u = this.post.u;
    u.uCenter.value.set(this.center[0], this.center[1]);
    const P = this.prefs, I = P.intensity;
    u.uInvert.value = P.flashes ? 1 : 0;
    u.uNegative.value = P.flashes ? Math.max(this.neg, bf.negative) * I : 0;
    u.uSwirl.value.set(bf.swirl.radius, bf.swirl.intensity);
    u.uFlood.value = bf.flood * I;
    u.uWhite.value = bf.white * (P.flashes ? 1 : 0.2) * I;
    u.uRing.value.set(gf.ring.radius, gf.ring.alpha);
    u.uBeam.value.set(gf.beam, gf.line);
    u.uGhost.value = Math.max(gf.ghost, bf.ghost);
    u.uGlitch.value = this.glitch * I;
    u.uRipple.value = this.ripple * I;
    u.uAberration.value = this.ab * I;
    // ambient breathing: the frame tightens a little with the engine's loudness
    const breathe = s.ambient ? s.ambient.loud * s.ambient.gate : 0;
    u.uBlur.value = (Math.pow(speed01, 1.3) * 0.95 + s.charge * 0.25 + AMBIENT.breathe.blur * breathe) * P.blur;
    u.uHaze.value = s.charge * (s.tier >= 1 ? 1 : 0);
    u.uDamage.value = Math.max(this.damage, s.lowHealthPulse);
    u.uDesat.value = this.desat;
    u.uVignette.value = 0.08 + 0.12 * speed01 + AMBIENT.breathe.vignette * breathe; // light: keep the white world white
    u.uCone.value = Math.max(0, (s.charge - 0.55) / 0.45) * (s.hasNext ? 1 : 0);
  }
  get timeScale() { return this.hitStop > 0 ? 0.22 : 1; }
}
