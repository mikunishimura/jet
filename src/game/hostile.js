// The hostile band between the weather and orbit (HOSTILE in config.js).
// Pure (no three.js): Player, Game, HUD and the tests share it.
import { HOSTILE, FLIGHT, SPACE, FLAGS } from '../config.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Top of the band: the Kármán line with space flight, the containment ceiling without. */
export function hostileTop(space = FLAGS.space) { return space ? SPACE.edge : FLIGHT.earthCeiling; }

/** Altitude where orbit takes over (space flight only), or Infinity. */
export function captureAltitude(space = FLAGS.space) {
  if (!space) return Infinity;
  return HOSTILE.floor + HOSTILE.capture * (hostileTop(space) - HOSTILE.floor);
}

/**
 * The band's field at altitude `y`:
 *  t         0..1 position inside the band (0 outside)
 *  gravity   0..1 downward pull (from `floorPull` at the floor to 1 over the bottom `ramp`)
 *  capture   0..1 upward pull into orbit (space flight, above `capture`)
 *  hostility 0..1 buffet / screen distortion before exposure (eases off as orbit pulls you up)
 */
export function hostileField(y, space = FLAGS.space) {
  const out = { t: 0, gravity: 0, capture: 0, hostility: 0 };
  const top = hostileTop(space);
  if (y <= HOSTILE.floor || y >= top) return out;
  const t = (y - HOSTILE.floor) / (top - HOSTILE.floor);
  const fade = smooth(0, HOSTILE.ramp, t);
  out.t = t;
  if (space && t >= HOSTILE.capture) {
    out.capture = 1;
    out.hostility = 1 - HOSTILE.captureCalm * smooth(HOSTILE.capture, 1, t);
  } else {
    // gravity never fades out completely inside: it carries you clear of the floor
    out.gravity = HOSTILE.floorPull + (1 - HOSTILE.floorPull) * fade;
    out.hostility = fade;
  }
  return out;
}
