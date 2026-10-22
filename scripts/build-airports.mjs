// Builds public/airports.json from the public Travelpayouts airport directory.
// Usage: node scripts/build-airports.mjs [path-to-airports.json]
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
const raw = src
  ? JSON.parse(readFileSync(src, 'utf8'))
  : await (await fetch('https://api.travelpayouts.com/data/en/airports.json')).json();

// Compact rows: [iata, cityCode, name, lat, lon, countryCode]
const rows = raw
  .filter((a) => a.flightable && a.iata_type === 'airport' && /^[A-Z]{3}$/.test(a.code) && a.coordinates)
  .map((a) => [
    a.code,
    a.city_code || a.code,
    a.name_translations?.en || a.name || a.code,
    Math.round(a.coordinates.lat * 1e4) / 1e4,
    Math.round(a.coordinates.lon * 1e4) / 1e4,
    a.country_code,
  ]);
writeFileSync(new URL('../public/airports.json', import.meta.url), JSON.stringify(rows));
console.log(`Wrote ${rows.length} airports`);
