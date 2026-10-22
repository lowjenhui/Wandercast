import { formatShortDate, todayISO } from '../lib/dates';
import { haversineKm } from '../lib/geo';
import { estimateFlightHours, formatHours } from '../lib/outlook';
import type { Place } from '../types';

export interface Destination {
  name: string;
  cc: string;
  /** Fare lookup code (city or airport IATA). */
  code: string;
  lat: number;
  lon: number;
  country?: string;
  admin1?: string;
  timezone?: string;
  /** Airlines with a scheduled direct flight from Singapore, if any (including ones that start later). */
  directAirlines?: string[];
  /** Airlines in directAirlines that fly only within a date window (a new route that begins later…). */
  directDated?: Record<string, RouteWindow>;
  /** Reached by scheduled ferry from Singapore instead of flying. */
  ferry?: FerryInfo;
  /** No direct flight of its own: fly to a nearby direct-flight city, then transfer. */
  via?: ViaInfo;
  /** Also (or only) reached overland from Singapore by coach, bus or train. */
  land?: LandInfo;
}

export interface LandInfo {
  /** e.g. ["coach"], ["bus", "train"]. */
  modes: string[];
  /** Where it leaves from in Singapore. */
  from: string;
  /** Typical door-to-door range, including the checkpoint on a normal day. */
  minutes: [number, number];
  operators: string[];
  notes?: string;
  sources: { name: string; url: string }[];
}

export interface LandDestination extends LandInfo {
  code: string;
  name: string;
  cc: string;
  country: string;
  lat: number;
  lon: number;
}

export interface LandData {
  note: string;
  sources: { name: string; url: string }[];
  destinations: LandDestination[];
}

const fmtRange = (min: [number, number]) => {
  const [a, b] = min;
  if (b < 120) return a === b ? `${a} min` : `${a}–${b} min`;
  const h = (m: number) => formatHours(Math.round((m / 60) * 2) / 2);
  return a === b ? h(a) : `${h(a)}–${h(b)}`;
};

/** "🚌 5h–6h coach" style label for the overland option. */
export function landText(l: LandInfo): string {
  return `🚌 ${fmtRange(l.minutes)} ${l.modes.join(' or ')}`;
}

/** Overland travel time for ranking: the slower end of the typical range. */
export function landHours(l: LandInfo): number {
  return Math.max(...l.minutes) / 60;
}

/** Reached only overland (no flight, ferry or flight-plus-transfer of its own). */
export const landOnly = (d: Pick<Destination, 'land' | 'code'>) => Boolean(d.land) && d.code.startsWith('LAND-');

export interface ViaInfo {
  /** Gateway city code (also the fare lookup code). */
  code: string;
  name: string;
  lat: number;
  lon: number;
  /** Typical transfer time range, minutes. */
  minutes: [number, number];
  mode: string;
}

export interface GatewayData {
  note: string;
  source: string;
  destinations: { name: string; cc: string; country: string; admin1?: string; lat: number; lon: number; timezone?: string; via: Omit<ViaInfo, 'lat' | 'lon'> }[];
}

export function viaText(v: ViaInfo): string {
  const [a, b] = v.minutes;
  const t = b < 120 ? `${a === b ? '' : `${a}–`}${b} min` : `${formatHours(Math.round((a / 60) * 2) / 2)}–${formatHours(Math.round((b / 60) * 2) / 2)}`;
  return `fly to ${v.name}, then ${t} by ${v.mode}`;
}

/**
 * Travel time used for ranking and trip-length limits: the ferry crossing, the direct flight,
 * or the flight to the gateway plus the slower end of the transfer (rounded up to 30 min).
 */
export function destinationHours(d: Pick<Destination, 'lat' | 'lon' | 'ferry' | 'via' | 'land' | 'code'>): number {
  if (d.land && landOnly(d)) return landHours(d.land);
  const main = destinationHoursMain(d);
  return d.land ? Math.min(main, landHours(d.land)) : main;
}

function destinationHoursMain(d: Pick<Destination, 'lat' | 'lon' | 'ferry' | 'via'>): number {
  if (d.ferry) return ferryHours(d.ferry);
  if (d.via) return Math.ceil((estimateFlightHours(d.via.lat, d.via.lon) + d.via.minutes[1] / 60) * 2) / 2;
  return estimateFlightHours(d.lat, d.lon);
}

/** Inclusive YYYY-MM-DD dates a dated route flies between; either end may be open. */
export interface RouteWindow {
  from?: string;
  until?: string;
}

/** Airlines flying direct on a date (a trip's departure, or today), or undefined if none. */
export function directAirlinesOn(d: { directAirlines?: string[]; directDated?: Record<string, RouteWindow> }, date: string): string[] | undefined {
  const list = d.directAirlines?.filter((a) => {
    const w = d.directDated?.[a];
    return !w || ((!w.from || w.from <= date) && (!w.until || date <= w.until));
  });
  return list?.length ? list : undefined;
}

/** "Scoot from 26 Oct", "Asiana Airlines until 17 Dec": dated routes worth mentioning on a date. */
export function datedRouteNotes(d: { directDated?: Record<string, RouteWindow> }, date: string): string[] {
  return Object.entries(d.directDated ?? {}).flatMap(([a, w]) =>
    w.from && date < w.from ? [`${a} from ${formatShortDate(w.from)}`] : w.until && date <= w.until ? [`${a} until ${formatShortDate(w.until)}`] : [],
  );
}

/** One-line travel summary for cards and tables, for a trip departing on `date` (default today). */
export function travelLabel(d: Pick<Destination, 'lat' | 'lon' | 'ferry' | 'via' | 'directAirlines' | 'directDated' | 'land' | 'code'>, date = todayISO()): string {
  if (d.land && landOnly(d)) return landText(d.land);
  const main = travelLabelMain(d, date);
  return d.land ? `${main} · ${landText(d.land)}` : main;
}

function travelLabelMain(d: Pick<Destination, 'lat' | 'lon' | 'ferry' | 'via' | 'directAirlines' | 'directDated'>, date: string): string {
  if (d.ferry) return `⛴ ${d.ferry.minutes[0] === d.ferry.minutes[1] ? '' : `${d.ferry.minutes[0]}–`}${d.ferry.minutes[1]} min ferry`;
  if (d.via) return `✈ ≈${formatHours(estimateFlightHours(d.via.lat, d.via.lon))} to ${d.via.name} + ${d.via.minutes[1] < 120 ? `${d.via.minutes[1]} min` : `≈${formatHours(Math.round((d.via.minutes[1] / 60) * 2) / 2)}`} ${d.via.mode}`;
  return `✈ ≈${formatHours(estimateFlightHours(d.lat, d.lon))}${directAirlinesOn(d, date) ? ' direct' : ' · connection'}`;
}

export interface FerryInfo {
  terminal: string;
  ports: string;
  minutes: [number, number];
  operators: string[];
  notes?: string;
}

export interface FerryDestination extends FerryInfo {
  code: string;
  name: string;
  cc: string;
  country: string;
  lat: number;
  lon: number;
}

export interface FerryData {
  note: string;
  sources: { name: string; url: string }[];
  destinations: FerryDestination[];
}

export function ferryText(f: FerryInfo): string {
  const [a, b] = f.minutes;
  const t = a === b ? `about ${a} min` : `${a}–${b} min`;
  return `Ferry from ${f.terminal} · ${t}`;
}

/** Travel time used for ranking: the slower end of the crossing. */
export function ferryHours(f: FerryInfo): number {
  return Math.max(...f.minutes) / 60;
}

export interface DirectCity {
  code: string;
  name: string;
  cc: string;
  country: string;
  lat: number;
  lon: number;
  airports: string[];
  airlines: string[];
  /** Airlines whose routes here fly only within a window (begins / resumes / ends on a date). */
  dated?: Record<string, RouteWindow>;
}

export interface DirectData {
  source: string;
  builtAt: string;
  cities: DirectCity[];
}

let curatedCache: Promise<Destination[]> | null = null;
let directCache: Promise<DirectData> | null = null;
let mergedCache: Promise<Destination[]> | null = null;
let ferryCache: Promise<FerryData> | null = null;
let gatewayCache: Promise<GatewayData> | null = null;
let landCache: Promise<LandData> | null = null;

const fetchJson = <T,>(file: string) =>
  fetch(`${import.meta.env.BASE_URL}${file}`).then((r) => {
    if (!r.ok) throw new Error(`${file} failed to load (HTTP ${r.status})`);
    return r.json() as Promise<T>;
  });

/** Every city with a direct passenger flight from SIN, built by scripts/build-direct.mjs. */
export function loadDirectCities(): Promise<DirectData> {
  directCache ??= fetchJson<DirectData>('direct-cities.json');
  directCache.catch(() => (directCache = null));
  return directCache;
}

/** Places reached from Singapore by scheduled ferry (Batam, Bintan, Desaru…). */
export function loadFerryDestinations(): Promise<FerryData> {
  ferryCache ??= fetchJson<FerryData>('ferry-destinations.json');
  ferryCache.catch(() => (ferryCache = null));
  return ferryCache;
}

/** Popular overland trips from Singapore by coach, bus or train (Johor Bahru, Malacca, KL…). */
export function loadLandDestinations(): Promise<LandData> {
  landCache ??= fetchJson<LandData>('land-destinations.json');
  landCache.catch(() => (landCache = null));
  return landCache;
}

/** Places reached via a direct-flight city plus a transfer (Hoi An via Da Nang…), by scripts/build-gateways.mjs. */
export function loadGatewayDestinations(): Promise<GatewayData> {
  gatewayCache ??= fetchJson<GatewayData>('gateway-destinations.json');
  gatewayCache.catch(() => (gatewayCache = null));
  return gatewayCache;
}

function loadCurated(): Promise<Destination[]> {
  curatedCache ??= fetchJson<Destination[]>('destinations.json');
  curatedCache.catch(() => (curatedCache = null));
  return curatedCache;
}

/**
 * Suggestion and map destinations: the curated popular list plus every direct-flight city,
 * de-duplicated (same fare code, or within 30 km), with direct airlines attached.
 */
export function loadDestinations(): Promise<Destination[]> {
  mergedCache ??= Promise.all([
    loadCurated(),
    loadDirectCities(),
    loadFerryDestinations(),
    loadGatewayDestinations().catch(() => null),
    loadLandDestinations().catch(() => null),
  ]).then(([curated, direct, ferries, gateways, land]) => {
    const out: Destination[] = [];
    const matchDirect = (d: Destination) =>
      direct.cities.find((c) => c.code === d.code || c.airports.includes(d.code) || haversineKm(c.lat, c.lon, d.lat, d.lon) < 30);
    const used = new Set<string>();
    for (const d of curated) {
      const m = matchDirect(d);
      if (m) used.add(m.code);
      out.push({ ...d, directAirlines: m?.airlines, directDated: m?.dated });
    }
    for (const c of direct.cities) {
      if (used.has(c.code)) continue;
      out.push({ name: c.name, cc: c.cc, code: c.code, lat: c.lat, lon: c.lon, country: c.country, directAirlines: c.airlines, directDated: c.dated });
    }
    for (const f of ferries.destinations) {
      const { code, name, cc, country, lat, lon, ...info } = f;
      out.push({ name, cc, code, lat, lon, country, ferry: info });
    }
    for (const g of gateways?.destinations ?? []) {
      const gw = direct.cities.find((c) => c.code === g.via.code);
      if (!gw || out.some((d) => haversineKm(d.lat, d.lon, g.lat, g.lon) < 15)) continue;
      out.push({ name: g.name, cc: g.cc, code: g.via.code, lat: g.lat, lon: g.lon, country: g.country, admin1: g.admin1, timezone: g.timezone, via: { ...g.via, lat: gw.lat, lon: gw.lon } });
    }
    // Overland: attached to the nearest existing place within 25 km (one place, both ways),
    // otherwise a land-only place of its own.
    for (const l of land?.destinations ?? []) {
      const { code, name, cc, country, lat, lon, ...info } = l;
      let best = -1;
      let bestKm = 25;
      out.forEach((d, i) => {
        const km = haversineKm(d.lat, d.lon, lat, lon);
        if (km < bestKm) (best = i), (bestKm = km);
      });
      if (best >= 0) out[best] = { ...out[best], land: info };
      else out.push({ name, cc, code, lat, lon, country, land: info });
    }
    return out;
  });
  mergedCache.catch(() => (mergedCache = null));
  return mergedCache;
}

/** Stable id: the fare code, or the name for places reached via a gateway (which share its code). */
export const destinationId = (d: Destination) => (d.via ? `g:${d.name}` : `d:${d.code}`);

export function destinationPlace(d: Destination, countryName?: string): Place {
  return {
    id: destinationId(d),
    name: d.name,
    admin1: d.admin1,
    country: d.country ?? countryName ?? d.cc,
    countryCode: d.cc,
    latitude: d.lat,
    longitude: d.lon,
    timezone: d.timezone,
  };
}
