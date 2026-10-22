// Builds public/cities.json from GeoNames cities15000.txt (CC BY 4.0, https://www.geonames.org/).
// Keeps cities with ≥300k people worldwide, plus denser coverage around Singapore:
// ≥50k people or any provincial capital within Southeast Asia.
// Usage: node scripts/build-cities.mjs path/to/cities15000.txt
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) throw new Error('Pass the path to cities15000.txt (download.geonames.org/export/dump/cities15000.zip)');
const inSea = (lat, lon) => lon >= 90 && lon <= 135 && lat >= -11 && lat <= 28;

const rows = readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
// Compact rows: [name, countryCode, lat, lon, population]
const out = rows
  .filter((r) => {
    const pop = Number(r[14]);
    const lat = Number(r[4]);
    const lon = Number(r[5]);
    const isCapital = /^PPL(C|A|A2)$/.test(r[7]);
    return pop >= 300_000 || (inSea(lat, lon) && (pop >= 50_000 || (isCapital && pop >= 15_000))) || r[7] === 'PPLC';
  })
  .map((r) => [r[1], r[8], Math.round(Number(r[4]) * 1e3) / 1e3, Math.round(Number(r[5]) * 1e3) / 1e3, Number(r[14])])
  .sort((a, b) => b[4] - a[4]);
writeFileSync(new URL('../public/cities.json', import.meta.url), JSON.stringify(out));
console.log(`Wrote ${out.length} cities`);
