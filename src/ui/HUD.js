// Minimal HUD. DOM: a few floating readouts in ink. Canvas: aim ring, the
// straight-line ring, rounded red target boxes, off-screen chevrons, pickups,
// a hairline altimeter. Palette: ink + grays, red only for hostiles/danger.
import * as THREE from 'three';
import { TIERS, MACH_FACTOR, DEG, WEAPONS, FLIGHT, ALTITUDE, FLAGS, SPACE, THREATS, AIM, HOSTILE } from '../config.js';
import { hostileTop, captureAltitude } from '../game/hostile.js';
import { lockDisplay } from '../combat/Weapons.js';
import { curveDrop } from '../render/curvature.js';
import { DECK_ALTITUDE } from '../world/Clouds.js';

const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _w = new THREE.Vector3();
const INK = '#15171a', INK2 = '#5b6168', RED = '#ff3b30';

export function fmtTime(s) {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}
export const fmtKm = (m) => (m / 1000).toFixed(m < 100000 ? 2 : 1);

/** text bar: [██████░░░░] */
const bar = (f, n) => {
  const k = Math.max(0, Math.min(n, Math.round(f * n)));
  return '█'.repeat(k) + '░'.repeat(n - k);
};
/**
 * Display-only easing for the barrier charge: fills slowly at first, then
 * rushes through the last chunks (exponential). Game logic is untouched.
 */
const CHG_K = 4;
export const chargeDisplay = (c) => (Math.exp(CHG_K * Math.max(0, Math.min(1, c))) - 1) / (Math.exp(CHG_K) - 1);
const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export class HUD {
  constructor(game) {
    this.game = game;
    this.root = $('hud');
    this.canvas = $('overlay');
    this.ctx = this.canvas.getContext('2d');
    this.el = { stats: $('h-stats'), speed: $('h-speed'), hull: $('h-hullbox'), weapons: $('h-weapons'), log: $('log'), big: $('bigtext') };
    this.last = {};
    this.toastTimes = new Map();
    this.numbers = [];                  // live damage numbers: one per enemy, stacking while you hit it
    this.ticker = { value: 0, t: -9, pop: -9, crit: -9, kill: -9 }; // running damage next to the crosshair
    this.hitMark = { t: -9, kill: false };
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.canvas.width = innerWidth * dpr; this.canvas.height = innerHeight * dpr;
  }
  show(on) { this.root.classList.toggle('hidden', !on); }

  /** append a line to the terminal log */
  toast(text, kind = 'info') {
    const now = performance.now();
    if (now - (this.toastTimes.get(text) || 0) < 1500) return;
    this.toastTimes.set(text, now);
    const d = document.createElement('div');
    const danger = kind === 'warn' || kind === 'danger';
    d.innerHTML = `<span class="d">[${fmtTime(this.game.stats?.time || 0)}]</span> <span class="${danger ? 'r' : ''}">${danger ? '!' : '>'} ${esc(text.toLowerCase())}</span>`;
    this.el.log.append(d);
    while (this.el.log.children.length > 5) this.el.log.firstChild.remove();
    setTimeout(() => d.remove(), 3300);
  }
  /** a hit on an enemy: floating number at the hit point (gun hits on one target stack) */
  damageNumber(e, amount, at, kill, source) {
    const now = this.game.time;
    let n = null;
    // one number per enemy: every hit (gun, crit, splash, missile) adds to it while you keep hitting
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const c = this.numbers[i];
      if (c.e === e && !c.kill && now - c.t0 < 0.7) { n = c; break; }
    }
    const crit = source === 'crit';
    if (n) { n.value += amount; n.t0 = now; n.pop = now; n.kill = kill; if (crit) n.crit = now; }
    else {
      this.numbers.push({ e, value: amount, anchor: e.pos.clone(), size: 0, t0: now, born: now, pop: now, kill, crit: crit ? now : -9 });
      if (this.numbers.length > 24) this.numbers.shift();
    }
    // the same hit, right where you're looking: a running total by the crosshair
    const tk = this.ticker;
    if (now - tk.t > 0.9) tk.value = 0;
    tk.value += amount; tk.t = now; tk.pop = now;
    if (crit) tk.crit = now;
    if (kill) tk.kill = now;
    this.hitMark = { t: now, kill: kill || this.hitMark.kill && now - this.hitMark.t < 0.1 };
  }

  slam(t1, t2, down = false) {
    const b = this.el.big;
    b.querySelector('.t1').textContent = t1.toLowerCase();
    b.querySelector('.t2').textContent = `>> ${t2.toLowerCase()}`;
    b.classList.remove('slam', 'down'); void b.offsetWidth;
    b.classList.add('slam'); if (down) b.classList.add('down');
  }
  set(key, html) {
    if (this.last[key] === html) return;
    this.last[key] = html;
    this.el[key].innerHTML = html;
  }

  update() {
    const g = this.game, p = g.player, s = p.speedSys;
    this.set('stats',
      `<span class="d">t+    </span><span class="big">${fmtTime(g.stats.time)}</span>\n` +
      `<span class="d">dist  </span>${fmtKm(g.stats.fromSpawn)} km\n` +
      `<span class="d">kills </span>${g.stats.kills}\n` +
      `<span class="d">pts   </span>${g.score.toLocaleString('en-US')}` +
      (this.showFps ? `\n<span class="d">fps   </span>${Math.round(g.perf.fps)}` : ''));

    // speed block
    const chg = chargeDisplay(s.charge);
    let tiers = '';
    for (let t = 1; t <= TIERS.length; t++) tiers += t <= s.tier ? '█' : '░';
    const next = s.next;
    const tol = s.tolerance / DEG;
    const status = !s.engaged ? 'press w'
      : next ? `${p.throttle || s.tier === 1 ? (s.inWindow ? 'charging' : '<span class="r">off line</span>') : 'hold w'} ±${tol.toFixed(tol < 1 ? 1 : 0)}°`
      : 'max velocity';
    this.set('speed',
      `<span class="big">M${(s.speed * MACH_FACTOR).toFixed(2)}</span> <span class="d">${s.engaged ? s.current.name.toLowerCase() : 'idle'}</span>\n` +
      `<span class="d">tier </span>[${tiers}] ${s.current.roman}\n` +
      `<span class="d">chg  </span>[${bar(chg, 20)}] ${String(Math.round(chg * 100)).padStart(3)}%\n` +
      (g.combo?.stacks ? `<span class="d">cmb  </span>[${bar(g.combo.fill, 20)}] <b>×${g.combo.mult.toFixed(2).replace(/\.?0+$/, '')}</b>\n` : '') +
      `<span class="d">&gt;</span> ${status}<i class="cursor"></i>`);

    // hull
    const hp = Math.ceil(p.health);
    const hb = bar(p.health / 100, 10);
    this.set('hull',
      `<span class="d">hull </span>[${hp < 35 ? `<span class="r">${hb}</span>` : hb}] ${String(hp).padStart(3)}`);

    // weapons
    const w = g.weapons, cm = g.counter;
    const heat = bar(w.heat, 10);
    const msl = '■'.repeat(w.missiles) + '□'.repeat(WEAPONS.missiles.max - w.missiles);
    const flr = '●'.repeat(cm.charges) + '○'.repeat(THREATS.flares.charges - cm.charges);
    let lock;
    if (AIM.autoFire) {
      let best = 0; for (const st of w.lockState.values()) if (!st.locked) best = Math.max(best, st.p);
      lock = best > 0 ? `<span class="r">locking ${Math.round(lockDisplay(best) * 100)}%</span>`
        : w.primary ? `<span class="d">auto · ${w.primary.name.toLowerCase()} ${Math.round(w.primary.dist)} m</span>` : '<span class="d">auto</span>';
    } else if (w.holding) {
      const n = w.lockedTargets().length;
      let best = 0; for (const st of w.lockState.values()) if (!st.locked) best = Math.max(best, st.p);
      lock = `<span class="r">${n ? `${n} locked` : 'tracking'}${best > 0 ? ` ${Math.round(lockDisplay(best) * 100)}%` : ''}</span> <span class="d">· release</span>`;
    } else lock = w.primary ? `<span class="d">hold to lock · ${w.primary.name.toLowerCase()} ${Math.round(w.primary.dist)} m</span>` : '<span class="d">--</span>';
    this.set('weapons',
      `<span class="d">gun  </span>[${w.overheated > 0 ? `<span class="r">${heat}</span>` : heat}]\n` +
      `<span class="d">msl  </span>${msl}\n` +
      `<span class="d">flr  </span>${cm.charges ? flr : `<span class="r">${flr}</span>`} <span class="d">f</span>\n` +
      `<span class="d">lock </span>${lock}`);

    this.drawOverlay();
  }

  project(pos, camera) {
    // apply the same planet curvature the shaders use, so markers sit on their targets
    const drop = curveDrop(pos.x - camera.position.x, pos.z - camera.position.z, pos.y);
    _v.copy(pos); _v.y -= drop; _v.project(camera);
    _c.copy(pos); _c.y -= drop; _c.applyMatrix4(camera.matrixWorldInverse);
    const W = this.canvas.width, H = this.canvas.height;
    return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H, behind: _c.z > 0, depth: -_c.z };
  }

  /** flat stroke: no halo, no glow */
  stroke(ctx, color, width, path) {
    ctx.lineWidth = width * this.dpr; ctx.strokeStyle = color; path(); ctx.stroke();
  }

  drawOverlay() {
    const g = this.game, ctx = this.ctx, cam = g.camera, dpr = this.dpr;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const p = g.player, s = p.speedSys;
    if (!p.alive) return;
    const t = g.time;
    this.frameDt = Math.min(0.1, Math.max(0, t - (this.lastT ?? t))); this.lastT = t;
    const focal = H / (2 * Math.tan((cam.fov * DEG) / 2));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // --- flight-path marker: where the JET is going (circle with wings). Quiet: it's not for shooting
    const fp = this.project(_w.copy(p.pos).addScaledVector(p.forward, 900), cam);
    if (!fp.behind) {
      const r = 5 * dpr;
      ctx.globalAlpha = 0.5;
      this.stroke(ctx, INK2, 1.1, () => {
        ctx.beginPath(); ctx.arc(fp.x, fp.y, r, 0, Math.PI * 2);
        ctx.moveTo(fp.x - r, fp.y); ctx.lineTo(fp.x - r * 2.4, fp.y);
        ctx.moveTo(fp.x + r, fp.y); ctx.lineTo(fp.x + r * 2.4, fp.y);
        ctx.moveTo(fp.x, fp.y - r); ctx.lineTo(fp.x, fp.y - r * 1.8);
      });
      ctx.globalAlpha = 1;
    }
    // --- reticle: where SHOTS go (the mouse). A dot and four short ticks at the
    // radius of the real bullet spread (Bloom): it tightens when the jet is
    // steady and opens up with speed, turns, bank, buffet, recoil and hits.
    // Ink at rest, red while the gun is firing. Everything else around it only
    // appears when it means something.
    const w0 = g.weapons;
    const ap = this.project(w0.aimPoint(_w), cam);
    if (!ap.behind) {
      const bl = g.bloom?.value ?? 0;
      const spread = g.bloom ? g.bloom.spread(WEAPONS.minigun.spread) : WEAPONS.minigun.spread;
      const rT = Math.min(64 * dpr, Math.max(7 * dpr, Math.tan(spread * 3) * focal));
      this.reticleR = this.reticleR === undefined ? rT : this.reticleR + (rT - this.reticleR) * Math.min(1, this.frameDt * 18);
      const r = this.reticleR, tick = (4 + 2 * bl) * dpr;
      const firing = w0.firing, col = firing ? RED : INK;
      const pt = w0.assisted ? w0.primary : null, onCrit = !!pt && pt.aimErr <= WEAPONS.aimQuality.crit;
      ctx.globalAlpha = firing ? 0.9 : 0.6;
      this.stroke(ctx, col, 1.2, () => {
        ctx.beginPath();
        ctx.moveTo(ap.x - r, ap.y); ctx.lineTo(ap.x - r - tick, ap.y);
        ctx.moveTo(ap.x + r, ap.y); ctx.lineTo(ap.x + r + tick, ap.y);
        ctx.moveTo(ap.x, ap.y - r); ctx.lineTo(ap.x, ap.y - r - tick);
        ctx.moveTo(ap.x, ap.y + r); ctx.lineTo(ap.x, ap.y + r + tick);
      });
      ctx.globalAlpha = 1;
      // center dot; on a crit (target dead center, 2x) it grows a thin red ring
      ctx.fillStyle = onCrit ? RED : col;
      ctx.beginPath(); ctx.arc(ap.x, ap.y, (onCrit ? 1.8 : 1.3) * dpr, 0, Math.PI * 2); ctx.fill();
      if (onCrit) this.stroke(ctx, RED, 1, () => { ctx.beginPath(); ctx.arc(ap.x, ap.y, 4 * dpr, 0, Math.PI * 2); });
      // hit marker: short diagonal ticks just outside the reticle (red and longer on a kill)
      const hm = this.hitMark, age = t - hm.t, life = hm.kill ? 0.3 : 0.12;
      if (age >= 0 && age < life) {
        const k = 1 - age / life, r0 = r + 3 * dpr, r1 = r0 + (hm.kill ? 9 : 5) * dpr * (0.6 + 0.4 * k);
        ctx.globalAlpha = Math.min(1, k * 1.6);
        this.stroke(ctx, hm.kill ? RED : INK, hm.kill ? 2 : 1.4, () => {
          ctx.beginPath();
          for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { ctx.moveTo(ap.x + sx * r0 * 0.7071, ap.y + sy * r0 * 0.7071); ctx.lineTo(ap.x + sx * r1 * 0.7071, ap.y + sy * r1 * 0.7071); }
        });
        ctx.globalAlpha = 1;
      }
      // gun cone: only a faint dotted hint while an enemy is getting close to it (gone once firing)
      if (!firing) {
        let near = Infinity;
        for (const e of w0.detected) if (e.dist < WEAPONS.minigun.range * 1.05) near = Math.min(near, e.aimErr ?? Infinity);
        const cone = AIM.assistCone, k = 1 - (near - cone) / (cone * 0.8);
        if (k > 0 && near < Infinity) {
          ctx.globalAlpha = 0.22 * Math.min(1, k);
          ctx.setLineDash([1.5 * dpr, 5 * dpr]);
          this.stroke(ctx, INK2, 1, () => { ctx.beginPath(); ctx.arc(ap.x, ap.y, Math.tan(cone) * focal, 0, Math.PI * 2); });
          ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
      }
      // the lock ring only while a lock is building
      let building = 0; for (const st of w0.lockState.values()) if (!st.locked) building = Math.max(building, st.p);
      if (building > 0) {
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([3 * dpr, 4 * dpr]);
        this.stroke(ctx, RED, 1, () => { ctx.beginPath(); ctx.arc(ap.x, ap.y, Math.tan(AIM.autoAim ? WEAPONS.lock.autoMargin : WEAPONS.lock.margin) * focal, 0, Math.PI * 2); });
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
    // hint until the mouse is captured
    if (g.state === 'playing' && !g.attract && !g.useAutopilot && !g.input.locked && !g.touch?.enabled) {
      ctx.save(); ctx.textAlign = 'center';
      this.label(ctx, '> click to aim with the mouse', W / 2, H * 0.7, INK2);
      ctx.restore();
    }
    // --- straight-line ring: the reference line; size = tolerance window
    if (s.engaged && s.next) {
      const ch = Math.cos(s.refPitch);
      _c.set(-Math.sin(s.refHeading) * ch, Math.sin(s.refPitch), -Math.cos(s.refHeading) * ch);
      const ref = this.project(_w.copy(p.pos).addScaledVector(_c, 900), cam);
      if (!ref.behind) {
        const rad = Math.max(16 * dpr, Math.tan(s.tolerance) * focal * 0.98);
        ctx.setLineDash(s.inWindow ? [] : [4 * dpr, 5 * dpr]);
        ctx.globalAlpha = g.weapons.firing ? 0.3 : 0.55;   // steps back while you're shooting
        this.stroke(ctx, s.inWindow ? INK : RED, 1, () => { ctx.beginPath(); ctx.arc(ref.x, ref.y, rad, 0, Math.PI * 2); });
        ctx.setLineDash([]);
        // barrier charge as an arc around the ring
        const chg = chargeDisplay(s.charge);
        if (chg > 0.005) this.stroke(ctx, INK, 2, () => { ctx.beginPath(); ctx.arc(ref.x, ref.y, rad + 4 * dpr, -Math.PI / 2, -Math.PI / 2 + chg * Math.PI * 2); });
        ctx.globalAlpha = 1;
      }
    }

    // --- pickups: ink circle with a plus
    for (const it of g.pickups.list) {
      const pr = this.project(it.pos, cam);
      if (pr.behind) continue;
      const r = 9 * dpr;
      this.stroke(ctx, INK, 1.5, () => {
        ctx.beginPath(); ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2);
        ctx.moveTo(pr.x - r * 0.5, pr.y); ctx.lineTo(pr.x + r * 0.5, pr.y);
        ctx.moveTo(pr.x, pr.y - r * 0.5); ctx.lineTo(pr.x, pr.y + r * 0.5);
      });
      this.label(ctx, `${Math.round(it.pos.distanceTo(p.pos))} m`, pr.x + r + 4 * dpr, pr.y + 4 * dpr, INK2);
    }

    // --- incoming missiles: marker on the missile + the threat warning (sharpens with time to impact)
    for (const m of g.projectiles.missiles) {
      if (m.owner !== 'enemy') continue;
      const th = g.counter.threats.find((x) => x.m === m);
      const lv = th ? th.level : 0;
      const pr = this.project(m.p, cam);
      if (pr.behind) { if (!th) this.edgeChevron(ctx, m.p, cam, W, H); continue; }
      if (m.decoy) { // pulled off by a flare: a calm gray marker
        const k = 5 * dpr;
        this.stroke(ctx, INK2, 1.2, () => { ctx.beginPath(); ctx.moveTo(pr.x, pr.y - k); ctx.lineTo(pr.x + k, pr.y + k * 0.8); ctx.lineTo(pr.x - k, pr.y + k * 0.8); ctx.closePath(); });
        continue;
      }
      if (lv < 0.8 && Math.sin(t * (14 + 30 * lv)) < -0.3) continue;
      const k = (7 + 9 * lv) * dpr;
      this.stroke(ctx, RED, 1.8 + 1.4 * lv, () => { ctx.beginPath(); ctx.moveTo(pr.x, pr.y - k); ctx.lineTo(pr.x + k, pr.y + k * 0.8); ctx.lineTo(pr.x - k, pr.y + k * 0.8); ctx.closePath(); });
      if (th && th === g.counter.worst) this.label(ctx, `${th.tti.toFixed(1)}s`, pr.x + k + 4 * dpr, pr.y + 4 * dpr, RED);
    }
    this.drawThreats(ctx, W, H, dpr, t);
    this.drawBreakers(ctx, cam, W, H, dpr, focal, t);

    const w = g.weapons;
    // the enemy you're aiming at but the gun can't reach yet: it gets a TOO FAR tag
    let tooFar = null;
    for (const e of w.detected) {
      if (e.dist > WEAPONS.minigun.range * 1.05 && (e.aimErr ?? Infinity) < AIM.assistCone && (!tooFar || e.aimErr < tooFar.aimErr)) tooFar = e;
    }
    // --- detection: thin red corner brackets (bolder on what the gun is working on)
    for (const e of w.detected) {
      const pr = this.project(e.pos, cam);
      if (pr.behind || pr.x < 0 || pr.x > W || pr.y < 0 || pr.y > H) { this.edgeChevron(ctx, e.pos, cam, W, H); continue; }
      const size = Math.max(11 * dpr, (e.radius * 1.5 * focal) / Math.max(1, pr.depth));
      const locked = w.locks.includes(e), primary = w.primary === e;
      // a kill missile is on its way: say so (the gun leaves it to the missile meanwhile)
      if (w.doomed.has(e)) { ctx.save(); ctx.textAlign = 'center'; this.label(ctx, '◆ kill missile', pr.x, pr.y - size - 12 * dpr, RED); ctx.restore(); }
      // aimed at, but beyond gun range: a small tag on top of it
      else if (e === tooFar) {
        ctx.save(); ctx.textAlign = 'center';
        ctx.font = `700 ${10 * dpr}px "JetBrains Mono", monospace`;
        const ty = pr.y - size - 10 * dpr;
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#fff'; ctx.strokeText('TOO FAR', pr.x, ty);
        ctx.fillStyle = RED; ctx.fillText('TOO FAR', pr.x, ty);
        ctx.restore();
      }
      const engaged = w.targets.includes(e), cl = Math.max(3 * dpr, size * 0.35);
      ctx.globalAlpha = engaged || primary ? 0.95 : 0.55;
      this.stroke(ctx, RED, engaged ? 1.7 : 1.1, () => {
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const cx = pr.x + sx * size, cy = pr.y + sy * size;
          ctx.moveTo(cx - sx * cl, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy - sy * cl);
        }
      });
      ctx.globalAlpha = 1;
      if (primary) { ctx.globalAlpha = 0.7; this.label(ctx, `${Math.round(e.dist)} m`, pr.x - size, pr.y + size + 12 * dpr, RED); ctx.globalAlpha = 1; }
      // hp bar (once it's been hit): what's left (red), what you just took off (ink, drains after it)
      const hpK = Math.max(0, e.hp / e.maxHp);
      e.hpGhost = e.hpGhost === undefined ? hpK : Math.max(hpK, e.hpGhost - this.frameDt * 0.9);
      if (e.hpGhost < 0.999) {
        const by = pr.y - size - 5 * dpr, bh = 2 * dpr;
        ctx.fillStyle = 'rgba(255,59,48,0.18)'; ctx.fillRect(pr.x - size, by, size * 2, bh);
        ctx.fillStyle = INK; ctx.fillRect(pr.x - size, by, size * 2 * e.hpGhost, bh);
        ctx.fillStyle = RED; ctx.fillRect(pr.x - size, by, size * 2 * hpK, bh);
      }
      // missile lock-on ring: charges around the target while you track it (slow, then fast)
      const ls = w.lockState.get(e);
      if (ls) {
        const R = size * 1.25 + 10 * dpr;
        if (ls.locked) {
          this.stroke(ctx, RED, 1.8, () => { ctx.beginPath(); ctx.arc(pr.x, pr.y, R, 0, Math.PI * 2); });
          ctx.save(); ctx.textAlign = 'center'; this.label(ctx, 'lock', pr.x, pr.y - R - 7 * dpr, RED); ctx.restore();
        } else {
          const f = lockDisplay(ls.p);
          ctx.globalAlpha = 0.3;
          this.stroke(ctx, RED, 1, () => { ctx.beginPath(); ctx.arc(pr.x, pr.y, R, 0, Math.PI * 2); });
          ctx.globalAlpha = ls.out > 0 ? 0.55 : 1;
          // solid: a precise lock so far (kill missile); dashed: loose (it may dodge)
          if ((ls.meanErr ?? 0) > WEAPONS.lock.precise) ctx.setLineDash([5 * dpr, 4 * dpr]);
          if (f > 0.003) this.stroke(ctx, RED, 2, () => { ctx.beginPath(); ctx.arc(pr.x, pr.y, R, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); });
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
    }
    this.drawNumbers(ctx, cam, dpr, t, focal);
    this.drawTicker(ctx, ap, dpr, t);

    this.drawAltimeter(ctx, W, H, dpr);
  }

  /**
   * Live damage numbers: one per enemy, sitting just above its box (clear of
   * the box, lock ring and hp bar) and growing with every hit while you keep
   * firing; red with "!" right after a crit. When you stop (or it dies) it
   * floats up and fades; a kill shows the total with ✕.
   */
  drawNumbers(ctx, cam, dpr, t, focal) {
    ctx.save(); ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      const age = t - n.t0, life = n.kill ? 1.2 : 0.8;
      if (age > life || age < -1) { this.numbers.splice(i, 1); continue; }
      if (n.e.alive) n.anchor.copy(n.e.pos);
      const pr = this.project(n.anchor, cam);
      if (pr.behind) continue;
      if (n.e.alive) n.size = Math.max(11 * dpr, (n.e.radius * 1.5 * focal) / Math.max(1, pr.depth));
      const pop = 1 + 0.55 * Math.exp(-(t - n.pop) * 18);
      const crit = t - n.crit < 0.35;
      const px = (n.kill ? 24 : 17 + Math.min(9, n.value / 15)) * pop * (crit ? 1.15 : 1) * dpr;
      const rise = Math.max(0, age - 0.2) * 40 * dpr;          // holds still while hits keep coming
      const y = pr.y - n.size - 14 * dpr - rise;
      ctx.globalAlpha = Math.min(1, (life - age) / (life * 0.45));
      ctx.font = `800 ${px}px "JetBrains Mono", monospace`;
      const txt = `${Math.round(n.value)}${n.kill ? ' ✕' : crit ? '!' : ''}`;
      ctx.lineWidth = 4 * dpr; ctx.strokeStyle = '#fff'; ctx.strokeText(txt, pr.x, y);
      ctx.fillStyle = n.kill || crit ? RED : INK; ctx.fillText(txt, pr.x, y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** running damage total by the crosshair: where your eyes are */
  drawTicker(ctx, ap, dpr, t) {
    const tk = this.ticker, age = t - tk.t;
    if (age > 0.9 || tk.value <= 0 || ap.behind) return;
    const pop = 1 + 0.5 * Math.exp(-(t - tk.pop) * 20);
    const hot = t - tk.crit < 0.3 || t - tk.kill < 0.5;
    ctx.save(); ctx.textAlign = 'left'; ctx.lineJoin = 'round';
    ctx.globalAlpha = Math.min(1, (0.9 - age) / 0.3);
    ctx.font = `800 ${13 * pop * dpr}px "JetBrains Mono", monospace`;
    const off = (this.reticleR ?? 8 * dpr) + 10 * dpr;   // just outside the reticle, whatever its size
    const txt = `+${Math.round(tk.value)}`, x = ap.x + off, y = ap.y - off * 0.6;
    ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = '#fff'; ctx.strokeText(txt, x, y);
    ctx.fillStyle = hot ? RED : INK; ctx.fillText(txt, x, y);
    ctx.restore();
  }

  /**
   * Incoming-missile warning, per threat (closest impacts first): a red arc on
   * a ring around the screen center pointing at the missile, with a glow
   * creeping in from that screen edge. Arc length, weight and blink rate grow
   * as the time to impact shrinks; under THREATS.breakAt the center calls it.
   */
  drawThreats(ctx, W, H, dpr, t) {
    const g = this.game, cam = g.camera, list = g.counter.threats;
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36;
    for (let i = 0; i < Math.min(3, list.length); i++) {
      const th = list[i], lv = th.level;
      if (lv <= 0) continue;
      _c.copy(th.m.p).applyMatrix4(cam.matrixWorldInverse);
      let ax = _c.x, ay = -_c.y;
      if (Math.hypot(ax, ay) < 1e-3) ay = 1;
      const ang = Math.atan2(ay, ax);
      const blinkOn = lv > 0.85 || Math.sin(t * Math.PI * 2 * (1.5 + 9 * lv)) > -0.25;
      // edge glow from the missile's side
      const ex = cx + Math.cos(ang) * W * 0.6, ey = cy + Math.sin(ang) * H * 0.6;
      const grd = ctx.createRadialGradient(ex, ey, 0, ex, ey, H * (0.35 + 0.35 * lv));
      grd.addColorStop(0, `rgba(255,59,48,${0.32 * lv * lv})`); grd.addColorStop(1, 'rgba(255,59,48,0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
      if (!blinkOn) continue;
      const half = 0.1 + 0.32 * lv;
      this.stroke(ctx, RED, 2 + 7 * lv * lv, () => { ctx.beginPath(); ctx.arc(cx, cy, R, ang - half, ang + half); });
      // arrowhead pointing outward, toward the missile
      const tx = cx + Math.cos(ang) * (R + (12 + 10 * lv) * dpr), ty = cy + Math.sin(ang) * (R + (12 + 10 * lv) * dpr);
      const k = (6 + 6 * lv) * dpr;
      ctx.save(); ctx.translate(tx, ty); ctx.rotate(ang);
      ctx.fillStyle = RED; ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(-k * 0.6, k * 0.8); ctx.lineTo(-k * 0.6, -k * 0.8); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (i === 0) { // only the closest impact is labeled (several from one side would overprint)
        ctx.save(); ctx.textAlign = 'center';
        this.label(ctx, `${th.tti.toFixed(1)}s`, cx + Math.cos(ang) * (R - 16 * dpr), cy + Math.sin(ang) * (R - 16 * dpr) + 4 * dpr, RED);
        ctx.restore();
      }
    }
    if (g.counter.breakCall && Math.sin(t * 38) > -0.4) {
      ctx.save(); ctx.textAlign = 'center';
      ctx.font = `700 ${22 * dpr}px "JetBrains Mono", monospace`;
      const txt = g.counter.charges > 0 ? '◀ break · turn hard ▶  (f flares)' : '◀ break · turn hard ▶';
      ctx.lineWidth = 4 * dpr; ctx.strokeStyle = '#fff'; ctx.strokeText(txt, cx, H * 0.2);
      ctx.fillStyle = RED; ctx.fillText(txt, cx, H * 0.2); // above the mach slam banner
      ctx.restore();
    }
  }

  label(ctx, text, x, y, color) {
    const dpr = this.dpr;
    ctx.font = `500 ${10.5 * dpr}px "JetBrains Mono", monospace`;
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  edgeChevron(ctx, pos, cam, W, H) {
    _c.copy(pos).applyMatrix4(cam.matrixWorldInverse);
    let ax = _c.x, ay = -_c.y;
    if (_c.z > 0 && Math.abs(ax) < 1e-3) ax = 1;
    const len = Math.hypot(ax, ay) || 1;
    ax /= len; ay /= len;
    const margin = 34 * this.dpr;
    const sx = Math.abs(ax) > 1e-3 ? (W / 2 - margin) / Math.abs(ax) : Infinity;
    const sy = Math.abs(ay) > 1e-3 ? (H / 2 - margin) / Math.abs(ay) : Infinity;
    const k = Math.min(sx, sy);
    const x = W / 2 + ax * k, y = H / 2 + ay * k;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(ay, ax));
    const s = 7 * this.dpr;
    this.stroke(ctx, RED, 2, () => { ctx.beginPath(); ctx.moveTo(-s * 0.6, -s); ctx.lineTo(s * 0.4, 0); ctx.lineTo(-s * 0.6, s); });
    ctx.restore();
  }

  /** line breakers: red corner brackets + time to contact (off screen: an edge chevron) */
  drawBreakers(ctx, cam, W, H, dpr, focal, t) {
    const g = this.game, p = g.player, o = g.world.origin;
    for (const b of g.hazards.breakers) {
      _w.set(b.x - o.x, b.y, b.z - o.z);
      const pr = this.project(_w, cam);
      if (pr.behind || pr.x < 0 || pr.x > W || pr.y < 0 || pr.y > H) { this.edgeChevron(ctx, _w, cam, W, H); continue; }
      const dist = _w.distanceTo(p.pos), ttc = dist / Math.max(1, p.speed);
      const size = Math.max(14 * dpr, (b.r * focal) / Math.max(1, pr.depth)) + 6 * dpr;
      const k = Math.min(size * 0.4, 12 * dpr), urgent = ttc < 1.2;
      if (urgent && Math.sin(t * 30) < -0.2) continue;   // ~5 Hz blink in the last second
      this.stroke(ctx, RED, urgent ? 2.4 : 1.6, () => {
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const cx = pr.x + sx * size, cy = pr.y + sy * size;
          ctx.moveTo(cx - sx * k, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy - sy * k);
        }
      });
      ctx.save(); ctx.textAlign = 'left';
      this.label(ctx, `${ttc.toFixed(1)}s`, pr.x + size + 5 * dpr, pr.y + 4 * dpr, RED);
      ctx.restore();
    }
  }

  drawAltimeter(ctx, W, H, dpr) {
    const p = this.game.player;
    const alt = Math.max(0, p.pos.y);
    const x = W - 30 * dpr, top = H * 0.34, bot = H * 0.66, max = FLIGHT.ceiling;
    // log scale: the low band (ground effect, obstacles) stays readable under a 24 km ceiling
    const L = (a) => Math.log(1 + Math.max(0, a) / 40);
    const yOf = (a) => bot - (L(Math.min(a, max)) / L(max)) * (bot - top);
    ctx.save();
    // hairline scale + band segments (ink = ground effect, red = radar)
    this.stroke(ctx, 'rgba(21,23,26,0.35)', 1, () => { ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); });
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = INK; ctx.beginPath(); ctx.moveTo(x, yOf(0)); ctx.lineTo(x, yOf(ALTITUDE.groundEffect)); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,59,48,0.6)'; ctx.beginPath(); ctx.moveTo(x, yOf(ALTITUDE.radar)); ctx.lineTo(x, yOf(FLAGS.space ? SPACE.edge : max)); ctx.stroke();
    // space flight: Kármán line tick, the orbit band drawn ink (no radar up there)
    const space = FLAGS.space;
    const yk = yOf(SPACE.edge);
    if (space) {
      ctx.strokeStyle = INK; ctx.beginPath(); ctx.moveTo(x, yk); ctx.lineTo(x, yOf(max)); ctx.stroke();
      this.stroke(ctx, INK2, 1, () => { ctx.beginPath(); ctx.moveTo(x - 5 * dpr, yk); ctx.lineTo(x + 5 * dpr, yk); });
    }
    // hostile band: a heavy red bar where gravity drags you down; the capture
    // line (space flight) marks where orbit takes over and pulls you up
    const yc = yOf(Math.min(captureAltitude(), hostileTop()));
    ctx.lineWidth = 6 * dpr; ctx.strokeStyle = RED;
    ctx.beginPath(); ctx.moveTo(x, yOf(HOSTILE.floor)); ctx.lineTo(x, yc); ctx.stroke();
    if (space) this.stroke(ctx, RED, 1.5, () => { ctx.beginPath(); ctx.moveTo(x - 7 * dpr, yc); ctx.lineTo(x + 7 * dpr, yc); });
    // cloud deck tick
    const yd = yOf(DECK_ALTITUDE);
    this.stroke(ctx, INK2, 1, () => { ctx.beginPath(); ctx.moveTo(x - 5 * dpr, yd); ctx.lineTo(x + 5 * dpr, yd); });
    const y = yOf(alt);
    ctx.textAlign = 'right';
    if (Math.abs(y - yd) > 26 * dpr) this.label(ctx, 'clouds', x - 15 * dpr, yd + 4 * dpr, INK2); // hide when the readout is there
    if (space && Math.abs(y - yk) > 26 * dpr) this.label(ctx, 'kármán', x - 15 * dpr, yk + 4 * dpr, INK2);
    if (space && Math.abs(y - yc) > 26 * dpr && Math.abs(yc - yk) > 12 * dpr) this.label(ctx, 'escape', x - 15 * dpr, yc + 4 * dpr, RED);
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.moveTo(x - 4 * dpr, y); ctx.lineTo(x - 11 * dpr, y - 4.5 * dpr); ctx.lineTo(x - 11 * dpr, y + 4.5 * dpr); ctx.closePath(); ctx.fill();
    ctx.textAlign = 'right';
    const band = p.band;
    const hz = p.hostile?.t > 0 ? (p.hostile.capture ? 'orbit capture ↑' : 'gravity well ↓') : null;
    this.label(ctx, alt >= 1000 ? `${(alt / 1000).toFixed(1)} km` : `${Math.round(alt)} m`, x - 15 * dpr, y + 4 * dpr, band === 'high' ? RED : INK);
    if (hz) this.label(ctx, hz, x - 15 * dpr, y + 17 * dpr, RED);
    else if (band !== 'mid') this.label(ctx, { low: 'ground effect', high: 'radar', space: 'orbit' }[band], x - 15 * dpr, y + 17 * dpr, band === 'high' ? RED : INK2);
    ctx.restore();
  }
}
