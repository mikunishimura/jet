// Feature-flag resolution. The live values sit in FLAGS (config.js) so pure
// modules (Player, World) can read them without a game reference.
//
// Precedence: URL override > player setting (settings 'flags.*') > default.
//   ?space=off   ?space=0   ?space=false   -> force off
//   ?space=on    ?space=1   ?space=true    -> force on
//
// Game latches the resolved values at the start of each flight (and live
// whenever the change can't teleport the player, see Game.syncFlags).
import { FLAGS } from '../config.js';

export const FLAG_DEFAULTS = Object.freeze({ ...FLAGS });

/** true / false from a URL query string, or null when the flag isn't given */
export function urlFlag(name, search = (typeof location !== 'undefined' ? location.search : '')) {
  const v = new URLSearchParams(search).get(name);
  if (v === null) return null;
  const s = v.trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(s)) return false;
  if (['', '1', 'on', 'true', 'yes'].includes(s)) return true;
  return null;
}

/** resolved value for one flag */
export function resolveFlag(name, { search, setting } = {}) {
  const u = urlFlag(name, search);
  if (u !== null) return u;
  if (typeof setting === 'boolean') return setting;
  return FLAG_DEFAULTS[name];
}
