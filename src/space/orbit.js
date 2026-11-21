// Altitude -> "how much space" helpers. Pure (no three.js): Player, Game, Sky
// and the tests share them. Every function returns the earth value below
// SPACE.skyFrom (== FLIGHT.earthCeiling), so with the space flag off nothing
// that uses them changes.
import { SPACE } from '../config.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** 1 = sea-level air .. 0 = vacuum (fog, wind noise, gusts) */
export function airDensity(alt) { return 1 - smooth(SPACE.airFade[0], SPACE.airFade[1], alt); }

/** 0 = day sky .. 1 = black space sky */
export function orbitFactor(alt) { return smooth(SPACE.skyFrom, SPACE.edge, alt); }

/** Distance (m) to the visual horizon over the stylized planet (parabolic drop d²/2R). */
export function horizonDistance(alt, R) { return Math.sqrt(2 * R * Math.max(0, alt)); }

/**
 * sin(elevation) of the planet's limb seen from `alt` (0 = on the horizon,
 * negative = below). The tangent from height h to y = -d²/2R lies at
 * d = sqrt(2Rh), elevation -atan(sqrt(2h/R)).
 */
export function limbSin(alt, R) { return Math.sin(-Math.atan(Math.sqrt(2 * Math.max(0, alt) / R))); }

/** Camera far plane: earth value below the sky transition, then grows so the whole limb stays in view. */
export function farPlane(alt, earthFar = 140000) {
  if (alt <= SPACE.skyFrom) return earthFar;
  const t = Math.min(1, (alt - SPACE.skyFrom) / (SPACE.ceiling - SPACE.skyFrom));
  return earthFar + (SPACE.far - earthFar) * Math.sqrt(t);
}
