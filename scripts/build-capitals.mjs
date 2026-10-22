// Builds public/capitals.json: one representative point (the capital) per country/territory.
// Capital names come from the world-countries package; coordinates are geocoded once via
// Open-Meteo geocoding (GeoNames), preferring the PPLC (capital) feature, else the country centre.
// Usage: node scripts/build-capitals.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const countries = createRequire(import.meta.url)('world-countries');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(name, cc) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json&countryCode=${cc}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const results = (await res.json()).results ?? [];
        return results.find((r) => r.feature_code === 'PPLC') ?? results[0] ?? null;
      }
    } catch {}
    await sleep(1000);
  }
  return null;
}

const out = [];
let fallbacks = 0;
for (const c of countries) {
  if (!c.ccn3 || !c.latlng) continue;
  const capital = c.capital?.[0];
  const hit = capital ? await geocode(capital, c.cca2) : null;
  if (!hit) fallbacks++;
  out.push({
    ccn3: c.ccn3,
    cc: c.cca2,
    name: c.name.common,
    capital: capital ?? c.name.common,
    lat: Math.round((hit?.latitude ?? c.latlng[0]) * 1e4) / 1e4,
    lon: Math.round((hit?.longitude ?? c.latlng[1]) * 1e4) / 1e4,
    point: hit ? 'capital' : 'centre',
  });
  await sleep(60);
}
writeFileSync(new URL('../public/capitals.json', import.meta.url), JSON.stringify(out));
console.log(`Wrote ${out.length} points (${fallbacks} fell back to country centre)`);
