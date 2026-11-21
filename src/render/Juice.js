// Event timelines for the gate ("landing") and barrier-break ("boost") effects.
// Pure functions of time since the event, so they are unit-tested and the
// FXDirector only maps their output onto post uniforms. Numbers live in JUICE.
import { JUICE, TIERS } from '../config.js';

/** Full boost (vortex -> white -> negative) only on milestone tiers; other Mach changes pop. */
export const isMilestone = (tier) => JUICE.boost.milestones.includes(tier);
/** Beat length (s) at a tier: the higher you go, the faster the rhythm, never past 3 flips/s. */
export function beatFor(tier) {
  const k = (tier - 1) / (TIERS.length - 1);
  return Math.max(JUICE.beatMin, JUICE.beat + (JUICE.beatMin - JUICE.beat) * k);
}
const beatsFor = (tier, J = JUICE.boost) => J.beatsBase + Math.max(0, J.milestones.indexOf(tier));

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOutCubic = (k) => 1 - Math.pow(1 - clamp01(k), 3);
const smooth = (k) => { k = clamp01(k); return k * k * (3 - 2 * k); };

/** Instant/linear attack, flat hold, linear fade. Returns 0..1. */
export function envelope(t, attack, hold, fade) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  if (t < attack + hold) return 1;
  return Math.max(0, 1 - (t - attack - hold) / fade);
}

// damped settle from a scale back to 1 (one small overshoot)
function settle(from, k) {
  const e = clamp01(k);
  return 1 + (from - 1) * (1 - e) * Math.cos(e * Math.PI * 1.5);
}

const IDLE_GATE = { active: false, ring: { radius: 0, alpha: 0 }, beam: 0, line: 0, ghost: 0, jet: [1, 1] };

/** Survey gate pass. t = seconds since the gate trigger. */
export function gateFrame(t, J = JUICE.gate) {
  const total = J.hold + J.fade;
  if (t < 0 || t > total + J.smear.settle + 0.2) return IDLE_GATE;
  const e = envelope(t, 0, J.hold, J.fade);
  const S = J.smear;
  let jet;
  if (t < S.smearFor) jet = S.stretch;
  else if (t < S.smearFor + S.squashFor) jet = S.squash;
  else {
    const k = (t - S.smearFor - S.squashFor) / S.settle;
    jet = [settle(S.squash[0], k), settle(S.squash[1], k)];
  }
  return {
    active: true,
    ring: { radius: J.ring.from + (J.ring.to - J.ring.from) * easeOutCubic(t / J.ring.grow), alpha: J.ring.alpha * e },
    beam: J.beam * e,
    line: J.line * e * e,
    ghost: J.ghost * e,
    jet: [jet[0], jet[1]],
  };
}

/** Barrier break. t = seconds since the break, tier = the new tier. */
export function boostFrame(t, tier, J = JUICE.boost, beat = beatFor(tier)) {
  const beats = beatsFor(tier, J);
  const negStart = J.cut + J.whiteFrame;
  const negEnd = negStart + beats * beat;
  const out = { swirl: { radius: 0, intensity: 0 }, flood: 0, white: 0, negative: 0, ghost: 0, jet: [1, 1], done: t >= negEnd };
  if (t < 0) return out;

  // 1) vortex: radius eases out, refraction fades over its lifetime
  const ks = t / J.swirl.duration;
  if (ks < 1) out.swirl = { radius: J.swirl.endRadius * (1 - Math.pow(1 - ks, 2)), intensity: J.swirl.intensity * (1 - ks) };

  // 2) flood toward paper-white, then one white frame as the cut
  if (t < J.cut) out.flood = J.flood.amount * smooth((t - J.flood.from) / (J.cut - J.flood.from));
  else if (t < negStart) out.white = 1;

  // 3) the negative, flipping on every beat; always ends positive
  if (t >= negStart && t < negEnd) out.negative = Math.floor((t - negStart) / beat) % 2 === 0 ? 1 : 0;

  // ghost numeral: punches in at the cut, holds through the negative, fades after
  if (t >= J.cut) out.ghost = J.ghost * (t < negEnd ? 1 : Math.max(0, 1 - (t - negEnd) / 0.4));

  // smear along the flight axis, then settle
  const S = J.smear;
  if (t < S.smearFor) out.jet = [S.stretch[0], S.stretch[1]];
  else {
    const k = (t - S.smearFor) / S.settle;
    out.jet = [settle(S.stretch[0], k), settle(S.stretch[1], k)];
  }
  return out;
}

/**
 * The boost's discrete moments, for anything that must hit the same frames as the
 * picture (the audio schedules from this). Times in seconds since the break.
 * break -> riser (flood starts) -> white (the cut frame) -> neg (first = the drop) /
 * pos flips on the beat -> end.
 */
export function boostEvents(tier, J = JUICE.boost, beat = beatFor(tier)) {
  const beats = beatsFor(tier, J);
  const negStart = J.cut + J.whiteFrame;
  const negEnd = negStart + beats * beat;
  const ev = [{ t: 0, type: 'break' }, { t: J.flood.from, type: 'riser', until: J.cut }, { t: J.cut, type: 'white', until: negStart }];
  for (let k = 0; k < beats; k++) ev.push({ t: negStart + k * beat, type: k % 2 === 0 ? 'neg' : 'pos', first: k === 0, len: beat });
  if (beats % 2 === 1) ev.push({ t: negEnd, type: 'pos', first: false, len: 0 });
  ev.push({ t: negEnd, type: 'end' });
  return ev;
}
