// Fully synthesized audio (no assets): jet engine bed, wind, barrier-charge
// riser, sonic boom, minigun, missiles, explosions, alarms, and the gate/boost
// cues modeled on measured reference sounds (game-shader-style.md).
import { boostEvents } from '../render/Juice.js';
import { tierLevel } from '../config.js';

// Mach pops climb a major pentatonic scale: a clean run plays a rising melody.
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.lastGun = 0;
    this.levels = { muted: false, master: 0.8, engine: 0.8, sfx: 0.9 };
    this.air = 1; // 1 = sea level .. 0 = vacuum (space flight): wind and roar fade, the engine goes muffled
  }

  /** user audio settings: { muted, master, engine, sfx } (0..1). Safe before init. */
  setLevels(levels) { this.levels = { ...this.levels, ...levels }; this.applyLevels(); }
  applyLevels() {
    if (!this.ctx || !this.master) return;
    const L = this.levels, t = this.ctx.currentTime;
    // 0.55 was the original mix level: master 1.0 keeps the old loudness ceiling
    this.master.gain.setTargetAtTime(L.muted ? 0 : 0.55 * L.master, t, 0.03);
    this.engineBus.gain.setTargetAtTime(L.engine, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(L.sfx, t, 0.03);
  }

  /** ctx: optional context to render into (e.g. an OfflineAudioContext for measurements) */
  init(ctx = null) {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx && !AC) return;
    ctx = this.ctx = ctx || new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0.55;
    this.duck = ctx.createGain(); // event ducking (the boost's silent white frame), separate from mute
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 6;
    this.master.connect(this.duck); this.duck.connect(comp); comp.connect(ctx.destination);
    // user-adjustable buses (settings): continuous engine bed vs one-shot effects
    this.engineBus = ctx.createGain(); this.engineBus.connect(this.master);
    this.sfxBus = ctx.createGain(); this.sfxBus.connect(this.master);
    // ambient layer: spectrum of the engine + effects, tapped before the user volume
    // so muting doesn't flatten the visualizer (the analyser is not routed to the speakers)
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0.55;
    this.engineBus.connect(this.analyser); this.sfxBus.connect(this.analyser);
    this.applyLevels();

    // noise buffer shared by everything
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // engine: two detuned saws + roar noise
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 400; this.engFilter.Q.value = 2;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth'; this.osc1.frequency.value = 55;
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square'; this.osc2.frequency.value = 55.7;
    const o2g = ctx.createGain(); o2g.gain.value = 0.4;
    this.osc1.connect(this.engFilter); this.osc2.connect(o2g); o2g.connect(this.engFilter);
    this.engFilter.connect(this.engGain); this.engGain.connect(this.engineBus);
    this.osc1.start(); this.osc2.start();

    this.roar = this.loopNoise();
    this.roarFilter = ctx.createBiquadFilter(); this.roarFilter.type = 'bandpass'; this.roarFilter.frequency.value = 600; this.roarFilter.Q.value = 0.7;
    this.roarGain = ctx.createGain(); this.roarGain.gain.value = 0;
    this.roar.connect(this.roarFilter); this.roarFilter.connect(this.roarGain); this.roarGain.connect(this.engineBus);

    this.wind = this.loopNoise();
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'highpass'; this.windFilter.frequency.value = 1500;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.engineBus);

    // barrier riser
    this.riser = ctx.createOscillator(); this.riser.type = 'sawtooth'; this.riser.frequency.value = 120;
    this.riserFilter = ctx.createBiquadFilter(); this.riserFilter.type = 'bandpass'; this.riserFilter.Q.value = 8; this.riserFilter.frequency.value = 400;
    this.riserGain = ctx.createGain(); this.riserGain.gain.value = 0;
    this.riser.connect(this.riserFilter); this.riserFilter.connect(this.riserGain); this.riserGain.connect(this.engineBus);
    this.riser.start();
  }

  loopNoise() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true; s.start();
    return s;
  }

  get t() { return this.ctx.currentTime; }

  /** Fill `out` (0..1 each) with log-spaced spectrum bands. false before audio starts. */
  readBands(out) {
    const a = this.analyser;
    if (!a) return false;
    const buf = this._fbuf || (this._fbuf = new Uint8Array(a.frequencyBinCount));
    a.getByteFrequencyData(buf);
    const n = out.length, N = buf.length;
    for (let i = 0; i < n; i++) {
      const lo = Math.floor(Math.pow(N, i / n)), hi = Math.max(lo + 1, Math.floor(Math.pow(N, (i + 1) / n)));
      let m = 0;
      for (let j = lo; j < hi && j < N; j++) m = Math.max(m, buf[j]);
      out[i] = m / 255;
    }
    return true;
  }

  /** continuous parameters every frame (level = tierLevel, 1..5) */
  update(speed01, tier, charge, throttle, braking, alive) {
    if (!this.ctx) return;
    const t = this.t, k = 0.08;
    const on = alive ? 1 : 0;
    this.osc1.frequency.setTargetAtTime(45 + speed01 * 90 + (throttle ? 12 : 0), t, k);
    this.osc2.frequency.setTargetAtTime(45.6 + speed01 * 91 + (throttle ? 12 : 0), t, k);
    const air = this.air;
    this.engFilter.frequency.setTargetAtTime((250 + speed01 * 1400 + (throttle ? 400 : 0)) * (0.45 + 0.55 * air), t, k);
    this.engGain.gain.setTargetAtTime(on * (0.10 + speed01 * 0.06), t, k);
    this.roarFilter.frequency.setTargetAtTime(400 + speed01 * 1800, t, k);
    this.roarGain.gain.setTargetAtTime(on * (0.12 + speed01 * 0.2 + (throttle ? 0.08 : 0) - (braking ? 0.05 : 0)) * (0.35 + 0.65 * air), t, k);
    this.windGain.gain.setTargetAtTime(on * speed01 * speed01 * 0.18 * air, t, k);
    this.windFilter.frequency.setTargetAtTime(1200 + speed01 * 3000, t, k);
    this.riser.frequency.setTargetAtTime(110 + charge * charge * 900 * (0.6 + tier * 0.15), t, 0.05);
    this.riserFilter.frequency.setTargetAtTime(300 + charge * 2600, t, 0.05);
    this.riserGain.gain.setTargetAtTime(on * charge * charge * 0.12, t, 0.05);
  }

  noiseBurst({ dur = 0.2, gain = 0.3, type = 'lowpass', freq = 1000, freqEnd = null, q = 1, attack = 0.002, delay = 0 }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t + delay;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.sfxBus);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }

  tone({ freq = 440, freqEnd = null, dur = 0.2, gain = 0.2, type = 'sine', delay = 0 }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfxBus); o.start(t); o.stop(t + dur + 0.05);
  }

  /** Oscillator with a shaped envelope (attack, hold, exponential release) and an exponential pitch glide. */
  voice({ type = 'sine', f0, f1 = f0, glide = 0.1, attack = 0.005, hold = 0, release = 0.2, gain = 0.2, from = 0.0001, delay = 0, filter = null }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t + delay, end = t + attack + hold + release;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
    const g = ctx.createGain();
    g.gain.setValueAtTime(from, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    let out = o;
    if (filter) {
      const f = ctx.createBiquadFilter(); f.type = filter.type; f.Q.value = filter.q || 1;
      f.frequency.setValueAtTime(filter.freq, t);
      if (filter.freqEnd) f.frequency.exponentialRampToValueAtTime(filter.freqEnd, t + (filter.dur || end - t));
      o.connect(f); out = f;
    }
    out.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(end + 0.05);
  }

  falloff(dist, ref = 300) { return 1 / (1 + (dist / ref) * (dist / ref)); }

  sonicBoom(tier) {
    tier = tierLevel(tier);
    this.noiseBurst({ dur: 0.06, gain: 0.9, type: 'highpass', freq: 2000 });         // crack
    this.noiseBurst({ dur: 1.6, gain: 1.0, type: 'lowpass', freq: 500, freqEnd: 60, attack: 0.01 }); // body
    this.tone({ freq: 90, freqEnd: 28, dur: 1.2, gain: 0.7, type: 'sine' });
    this.tone({ freq: 400 + tier * 120, freqEnd: 1600 + tier * 300, dur: 0.35, gain: 0.08, type: 'sawtooth' });
    this.noiseBurst({ dur: 0.9, gain: 0.25, type: 'bandpass', freq: 3000, freqEnd: 300, q: 2, delay: 0.05 });
  }
  tierDown() {
    this.tone({ freq: 600, freqEnd: 70, dur: 0.6, gain: 0.25, type: 'sawtooth' });
    this.noiseBurst({ dur: 0.5, gain: 0.3, type: 'lowpass', freq: 2000, freqEnd: 100 });
  }
  launch() { this.noiseBurst({ dur: 1.2, gain: 0.6, type: 'lowpass', freq: 200, freqEnd: 2500, attack: 0.3 }); }
  gunshot() {
    if (!this.ctx) return;
    this.noiseBurst({ dur: 0.045, gain: 0.22, type: 'bandpass', freq: 1700 + Math.random() * 400, q: 1.2 });
    this.tone({ freq: 140, freqEnd: 60, dur: 0.05, gain: 0.1, type: 'square' });
  }
  overheat() { this.noiseBurst({ dur: 0.8, gain: 0.25, type: 'highpass', freq: 4000, freqEnd: 800 }); }
  click() { this.tone({ freq: 1200, dur: 0.04, gain: 0.1, type: 'square' }); }
  missileLaunch(kill = false) {
    if (kill) { this.noiseBurst({ dur: 0.25, gain: 0.45, type: 'highpass', freq: 1800, freqEnd: 6000, attack: 0.002 }); this.tone({ freq: 2400, freqEnd: 600, dur: 0.18, gain: 0.06, type: 'sawtooth' }); return; }
    this.noiseBurst({ dur: 0.7, gain: 0.35, type: 'bandpass', freq: 600, freqEnd: 3000, q: 1.5, attack: 0.02 });
  }
  enemyMissile() { this.tone({ freq: 880, dur: 0.12, gain: 0.12, type: 'square' }); this.tone({ freq: 880, dur: 0.12, gain: 0.12, type: 'square', delay: 0.2 }); this.tone({ freq: 880, dur: 0.12, gain: 0.12, type: 'square', delay: 0.4 }); }
  /** level 0..1: higher, louder and (via the caller) faster as the impact closes in */
  missileWarning(level = 0.5) { this.tone({ freq: 900 + 900 * level, dur: 0.05 + 0.03 * level, gain: 0.05 + 0.08 * level, type: 'square' }); }
  flares() {
    this.noiseBurst({ dur: 0.5, gain: 0.35, type: 'bandpass', freq: 2500, freqEnd: 900, q: 1.2 });
    for (let i = 0; i < 3; i++) this.noiseBurst({ dur: 0.08, gain: 0.25, type: 'highpass', freq: 3000, delay: i * 0.06 });
  }
  /** confirmed gun hit: a short dry tick (pitch up a little for heavier hits) */
  hitTick(k = 0.5) { this.tone({ freq: 1900 + 700 * k, freqEnd: 1100, dur: 0.035, gain: 0.07, type: 'triangle' }); }
  /** lock building on a target: p = progress 0..1 */
  lockTick(p) { this.tone({ freq: 520 + 900 * p, dur: 0.035, gain: 0.05, type: 'sine' }); }
  lockOn() { this.tone({ freq: 1500, dur: 0.07, gain: 0.08, type: 'square' }); this.tone({ freq: 2100, dur: 0.09, gain: 0.07, type: 'square', delay: 0.07 }); }
  enemyGun(dist) { const f = this.falloff(dist, 600); if (f > 0.05) this.noiseBurst({ dur: 0.04, gain: 0.15 * f, type: 'bandpass', freq: 2600, q: 2 }); }
  plasma(dist) { const f = this.falloff(dist, 900); this.tone({ freq: 300, freqEnd: 900, dur: 0.25, gain: 0.12 * f + 0.02, type: 'triangle' }); }
  explosion(dist, size = 1) {
    const f = this.falloff(dist, 700) * size;
    if (f < 0.02) return;
    this.noiseBurst({ dur: 1.0 + size * 0.6, gain: 0.7 * f, type: 'lowpass', freq: 1200, freqEnd: 80, attack: 0.005 });
    this.tone({ freq: 70, freqEnd: 30, dur: 0.6, gain: 0.5 * f });
  }
  hit(amount) { this.noiseBurst({ dur: 0.18, gain: Math.min(0.6, 0.15 + amount / 40), type: 'lowpass', freq: 900, freqEnd: 120 }); this.tone({ freq: 160, freqEnd: 50, dur: 0.2, gain: 0.3, type: 'square' }); }
  impact(hard) {
    if (hard) { this.noiseBurst({ dur: 1.0, gain: 1.0, type: 'lowpass', freq: 700, freqEnd: 50 }); this.tone({ freq: 60, freqEnd: 25, dur: 0.8, gain: 0.8, type: 'square' }); }
    else this.noiseBurst({ dur: 0.35, gain: 0.35, type: 'bandpass', freq: 2500, freqEnd: 600, q: 3 });
  }
  pickup() { [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.18, gain: 0.14, type: 'triangle', delay: i * 0.06 })); }
  // Survey gate = the "landing" hit. Reference (Landing/Stomp): a bright click in the first
  // 40 ms, then a 120-500 Hz thump falling ~420 -> 180 Hz, -20 dB by ~0.33 s, a short sub tail;
  // plus a ~1 kHz whoosh (air through the arch).
  gate() {
    this.noiseBurst({ dur: 0.04, gain: 1.3, type: 'highpass', freq: 3000, attack: 0.001 });
    this.voice({ type: 'square', f0: 420, f1: 180, glide: 0.3, attack: 0.02, hold: 0.07, release: 0.57, gain: 0.45, filter: { type: 'lowpass', freq: 1600, q: 0.7 } });
    this.voice({ type: 'sine', f0: 210, f1: 90, glide: 0.3, attack: 0.02, hold: 0.07, release: 0.57, gain: 0.3 });
    this.noiseBurst({ dur: 0.25, gain: 0.15, type: 'bandpass', freq: 1800, freqEnd: 900, q: 0.7, attack: 0.005 }); // grit above the body
    this.voice({ type: 'sine', f0: 50, f1: 32, glide: 0.2, attack: 0.04, hold: 0.04, release: 0.2, gain: 0.14, delay: 0.26 });
    this.noiseBurst({ dur: 0.42, gain: 0.1, type: 'bandpass', freq: 800, freqEnd: 1400, q: 1.2, attack: 0.16 });
  }

  // Barrier break = the boost. Every cue is scheduled from Juice.boostEvents, the same
  // timeline the picture uses: boom -> riser under the flood -> silence on the white
  // frame -> sub drop on the cut -> a chew on each negative beat, a tick on each positive one.
  boost(tier) {
    if (!this.ctx) return;
    for (const e of boostEvents(tier)) {
      switch (e.type) {
        case 'break': this.sonicBoom(tier); break;
        case 'riser': this.riserSweep(e.t, e.until - e.t, tier); break;
        case 'white': this.duckFor(e.t, e.until - e.t); break;
        case 'neg': if (e.first) this.drop(e.t); else this.crunch(e.t, e.len); break;
        case 'pos': this.tick(e.t); break;
        case 'end': this.noiseBurst({ dur: 0.5, gain: 0.16, type: 'bandpass', freq: 3000, freqEnd: 400, q: 1.5, attack: 0.02, delay: e.t }); break;
      }
    }
  }
  /** reference Charge01: pitch 183 -> 495 Hz while brightness climbs 1.2 -> 2.4 kHz; cut dead at the white frame */
  riserSweep(delay, dur, tier) {
    tier = tierLevel(tier);
    this.voice({ type: 'sawtooth', f0: 180, f1: 500 + tier * 40, glide: dur, attack: dur * 0.85, hold: dur * 0.15 - 0.006, release: 0.006, gain: 0.5, from: 0.03, delay,
      filter: { type: 'bandpass', freq: 900, freqEnd: 2800, q: 1.8, dur } });
    this.noiseBurst({ dur, gain: 0.1, type: 'bandpass', freq: 1000, freqEnd: 3000, q: 1.2, attack: dur * 0.9, delay });
  }
  /** the white frame is silent: dip everything (engine included), then snap back for the drop */
  duckFor(delay, dur) {
    const g = this.duck.gain, t = this.t + delay;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t); g.linearRampToValueAtTime(0.05, t + 0.008);
    g.setValueAtTime(0.05, t + dur); g.linearRampToValueAtTime(1, t + dur + 0.004);
  }
  /** the cut into the negative. Reference (long Stomp): pure sub 78 -> 31 Hz in 0.12 s, -20 dB at ~0.73 s */
  drop(delay) {
    this.voice({ type: 'sine', f0: 78, f1: 31, glide: 0.12, attack: 0.004, hold: 0.3, release: 1.7, gain: 0.95, delay });
    this.voice({ type: 'triangle', f0: 156, f1: 62, glide: 0.12, attack: 0.004, hold: 0.05, release: 0.35, gain: 0.22, delay });
    this.noiseBurst({ dur: 0.3, gain: 0.45, type: 'lowpass', freq: 900, freqEnd: 120, attack: 0.002, delay });
  }
  /** negative beat. Reference (Crusher): steady gritty band around 2 kHz with 110-200 Hz grain, chewing */
  crunch(delay, len) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t + delay, dur = len * 0.85;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2000; f.Q.value = 0.9;
    const chop = ctx.createGain(); chop.gain.value = 0.5;                  // 16 Hz square: the chew
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 16;
    const depth = ctx.createGain(); depth.gain.value = 0.5;
    lfo.connect(depth); depth.connect(chop.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.setValueAtTime(0.2, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(chop); chop.connect(g); g.connect(this.sfxBus);
    src.start(t, Math.random()); src.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
    this.voice({ type: 'square', f0: 150, f1: 110, glide: dur, attack: 0.004, hold: 0.02, release: 0.12, gain: 0.08, delay, filter: { type: 'lowpass', freq: 900 } });
  }
  /** Every non-milestone Mach change: crack + thump (like the gate) + a ping on the Mach scale. */
  machPop(tier) {
    const lvl = tierLevel(tier), f0 = 360 + lvl * 30;
    const ping = 330 * Math.pow(2, PENTA[Math.min(PENTA.length - 1, tier - 1)] / 12);
    this.noiseBurst({ dur: 0.05, gain: 1.0, type: 'highpass', freq: 3000, attack: 0.001 });
    this.voice({ type: 'square', f0, f1: f0 * 0.45, glide: 0.25, attack: 0.015, hold: 0.05, release: 0.45, gain: 0.4, filter: { type: 'lowpass', freq: 1600, q: 0.7 } });
    this.voice({ type: 'sine', f0: 62, f1: 32, glide: 0.18, attack: 0.005, hold: 0.06, release: 0.35, gain: 0.45 });
    this.voice({ type: 'triangle', f0: ping, attack: 0.004, hold: 0.04, release: 0.35, gain: 0.12, delay: 0.02 });
  }
  /** Near miss: a doppler whoosh past the hull, louder and brighter the closer it was. */
  nearMiss(closeness) {
    const c = Math.max(0, Math.min(1, closeness));
    this.noiseBurst({ dur: 0.32, gain: 0.2 + 0.3 * c, type: 'bandpass', freq: 2600 + 1200 * c, freqEnd: 500, q: 2, attack: 0.03 });
    this.voice({ type: 'sine', f0: 1500 + 600 * c, f1: 450, glide: 0.22, attack: 0.01, release: 0.2, gain: 0.05 + 0.05 * c });
  }

  /** positive beat: a light tick so the flips are audible both ways */
  tick(delay) {
    this.noiseBurst({ dur: 0.04, gain: 0.22, type: 'highpass', freq: 3000, attack: 0.001, delay });
    this.voice({ type: 'triangle', f0: 1200, attack: 0.002, release: 0.06, gain: 0.07, delay });
  }
  alarm() { this.tone({ freq: 520, dur: 0.18, gain: 0.1, type: 'square' }); this.tone({ freq: 390, dur: 0.18, gain: 0.1, type: 'square', delay: 0.2 }); }
  milestone() { [784, 988, 1175].forEach((f, i) => this.tone({ freq: f, dur: 0.25, gain: 0.1, type: 'sine', delay: i * 0.09 })); }
  death() { this.noiseBurst({ dur: 2.5, gain: 1, type: 'lowpass', freq: 1500, freqEnd: 40 }); this.tone({ freq: 200, freqEnd: 20, dur: 2, gain: 0.6, type: 'sawtooth' }); }
}
