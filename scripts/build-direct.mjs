// Builds public/direct-cities.json: every city with a scheduled direct passenger flight from
// Singapore Changi (SIN), with the airlines serving it.
//
// Sources (fetched at build time):
//  - Wikipedia "Changi Airport" → "Airlines and destinations / Passenger" table (CC BY-SA)
//  - Wikidata: IATA code (P238) for each linked airport article
//  - Travelpayouts public airport and city directories: airport → city code, city name and coordinates
// Usage: node scripts/build-direct.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const countryName = new Map(createRequire(import.meta.url)('world-countries').map((c) => [c.cca2, c.name.common]));

const UA = { 'User-Agent': 'Wandercast-build/0.1 (local development; contact: maintainer)' };
const get = async (url) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

// 1. Destination table wikitext.
const page = await get('https://en.wikipedia.org/w/api.php?action=parse&page=Changi_Airport&prop=wikitext&format=json&formatversion=2');
const wt = page.parse.wikitext;
const start = wt.indexOf('===Passenger===');
// The table is an {{Airport destination list …}} template ending at the next line that is just "}}".
const end = wt.indexOf('\n}}', start);
if (start < 0 || end < 0) throw new Error('Passenger destination table not found');
const table = wt.slice(start, end).replace(/\{\{nowrap\|([\s\S]*?)\}\}/gi, '$1').replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '').replace(/<!--[\s\S]*?-->/g, '');

const today = new Date().toISOString().slice(0, 10);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "begins 26 October 2026" → 2026-10-26; a month-only date ("begins December 2026") uses the 1st.
const noteDate = (note) => {
  const m = note.match(/(?:(\d{1,2})\s+)?([A-Za-z]+)\s+(\d{4})/);
  const month = m && MONTHS.indexOf(m[2].toLowerCase());
  if (!m || month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(m[1] ?? 1).padStart(2, '0')}`;
};

// Rows look like: | [[Airline]] | [[Airport article|City]], [[Other]] (ends …), '''Seasonal:''' [[…]]
// Routes that begin, resume or end on a known date keep it as `from` / `until` (inclusive), so the
// app can count them as direct only for trips within that window.
const routes = []; // { airline, title | iata, seasonal, from?, until? }
const undated = [];
for (const line of table.split('\n')) {
  const m = line.match(/^\|\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\]\s*\|(.*)$/);
  if (!m) continue;
  const airline = m[1].trim();
  let seasonal = false;
  for (const part of m[2].split(/,|<br\s*\/?>/)) {
    if (/Seasonal/i.test(part)) seasonal = true;
    if (/Charter/i.test(part)) continue;
    const link = part.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (!link) continue;
    const note = (part.match(/\(([^)]*(?:begins|ends|resumes)[^)]*)\)/i) ?? [])[1];
    const starts = note && /begins|resumes/i.test(note);
    const date = note && noteDate(note);
    if (note && !date) {
      undated.push(`${airline} → ${link[1].trim()} (${note})`);
      if (starts) continue; // not flying yet, and no date to show it from
    }
    if (date && !starts && date < today) continue; // already ended
    const from = starts && date > today ? date : undefined;
    const until = date && !starts ? date : undefined;
    routes.push({ airline, title: link[1].trim(), seasonal, from, until });
  }
}

// Manual additions for announced routes Wikipedia doesn't list yet (scripts/direct-overrides.json).
const overrides = JSON.parse(readFileSync(new URL('./direct-overrides.json', import.meta.url), 'utf8')).routes;

// 2. Resolve article titles → Wikidata items → IATA codes.
const titles = [...new Set(routes.map((r) => r.title))];
const titleToItem = new Map();
for (let i = 0; i < titles.length; i += 50) {
  const batch = titles.slice(i, i + 50);
  const q = await get(`https://en.wikipedia.org/w/api.php?action=query&redirects=1&prop=pageprops&ppprop=wikibase_item&format=json&formatversion=2&titles=${encodeURIComponent(batch.join('|'))}`);
  const redirect = new Map([...(q.query.normalized ?? []), ...(q.query.redirects ?? [])].map((r) => [r.from, r.to]));
  const byTitle = new Map(q.query.pages.map((p) => [p.title, p.pageprops?.wikibase_item]));
  for (const t of batch) {
    let cur = t;
    for (let k = 0; k < 3 && redirect.has(cur); k++) cur = redirect.get(cur);
    if (byTitle.get(cur)) titleToItem.set(t, byTitle.get(cur));
  }
}
const items = [...new Set(titleToItem.values())];
const itemToIata = new Map();
for (let i = 0; i < items.length; i += 50) {
  const e = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=${items.slice(i, i + 50).join('|')}`);
  for (const [id, ent] of Object.entries(e.entities)) {
    const iata = ent.claims?.P238?.[0]?.mainsnak?.datavalue?.value;
    if (iata) itemToIata.set(id, iata.toUpperCase());
  }
}

// 3. Airport → city via Travelpayouts directories.
const airports = await get('https://api.travelpayouts.com/data/en/airports.json');
const cities = await get('https://api.travelpayouts.com/data/en/cities.json');
const airportByCode = new Map(airports.map((a) => [a.code, a]));
const cityByCode = new Map(cities.map((c) => [c.code, c]));

for (const r of routes) r.iata = itemToIata.get(titleToItem.get(r.title));
// An override is dropped once Wikipedia lists the same airline and airport (time to delete it).
const listed = new Set(routes.map((r) => `${r.airline}|${r.iata}`));
const staleOverrides = [];
for (const o of overrides) {
  if (listed.has(`${o.airline}|${o.airport}`)) staleOverrides.push(`${o.airline} → ${o.airport}`);
  else if (!(o.until && o.until < today)) routes.push({ airline: o.airline, iata: o.airport, title: o.airport, seasonal: false, from: o.from > today ? o.from : undefined, until: o.until });
}

const out = new Map();
const unresolved = new Set();
const dated = new Map(); // city code → airline → { from?, until? }; undefined once any route is undated
for (const r of routes) {
  const iata = r.iata;
  const ap = iata && airportByCode.get(iata);
  if (!ap) {
    unresolved.add(r.title);
    continue;
  }
  const city = cityByCode.get(ap.city_code) ?? null;
  const code = ap.city_code || iata;
  const entry = out.get(code) ?? {
    code,
    name: city?.name_translations?.en || city?.name || ap.name,
    cc: ap.country_code,
    country: countryName.get(ap.country_code) ?? ap.country_code,
    lat: Math.round((city?.coordinates?.lat ?? ap.coordinates.lat) * 1e4) / 1e4,
    lon: Math.round((city?.coordinates?.lon ?? ap.coordinates.lon) * 1e4) / 1e4,
    airports: [],
    airlines: [],
    seasonalOnly: true,
  };
  if (!entry.airports.includes(iata)) entry.airports.push(iata);
  if (!entry.airlines.includes(r.airline)) entry.airlines.push(r.airline);
  if (!r.seasonal) entry.seasonalOnly = false;
  const byAirline = dated.get(code) ?? new Map();
  const prev = byAirline.get(r.airline);
  if ((!r.from && !r.until) || prev === null) byAirline.set(r.airline, null);
  else byAirline.set(r.airline, prev ? { from: prev.from && r.from && (r.from < prev.from ? r.from : prev.from), until: prev.until && r.until && (r.until > prev.until ? r.until : prev.until) } : { from: r.from, until: r.until });
  dated.set(code, byAirline);
  out.set(code, entry);
}
// Airlines whose only routes are dated: { "Scoot": { "from": "2026-10-26" } }.
for (const [code, byAirline] of dated) {
  const windows = Object.fromEntries([...byAirline].filter(([, w]) => w && (w.from || w.until)).map(([a, w]) => [a, JSON.parse(JSON.stringify(w))]));
  if (Object.keys(windows).length) out.get(code).dated = windows;
}
const list = [...out.values()].filter((c) => c.code !== 'SIN').sort((a, b) => b.airlines.length - a.airlines.length || a.name.localeCompare(b.name));
writeFileSync(new URL('../public/direct-cities.json', import.meta.url), JSON.stringify({ source: 'Wikipedia: Changi Airport – Airlines and destinations, plus scripts/direct-overrides.json', builtAt: today, cities: list }));
console.log(`${routes.length} route entries → ${list.length} direct-flight cities`);
if (unresolved.size) console.log(`Unresolved (${unresolved.size}): ${[...unresolved].join('; ')}`);
for (const c of list.filter((c) => c.dated)) console.log(`Dated: ${c.name} ${JSON.stringify(c.dated)}`);
if (undated.length) console.log(`Begins/ends notes without a readable date (${undated.length}): ${undated.join('; ')}`);
if (staleOverrides.length) console.log(`Now on Wikipedia, remove from scripts/direct-overrides.json: ${staleOverrides.join('; ')}`);
console.log('Top:', list.slice(0, 15).map((c) => `${c.name} (${c.airlines.length})`).join(', '));
