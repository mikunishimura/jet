// Orbital obstacle events, placed DOWN YOUR PATH at your altitude by
// PathHazards once you fly above SPACE.hazardFloor. The orbital twins of the
// planet patterns: single rocks on your line or a near miss, pairs to thread,
// boost rings (the survey gates of orbit), swarms, a belt wall with one hole,
// moonlets to steer around and huge moons as scenery.
//
// A pattern is `(b, c) => reach` (base meters). b is a SpaceBuilder; c:
//   c.at(along, side, up)   base-meter [x, y, z] down the path
//   c.offset(radius)        [side, up]: on your line, or a near miss
//   c.rock(b, along, side, up, radius)  c.moon(...)  c.ring(b, along, side, up)
//   c.difficulty, c.heading, c.id
// Add one: write it here and give it a weight in SPACE.patterns (config.js).

const R = (a, b) => a + (b - a) * Math.random();
const sign = () => (Math.random() < 0.5 ? -1 : 1);

export const SPACE_PATTERNS = {
  /** one asteroid: on your line or a near miss (above, below, beside) */
  asteroid(b, c) {
    const r = R(30, 62);
    c.rock(b, 0, ...c.offset(r), r);
    return 220;
  },
  /** two rocks flanking your line, side by side or one over the other: hold it */
  pair(b, c) {
    const gap = R(95, 140) - 25 * c.difficulty, vertical = Math.random() < 0.4;
    for (const s of [-1, 1]) {
      const r = R(22, 36), o = s * (gap / 2 + r);
      c.rock(b, R(-15, 15), vertical ? R(-12, 12) : o, vertical ? o : R(-12, 12), r);
    }
    return 300;
  },
  /** a boost ring square on your line */
  ring(b, c) {
    c.ring(b, 0, R(-14, 14), R(-14, 14));
    return 200;
  },
  /** three rings in a row: the straight line through all of them is the reward */
  ringRun(b, c) {
    const ds = R(-8, 8), du = R(-8, 8);
    for (let i = 0; i < 3; i++) c.ring(b, i * 260 - 260, ds * i, du * i);
    return 700;
  },
  /** a loose 3D swarm around the line, the odd one in it */
  swarm(b, c) {
    const n = 6 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const r = R(10, 30);
      const [s, u] = i === 0 ? c.offset(r) : [sign() * R(r + 60, 380), R(-260, 260)];
      c.rock(b, R(-320, 320), s, u, r);
    }
    return 650;
  },
  /** a small moon in your way (or just beside it) */
  moonlet(b, c) {
    const r = R(85, 140);
    c.moon(b, 0, ...c.offset(r), r);
    return 360;
  },
  /** a curtain of rock across your path with one hole: find it */
  belt(b, c) {
    const hs = R(-260, 260), hu = R(-180, 180), hole = R(120, 165) - 30 * c.difficulty;
    for (let s = -700; s <= 700; s += 125) {
      for (let u = -460; u <= 460; u += 125) {
        const js = s + R(-35, 35), ju = u + R(-35, 35);
        if (Math.hypot(js - hs, ju - hu) < hole + 55) continue;
        c.rock(b, R(-40, 40), js, ju, R(38, 60));
      }
    }
    return 780;
  },
  /** a huge moon well off your line: scenery, no gameplay */
  moon(b, c) {
    const r = R(380, 720);
    c.moon(b, R(400, 1600), sign() * R(r + 900, r + 2400), R(-600, 1100), r);
    return 3200;
  },
};
