// Builds public/climate-zones.json from src/data/climateZones.json: one dissolved shape per
// climate zone (Natural Earth admin-1 regions merged), the lines where two zones of a country
// meet, and each zone's representative city with the exact coordinates the app already stores
// for it (from destinations.json, gateway-destinations.json or direct-cities.json).
//
// The browser clips zone shapes to the country outline it is drawing, so coastlines stay those
// of the active level of detail and the shapes here can be simplified hard.
//
// Input: Natural Earth 1:10m admin-1 GeoJSON, e.g.
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
// Usage: npm run climate-zones -- ne_10m_admin_1_states_provinces.geojson
import { readFileSync, writeFileSync } from 'node:fs';
import { merge, mesh } from 'topojson-client';
import { topology } from 'topojson-server';
import { presimplify, simplify as simplifyTopo } from 'topojson-simplify';

const src = process.argv[2];
if (!src) {
  console.error('Usage: npm run climate-zones -- <ne_10m_admin_1_states_provinces.geojson>');
  process.exit(1);
}
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const { zones, areas = [] } = readJson('../src/data/climateZones.json');

// Representative cities: the point the map and the seeder already use for that place.
const places = [
  ...readJson('../public/destinations.json'),
  ...readJson('../public/gateway-destinations.json').destinations,
  ...readJson('../public/direct-cities.json').cities,
];
const problems = [];
const cityOf = (z) => {
  // A city the app has no place for (Ambon) gives its own coordinates; the seeder stores it anyway.
  if (z.cityAt) return { name: z.city, lat: z.cityAt[0], lon: z.cityAt[1] };
  const p = places.find((x) => x.name === z.city && x.cc === z.cc);
  if (!p) problems.push(`${z.id}: no place named "${z.city}" in ${z.cc}`);
  return p ? { name: p.name, lat: p.lat, lon: p.lon } : null;
};

// Which zone each admin-1 region belongs to: listed codes first, then the country's default.
// A region too big for one zone (Queensland) is cut along a latitude or longitude: each zone
// lists the part it takes as { admin1, northOf | southOf | eastOf | westOf }.
const byCode = new Map();
const parts = new Map(); // code → [{ zone, northOf? | southOf? | eastOf? | westOf? }]
const defaults = new Map();
for (const z of zones) {
  for (const c of z.admin1) {
    if (byCode.has(c)) problems.push(`${c} is in both ${byCode.get(c)} and ${z.id}`);
    byCode.set(c, z.id);
  }
  for (const part of z.parts ?? []) parts.set(part.admin1, [...(parts.get(part.admin1) ?? []), { ...part, zone: z.id }]);
  if (z.default) {
    if (defaults.has(z.cc)) problems.push(`${z.cc} has two default zones`);
    defaults.set(z.cc, z.id);
  }
}
const ccs = new Set(zones.map((z) => z.cc));
for (const cc of ccs) if (!defaults.has(cc)) problems.push(`${cc} has no default zone`);

/** A part's cut as the axis (0 longitude, 1 latitude), the line, and which side is kept. */
const cutOf = (part) =>
  part.northOf !== undefined ? { axis: 1, at: part.northOf, above: true }
  : part.southOf !== undefined ? { axis: 1, at: part.southOf, above: false }
  : part.eastOf !== undefined ? { axis: 0, at: part.eastOf, above: true }
  : { axis: 0, at: part.westOf, above: false };

/**
 * The part of a polygon ring on one side of a latitude or longitude line (Sutherland–Hodgman
 * against one line). Crossing points are computed from the segment's endpoints in a fixed order,
 * so both halves get exactly the same points and the topology sees one shared border.
 */
const clipRing = (ring, { axis, at, above }) => {
  const other = 1 - axis;
  const inside = (p) => (above ? p[axis] >= at : p[axis] < at);
  const cross = (a, b) => {
    const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
    const pt = [];
    pt[axis] = at;
    pt[other] = p[other] + ((at - p[axis]) * (q[other] - p[other])) / (q[axis] - p[axis]);
    return pt;
  };
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) out.push(cross(a, b));
  }
  if (out.length < 3) return null;
  out.push(out[0]);
  return out;
};
const clipGeometry = (g, cut) => {
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)
    .map((poly) => poly.map((r) => clipRing(r, cut)).filter(Boolean))
    .filter((poly) => poly.length);
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
};

const regions = { type: 'FeatureCollection', features: [] };
const seenCodes = new Set();
const areaCodes = new Set(areas.flatMap((a) => a.parts.map((x) => x.admin1)));
const rawByCode = new Map(); // admin-1 shapes the areas need
for (const f of JSON.parse(readFileSync(src, 'utf8')).features) {
  const p = f.properties;
  if (areaCodes.has(p.iso_3166_2)) rawByCode.set(p.iso_3166_2, [...(rawByCode.get(p.iso_3166_2) ?? []), f.geometry]);
  if (!ccs.has(p.iso_a2)) continue;
  seenCodes.add(p.iso_3166_2);
  const add = (zone, geometry) => geometry && regions.features.push({ type: 'Feature', properties: { zone, cc: p.iso_a2 }, geometry });
  const cut = parts.get(p.iso_3166_2);
  if (cut) {
    for (const part of cut) add(part.zone, clipGeometry(f.geometry, cutOf(part)));
    continue;
  }
  // Raw shapes: neighbouring regions must share exact borders for the topology to dissolve them.
  add(byCode.get(p.iso_3166_2) ?? defaults.get(p.iso_a2), f.geometry);
}
for (const c of [...byCode.keys(), ...parts.keys()]) if (!seenCodes.has(c)) problems.push(`${c} not found in Natural Earth`);
for (const [c, ps] of parts) {
  const [a, b] = ps.map(cutOf);
  if (ps.length !== 2 || a.axis !== b.axis || a.at !== b.at || a.above === b.above) problems.push(`${c} must be cut once, with matching sides of one line (northOf/southOf or eastOf/westOf)`);
}

// Dissolve regions into zones and find shared zone borders with a shared-arc topology.
// Simplify the shared arcs (zone borders stay shared, so no slivers); minimum area in
// square degrees (about 25 km²; smaller islets drop out and take the capital zone's colour):
// coastline detail is the country outline's job.
const pre = presimplify(topology({ regions }, 1e5));
// Borders shared by two regions are inland, where the zone fill is all that shows, so they are
// simplified forty times harder than coastlines (which keep small islands).
const uses = new Map();
const walk = (a) => (Array.isArray(a) ? a.forEach(walk) : uses.set(a < 0 ? ~a : a, (uses.get(a < 0 ? ~a : a) ?? 0) + 1));
pre.objects.regions.geometries.forEach((g) => walk(g.arcs));
pre.arcs.forEach((arc, i) => {
  if ((uses.get(i) ?? 0) > 1) for (const pt of arc) if (Number.isFinite(pt[2])) pt[2] /= 40;
});
const topo = simplifyTopo(pre, 0.002);
const geoms = topo.objects.regions.geometries;
const features = [];
for (const z of zones) {
  const mine = geoms.filter((g) => g.properties.zone === z.id);
  if (!mine.length) {
    problems.push(`${z.id} has no regions`);
    continue;
  }
  features.push({
    type: 'Feature',
    properties: { kind: 'zone', id: z.id, cc: z.cc, name: z.name, places: z.places, city: cityOf(z) },
    geometry: merge(topo, mine),
  });
}
for (const cc of ccs) {
  const edges = mesh(topo, topo.objects.regions, (a, b) => a !== b && a.properties.cc === cc && b.properties.cc === cc && a.properties.zone !== b.properties.zone);
  features.push({ type: 'Feature', properties: { kind: 'edge', cc }, geometry: edges });
}

// Areas: parts of a zone that only monsoon footprints use (western Hokkaido for the Sea of Japan
// winter snow), so a footprint can cover part of a zone without splitting its rating.
const areaFc = { type: 'FeatureCollection', features: [] };
for (const a of areas) {
  if (!zones.some((z) => z.id === a.zone)) problems.push(`area ${a.id}: no zone ${a.zone}`);
  for (const part of a.parts) {
    const raw = rawByCode.get(part.admin1);
    if (!raw) problems.push(`area ${a.id}: ${part.admin1} not found in Natural Earth`);
    for (const g of raw ?? []) {
      const geometry = clipGeometry(g, cutOf(part));
      if (geometry) areaFc.features.push({ type: 'Feature', properties: { area: a.id }, geometry });
    }
  }
}
if (areas.length) {
  const atopo = simplifyTopo(presimplify(topology({ areas: areaFc }, 1e5)), 0.002);
  for (const a of areas) {
    const mine = atopo.objects.areas.geometries.filter((g) => g.properties.area === a.id);
    if (mine.length) features.push({ type: 'Feature', properties: { kind: 'area', id: a.id, cc: a.cc, zone: a.zone, name: a.name }, geometry: merge(atopo, mine) });
    else problems.push(`area ${a.id} has no shape`);
  }
}

if (problems.length) {
  console.error(`Problems:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
// Merged output comes back with long floats: round again to 0.01°.
const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v.map(r2));
const dedupe = (line) => line.filter((p, i) => i === 0 || p[0] !== line[i - 1][0] || p[1] !== line[i - 1][1]);
for (const f of features) {
  const g = f.geometry;
  g.coordinates = r2(g.coordinates);
  if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map((poly) => poly.map(dedupe).filter((r) => r.length >= 4)).filter((poly) => poly.length);
  else if (g.type === 'MultiLineString') g.coordinates = g.coordinates.map(dedupe).filter((l) => l.length >= 2);
}
const out = JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(new URL('../public/climate-zones.json', import.meta.url), out);
console.log(`Wrote ${zones.length} zones and ${areas.length} area${areas.length === 1 ? "" : "s"} in ${ccs.size} countries (${Math.round(out.length / 1024)} KB) to public/climate-zones.json`);
