// Feature registry: the extension point for world generation.
//
// A feature is { id, order?, generate(ctx) }. `generate` runs once per chunk
// and adds geometry/colliders/triggers/objects through the ctx API:
//
//   ctx.x0, ctx.z0, ctx.size          absolute chunk bounds (meters)
//   ctx.rng                            deterministic per chunk + feature
//   ctx.biomes                         continuous fields (rocky, ridge, pass...)
//   ctx.rocks                          RockLibrary (ctx.rocks.pick('spire', rng))
//   ctx.isReserved(x, z, r)            spawn zone / launch corridor check
//   ctx.builder.addRock(arch, {...})   faceted rock + matching collider
//   ctx.builder.addGeometry(g, m, c)   merge arbitrary geometry (tunnels, arches)
//   ctx.builder.addCollider(circle()/capsule())
//   ctx.builder.addTrigger({ kind: 'segment', ax, az, bx, bz, onCross(game) })
//   ctx.builder.addObject(obj, x, y, z, update?)  animated / transparent pieces
//
// Ideas that drop straight in: tunnels (arch geometry + two capsule walls),
// waterfalls (cliff rock + animated shader sheet object), floating islands
// (rocks with tiltX and y offset), canyons (two capsule ridges), lakes
// (ground decal object).

const FEATURES = [];

export function registerFeature(feature) {
  if (!feature.id || typeof feature.generate !== 'function') throw new Error('feature needs id + generate');
  const i = FEATURES.findIndex((f) => f.id === feature.id);
  if (i >= 0) FEATURES.splice(i, 1);
  FEATURES.push(feature);
  FEATURES.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
export function unregisterFeature(id) {
  const i = FEATURES.findIndex((f) => f.id === id);
  if (i >= 0) FEATURES.splice(i, 1);
}
export function listFeatures() { return FEATURES; }
