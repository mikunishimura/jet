import test from 'node:test';
import assert from 'node:assert/strict';
import { circle, capsule, contact, isHardHit, deflect, centrality } from '../src/game/Collision.js';

test('head-on into a rock center is a hard hit', () => {
  const c = circle(0, -100, 50);
  const hit = contact(c, 0, 20, -46, 7); // player just inside, flying -z
  assert.ok(hit);
  assert.ok(isHardHit(0, -1, hit.nx, hit.nz));
});

test('clipping the edge of a rock is not a hard hit and deflects', () => {
  const c = circle(0, -100, 50);
  const px = 52, pz = -100 + 20; // touching right flank, flying -z
  const hit = contact(c, px, 20, pz, 7);
  assert.ok(hit);
  assert.ok(!isHardHit(0, -1, hit.nx, hit.nz), `centrality ${centrality(0, -1, hit.nx, hit.nz)}`);
  const [fx, fz] = deflect(0, -1, hit.nx, hit.nz);
  assert.ok(fx > 0, 'pushed outward to the right');
  assert.ok(Math.abs(Math.hypot(fx, fz) - 1) < 1e-9);
});

test('flying over a short rock is free', () => {
  const c = circle(0, 0, 50, 10);
  assert.equal(contact(c, 0, 26, 0, 7), null);
});

test('capsule wall: head-on is hard, parallel scrape is soft', () => {
  const w = capsule(-200, 0, 200, 0, 10);
  const head = contact(w, 0, 0, 12, 7);
  assert.ok(head && isHardHit(0, -1, head.nx, head.nz));
  const scrape = contact(w, 0, 0, 12, 7);
  assert.ok(!isHardHit(-0.98, -0.2, scrape.nx, scrape.nz));
});
