// Builds public/gateway-destinations.json: popular places without their own direct flight from
// Singapore that are reached through a nearby direct-flight city (the "gateway") plus a road,
// rail or ferry transfer, e.g. Hoi An via Da Nang. Coordinates are geocoded once via Open-Meteo
// (GeoNames) and checked against the gateway's distance. Transfer times are typical ranges.
// Usage: node scripts/build-gateways.mjs
import { readFileSync, writeFileSync } from 'node:fs';

// [name, country code, gateway city code, [min, max] transfer minutes, mode, geocode query?, [lat, lon] near?]
// "near" picks the closest of several same-named matches (GeoNames lists two Kalkudahs).
const LIST = [
  // Vietnam
  ['Hoi An', 'VN', 'DAD', [35, 50], 'road', 'Hội An'],
  ['Hue', 'VN', 'DAD', [120, 150], 'road', 'Huế'],
  ['Ha Long Bay', 'VN', 'HAN', [150, 180], 'road', 'Hạ Long'],
  ['Ninh Binh', 'VN', 'HAN', [110, 130], 'road', 'Hoa Lư'],
  ['Sapa', 'VN', 'HAN', [330, 360], 'road', 'Sa Pa'],
  ['Mui Ne', 'VN', 'SGN', [240, 300], 'road', 'Mui Ne'],
  ['Vung Tau', 'VN', 'SGN', [120, 150], 'road', 'Vũng Tàu'],
  // Thailand
  ['Pattaya', 'TH', 'BKK', [90, 120], 'road'],
  ['Hua Hin', 'TH', 'BKK', [180, 210], 'road'],
  ['Ayutthaya', 'TH', 'BKK', [75, 90], 'road', 'Phra Nakhon Si Ayutthaya'],
  ['Kanchanaburi', 'TH', 'BKK', [150, 180], 'road'],
  ['Ao Nang', 'TH', 'KBV', [30, 40], 'road'],
  ['Koh Phi Phi', 'TH', 'HKT', [90, 120], 'ferry', 'Ko Phi Phi Don'],
  ['Khao Lak', 'TH', 'HKT', [75, 90], 'road', 'Khao Lak'],
  ['Koh Phangan', 'TH', 'USM', [30, 60], 'ferry', 'Ko Pha Ngan'],
  ['Koh Tao', 'TH', 'USM', [90, 120], 'ferry', 'Ko Tao'],
  ['Pai', 'TH', 'CNX', [180, 240], 'road', 'Pai'],
  // Malaysia
  ['Cameron Highlands', 'MY', 'IPH', [90, 120], 'road', 'Tanah Rata'],
  ['Genting Highlands', 'MY', 'KUL', [60, 75], 'road', 'Genting Highlands'],
  ['Perhentian Islands', 'MY', 'KBR', [90, 120], 'road + ferry', 'Pulau Perhentian Kecil'],
  ['Kuala Terengganu', 'MY', 'KBR', [150, 180], 'road'],
  ['Kundasang (Mount Kinabalu)', 'MY', 'BKI', [120, 150], 'road', 'Ranau'],
  // Indonesia
  ['Ubud', 'ID', 'DPS', [60, 90], 'road'],
  ['Nusa Penida', 'ID', 'DPS', [75, 105], 'road + ferry'],
  ['Gili Islands', 'ID', 'LOP', [120, 150], 'road + ferry', 'Gili Trawangan'],
  ['Mount Bromo', 'ID', 'SUB', [180, 240], 'road', 'Cemoro Lawang'],
  ['Borobudur', 'ID', 'JOG', [60, 90], 'road'],
  ['Lake Toba', 'ID', 'MES', [240, 300], 'road', 'Parapat'],
  ['Bukittinggi', 'ID', 'PDG', [120, 150], 'road'],
  // Philippines
  ['Bohol (Panglao)', 'PH', 'CEB', [120, 150], 'ferry', 'Panglao'],
  ['Moalboal', 'PH', 'CEB', [150, 180], 'road'],
  ['Baguio', 'PH', 'CRK', [150, 180], 'road'],
  ['Legazpi', 'PH', 'MNL', [540, 600], 'road'],
  // Cambodia, Laos
  ['Kampot', 'KH', 'PNH', [150, 180], 'road'],
  ['Vang Vieng', 'LA', 'VTE', [60, 90], 'rail', 'Vang Vieng'],
  // Japan
  ['Kyoto', 'JP', 'OSA', [45, 75], 'rail'],
  ['Nara', 'JP', 'OSA', [45, 60], 'rail'],
  ['Hiroshima', 'JP', 'OSA', [90, 120], 'rail'],
  ['Hakone', 'JP', 'TYO', [90, 120], 'rail'],
  ['Nikko', 'JP', 'TYO', [120, 150], 'rail'],
  ['Kanazawa', 'JP', 'TYO', [150, 180], 'rail'],
  ['Mount Fuji (Kawaguchiko)', 'JP', 'TYO', [120, 150], 'road', 'Fujikawaguchiko'],
  ['Niseko', 'JP', 'SPK', [120, 150], 'road', 'Kutchan'],
  ['Otaru', 'JP', 'SPK', [40, 50], 'rail'],
  ['Furano', 'JP', 'SPK', [120, 150], 'rail'],
  ['Hakodate', 'JP', 'SPK', [210, 240], 'rail'],
  ['Kushiro', 'JP', 'SPK', [240, 270], 'rail'],
  ['Abashiri', 'JP', 'SPK', [330, 360], 'rail'],
  // Korea, Taiwan
  ['Gyeongju', 'KR', 'PUS', [60, 75], 'road'],
  ['Jiufen', 'TW', 'TPE', [60, 75], 'road', 'Ruifang'],
  ['Hualien (Taroko)', 'TW', 'TPE', [120, 150], 'rail', 'Hualien City'],
  ['Taichung', 'TW', 'TPE', [60, 75], 'rail'],
  ['Tainan', 'TW', 'KHH', [40, 50], 'rail'],
  // China
  ['Suzhou', 'CN', 'SHA', [30, 60], 'rail'],
  ['Guilin', 'CN', 'CAN', [150, 180], 'rail', 'Guilin'],
  ['Huangshan', 'CN', 'HGH', [150, 180], 'rail', 'Huangshan City'],
  ['Lijiang', 'CN', 'KMG', [210, 240], 'rail'],
  ['Dali', 'CN', 'KMG', [120, 150], 'rail', 'Dali'],
  ['Jiuzhaigou', 'CN', 'CTU', [480, 600], 'road', 'Zhangzha', [33.27, 103.9]],
  ['Yangshuo', 'CN', 'CAN', [150, 180], 'rail'],
  ['Zhangye', 'CN', 'LHW', [180, 240], 'rail'],
  ['Xishuangbanna', 'CN', 'KMG', [210, 240], 'rail', 'Jinghong'],
  // South Asia
  ['Agra', 'IN', 'DEL', [120, 180], 'rail'],
  ['Jaipur', 'IN', 'DEL', [270, 300], 'rail'],
  ['Munnar', 'IN', 'COK', [180, 240], 'road'],
  ['Alleppey', 'IN', 'COK', [75, 90], 'road', 'Alappuzha'],
  ['Mysuru', 'IN', 'BLR', [180, 210], 'road'],
  ['Kandy', 'LK', 'CMB', [150, 180], 'road'],
  ['Galle', 'LK', 'CMB', [120, 150], 'road'],
  ['Sigiriya', 'LK', 'CMB', [240, 300], 'road'],
  // Sri Lanka's east and north: dry while the southwest monsoon soaks Colombo (May–Sep)
  ['Trincomalee', 'LK', 'CMB', [330, 390], 'road'],
  ['Pasikudah', 'LK', 'CMB', [360, 420], 'road', 'Kalkudah', [7.93, 81.56]],
  ['Arugam Bay', 'LK', 'CMB', [420, 480], 'road', 'Pottuvil'],
  ['Jaffna', 'LK', 'CMB', [360, 420], 'rail'],
  // Australia
  ['Gold Coast', 'AU', 'BNE', [60, 75], 'road'],
  ['Byron Bay', 'AU', 'BNE', [120, 150], 'road'],
  ['Blue Mountains', 'AU', 'SYD', [120, 150], 'rail', 'Katoomba'],
  ['Port Douglas', 'AU', 'CNS', [60, 75], 'road'],
  ['Margaret River', 'AU', 'PER', [180, 210], 'road'],
  // Europe
  ['Florence', 'IT', 'ROM', [90, 100], 'rail'],
  ['Venice', 'IT', 'MIL', [140, 160], 'rail'],
  ['Interlaken', 'CH', 'ZRH', [120, 140], 'rail'],
  ['Lucerne', 'CH', 'ZRH', [45, 60], 'rail', 'Luzern'],
  ['Salzburg', 'AT', 'MUC', [90, 120], 'rail'],
  ['Bruges', 'BE', 'BRU', [60, 75], 'rail', 'Brugge'],
];

const direct = JSON.parse(readFileSync(new URL('../public/direct-cities.json', import.meta.url), 'utf8')).cities;
// Generous straight-line km/h per transfer mode, to reject namesakes that are too far away.
const SPEED = { road: 100, rail: 230, ferry: 50, 'road + ferry': 70 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const km = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const out = [];
const problems = [];
for (const [name, cc, via, minutes, mode, query, near] of LIST) {
  const g = direct.find((c) => c.code === via);
  if (!g) {
    problems.push(`${name}: gateway ${via} has no direct flight from SIN`);
    continue;
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=${encodeURIComponent(query ?? name)}`;
  const res = await fetch(url).then((r) => r.json());
  // An exact-name populated place beats a bigger namesake (Hakone vs Hakonegasaki).
  const exact = (p) => Number(p.name === (query ?? name) && (p.population ?? 0) > 0);
  // Same country and within a plausible transfer distance; the best-known (most populous)
  // match wins, so small namesakes nearer the gateway don't.
  const hits = (res.results ?? [])
    .filter((p) => p.country_code === cc)
    .map((p) => ({ ...p, km: km(g.lat, g.lon, p.latitude, p.longitude) }))
    .filter((p) => p.km <= Math.max(60, (minutes[1] / 60) * SPEED[mode]))
    .sort((a, b) =>
      near
        ? km(near[0], near[1], a.latitude, a.longitude) - km(near[0], near[1], b.latitude, b.longitude)
        : exact(b) - exact(a) || (b.population ?? 0) - (a.population ?? 0) || a.km - b.km,
    );
  const p = hits[0];
  if (!p) {
    problems.push(`${name}: no geocoding match for "${query ?? name}" in ${cc} near ${g.name}`);
    continue;
  }
  out.push({
    name,
    cc,
    country: p.country,
    admin1: p.admin1,
    lat: Math.round(p.latitude * 1e4) / 1e4,
    lon: Math.round(p.longitude * 1e4) / 1e4,
    timezone: p.timezone,
    via: { code: via, name: g.name, minutes, mode },
    km: Math.round(p.km),
  });
  await sleep(150);
}
writeFileSync(
  new URL('../public/gateway-destinations.json', import.meta.url),
  JSON.stringify(
    {
      note: 'Places reached through a direct-flight city from Singapore plus a road, rail or ferry transfer. Transfer times are typical ranges; check operators before travelling.',
      source: 'Coordinates: GeoNames via Open-Meteo geocoding. Gateways: public/direct-cities.json (Wikipedia, Changi Airport destinations).',
      destinations: out,
    },
    null,
    1,
  ) + '\n',
);
console.log(`Wrote ${out.length} gateway destinations`);
for (const d of out) console.log(`  ${d.name.padEnd(28)} ${d.lat}, ${d.lon}  via ${d.via.name} (${d.km} km, ${d.via.minutes.join('–')} min ${d.via.mode})`);
if (problems.length) console.log('Problems:\n  ' + problems.join('\n  '));
