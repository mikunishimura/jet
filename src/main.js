import { Game } from './game/Game.js';

const game = new Game(document.getElementById('app'));
window.__jet = game;

document.getElementById('start').addEventListener('click', () => game.start());
document.getElementById('restart').addEventListener('click', () => game.start());
document.querySelectorAll('.open-settings').forEach((b) => b.addEventListener('click', () => game.openSettings()));

const best = game.best;
if (best.time) {
  document.getElementById('menu-best').textContent =
    `best · ${(best.dist / 1000).toFixed(2)} km from spawn · ${Math.floor(best.time / 60)}m ${Math.round(best.time % 60)}s · ${best.score?.toLocaleString('en-US')} pts`;
}
