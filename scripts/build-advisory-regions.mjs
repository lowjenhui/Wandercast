// Builds public/advisory-regions.json: the Natural Earth admin-1 shapes (states, provinces) that
// src/data/advisoryZones.json and src/data/insurers.json refer to, and nothing else, so the
// browser can place a destination inside an advised region without a 40 MB download.
//
// Input: Natural Earth 1:10m admin-1 GeoJSON, e.g.
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
// Usage: npm run advisory-regions -- ne_10m_admin_1_states_provinces.geojson
// Rerun after adding admin1 codes or regions to either file.
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) {
  console.error('Usage: npm run advisory-regions -- <ne_10m_admin_1_states_provinces.geojson>');
  process.exit(1);
}

const zones = JSON.parse(readFileSync(new URL('../src/data/advisoryZones.json', import.meta.url), 'utf8'));
const insurers = JSON.parse(readFileSync(new URL('../src/data/insurers.json', import.meta.url), 'utf8'));

const codes = new Set();
const regions = new Set(); // `${cc}|${region}`
for (const [slug, entry] of Object.entries(zones)) {
  if (slug === '_readme') continue;
  for (const z of entry.zones) {
    if (z.area.kind !== 'admin1') continue;
    for (const c of z.area.codes ?? []) codes.add(c);
    for (const r of z.area.regions ?? []) regions.add(`${entry.cc}|${r}`);
  }
}
for (const ins of Object.values(insurers)) for (const r of ins.excludedRegions) for (const c of r.codes) codes.add(c);

// Drop points closer than ~1 km to the last kept one, and round to 0.001° (~100 m).
const TOL = 0.01;
const ring = (pts) => {
  const out = [];
  for (const [x, y] of pts) {
    const p = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > TOL || Math.abs(last[1] - p[1]) > TOL) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && (first[0] !== last[0] || first[1] !== last[1])) out.push(first);
  return out.length >= 4 ? out : null;
};
const simplify = (g) => {
  if (g.type === 'Polygon') {
    const rings = g.coordinates.map(ring).filter(Boolean);
    return rings.length ? { type: 'Polygon', coordinates: rings } : null;
  }
  const polys = g.coordinates.map((p) => p.map(ring).filter(Boolean)).filter((p) => p.length);
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
};

const features = [];
const found = new Set();
for (const f of JSON.parse(readFileSync(src, 'utf8')).features) {
  const p = f.properties;
  const byRegion = regions.has(`${p.iso_a2}|${p.region}`);
  if (!codes.has(p.iso_3166_2) && !byRegion) continue;
  const geometry = simplify(f.geometry);
  if (!geometry) continue;
  found.add(p.iso_3166_2);
  if (byRegion) found.add(`${p.iso_a2}|${p.region}`);
  features.push({ type: 'Feature', properties: { code: p.iso_3166_2, name: p.name, cc: p.iso_a2, region: p.region ?? null }, geometry });
}

const missing = [...codes, ...regions].filter((k) => !found.has(k));
if (missing.length) console.warn(`Not found in Natural Earth (check the codes or region names): ${missing.join(', ')}`);
const out = JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(new URL('../public/advisory-regions.json', import.meta.url), out);
console.log(`Wrote ${features.length} regions (${Math.round(out.length / 1024)} KB) to public/advisory-regions.json`);
