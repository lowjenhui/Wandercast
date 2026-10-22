// Builds public/destinations.json: popular leisure destinations from Singapore with the
// fare code used for Travelpayouts lookups. Coordinates are geocoded once via Open-Meteo.
// Usage: node scripts/build-destinations.mjs
import { writeFileSync } from 'node:fs';

// [display name, country code, fare code (city or airport IATA), geocode query, fixed [lat, lon]]
const LIST = [
  ['Bangkok', 'TH', 'BKK'], ['Phuket', 'TH', 'HKT'], ['Krabi', 'TH', 'KBV'], ['Chiang Mai', 'TH', 'CNX'], ['Koh Samui', 'TH', 'USM', 'Ko Samui'],
  ['Kuala Lumpur', 'MY', 'KUL'], ['Penang', 'MY', 'PEN', 'George Town'], ['Langkawi', 'MY', 'LGK', 'Kuah'], ['Kota Kinabalu', 'MY', 'BKI'], ['Kuching', 'MY', 'KCH'],
  ['Bali', 'ID', 'DPS', 'Denpasar'], ['Jakarta', 'ID', 'JKT'], ['Yogyakarta', 'ID', 'JOG'], ['Lombok', 'ID', 'LOP', 'Mataram'], ['Labuan Bajo', 'ID', 'LBJ'],
  ['Ho Chi Minh City', 'VN', 'SGN'], ['Hanoi', 'VN', 'HAN'], ['Da Nang', 'VN', 'DAD'], ['Nha Trang', 'VN', 'CXR'], ['Phu Quoc', 'VN', 'PQC', 'Dương Đông'],
  ['Siem Reap', 'KH', 'REP'], ['Phnom Penh', 'KH', 'PNH'], ['Luang Prabang', 'LA', 'LPQ'], ['Yangon', 'MM', 'RGN'],
  ['Manila', 'PH', 'MNL'], ['Cebu', 'PH', 'CEB', 'Cebu City'], ['Puerto Princesa', 'PH', 'PPS'], ['Bandar Seri Begawan', 'BN', 'BWN'],
  ['Hong Kong', 'HK', 'HKG'], ['Macau', 'MO', 'MFM', 'Macau'], ['Taipei', 'TW', 'TPE'], ['Tokyo', 'JP', 'TYO'], ['Osaka', 'JP', 'OSA'], ['Sapporo', 'JP', 'SPK'],
  ['Fukuoka', 'JP', 'FUK'], ['Okinawa', 'JP', 'OKA', 'Naha'], ['Seoul', 'KR', 'SEL'], ['Busan', 'KR', 'PUS'], ['Jeju', 'KR', 'CJU', 'Jeju City'],
  ['Shanghai', 'CN', 'SHA'], ['Beijing', 'CN', 'BJS'], ['Chengdu', 'CN', 'CTU'], ['Xiamen', 'CN', 'XMN'],
  ['Maldives', 'MV', 'MLE', 'Male'], ['Colombo', 'LK', 'CMB'], ['Kathmandu', 'NP', 'KTM'], ['Delhi', 'IN', 'DEL', 'New Delhi'], ['Mumbai', 'IN', 'BOM'],
  ['Goa', 'IN', 'GOI', 'Panaji', [15.4909, 73.8278]], ['Chennai', 'IN', 'MAA'], ['Kochi', 'IN', 'COK'],
  ['Perth', 'AU', 'PER'], ['Sydney', 'AU', 'SYD'], ['Melbourne', 'AU', 'MEL'], ['Brisbane', 'AU', 'BNE'], ['Cairns', 'AU', 'CNS'], ['Darwin', 'AU', 'DRW'],
  ['Auckland', 'NZ', 'AKL'], ['Queenstown', 'NZ', 'ZQN'], ['Christchurch', 'NZ', 'CHC'], ['Nadi', 'FJ', 'NAN'],
  ['Dubai', 'AE', 'DXB'], ['Istanbul', 'TR', 'IST'], ['London', 'GB', 'LON'], ['Paris', 'FR', 'PAR'], ['Rome', 'IT', 'ROM'], ['Barcelona', 'ES', 'BCN'],
  ['Zurich', 'CH', 'ZRH'], ['Amsterdam', 'NL', 'AMS'], ['Munich', 'DE', 'MUC'], ['Reykjavik', 'IS', 'REK', 'Reykjavík'], ['Cairo', 'EG', 'CAI'],
  ['Cape Town', 'ZA', 'CPT'], ['Nairobi', 'KE', 'NBO'], ['Los Angeles', 'US', 'LAX'], ['San Francisco', 'US', 'SFO'], ['New York', 'US', 'NYC', 'New York City'],
  ['Vancouver', 'CA', 'YVR', 'Vancouver', [49.2827, -123.1207]], ['Honolulu', 'US', 'HNL'],
];

const COUNTRY = { IN: 'India', CA: 'Canada' }; // for entries with fixed coordinates
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const missing = [];
for (const [name, cc, code, query, fixed] of LIST) {
  if (fixed) {
    out.push({ name, cc, code, lat: fixed[0], lon: fixed[1], country: COUNTRY[cc] });
    continue;
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query ?? name)}&count=10&language=en&format=json&countryCode=${cc}`;
  const results = (await (await fetch(url)).json()).results ?? [];
  // Prefer the most populous match (avoids small namesakes).
  const hit = results.sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
  if (!hit) {
    missing.push(name);
    continue;
  }
  out.push({ name, cc, code, lat: Math.round(hit.latitude * 1e4) / 1e4, lon: Math.round(hit.longitude * 1e4) / 1e4, country: hit.country ?? name, admin1: hit.admin1, timezone: hit.timezone });
  await sleep(80);
}
writeFileSync(new URL('../public/destinations.json', import.meta.url), JSON.stringify(out));
console.log(`Wrote ${out.length} destinations${missing.length ? `; not found: ${missing.join(', ')}` : ''}`);
