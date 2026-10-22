// Puff's Lookout: shapes shared with the server watcher (server/lookout.ts) and the small rules
// the page uses (trip stage, AQI bands, weather icons, packing from the forecast).

import type { PageLevel } from './advisory';
import { addDays, daysBetween } from './dates';

/** An event from SerpApi Google Events, as stored. */
export interface LiveEvent {
  title: string;
  /** Google's start date without a year, e.g. "Oct 24". */
  startDate: string;
  /** Google's own wording, e.g. "Sat, Oct 24, 8 – 11 PM". */
  when: string;
  venue: string | null;
  address: string | null;
  link: string | null;
}

export interface ForecastDay {
  date: string;
  /** WMO weather code. */
  code: number | null;
  precipProb: number | null;
  precipMm: number | null;
  tMax: number | null;
  tMin: number | null;
  feelsMax: number | null;
}

export interface AirDay {
  date: string;
  /** Highest hourly US AQI of the day from PM2.5 and PM10 (the scale aqicn.org headlines). */
  aqi: number | null;
  /** Daily mean PM2.5 (µg/m³). */
  pm25: number | null;
  /** Highest hourly dust (µg/m³). */
  dust: number | null;
}

export interface WatchedEvent extends LiveEvent {
  key: string;
  from: string;
  to: string;
  /** When Puff first saw it (ms). */
  firstSeen: number;
}

/** What's watched for one stop of a booked trip, over its own dates. */
export interface PlaceWatch {
  forecast?: { at: number; days: ForecastDay[] };
  air?: { at: number; days: AirDay[]; now: { aqi: number | null; pm25: number | null; time: string | null } | null };
  events?: { at: number; items: WatchedEvent[]; error?: string; triedAt?: number };
  /** Why the last forecast or air-quality fetch failed (cleared on success). */
  errors?: { forecast?: string; air?: string };
}

export interface AdvisoryWatch {
  at: number;
  slug: string | null;
  title: string | null;
  level: PageLevel;
  mfaDate: string | null;
}

export interface LookoutState {
  /** When the first check ran (the baseline); later checks log changes. */
  started?: number;
  /** Per stop, keyed by saved destination id. */
  places?: Record<string, PlaceWatch>;
  /** MFA page per country code. */
  advisories?: Record<string, AdvisoryWatch>;
  /** Alert ids already seen per stop (saved destination id). */
  alerts?: Record<string, string[]>;
}

export type ChangeKind = 'forecast' | 'air' | 'events' | 'advisory' | 'alert';

export interface LookoutChange {
  id: number;
  at: number;
  kind: ChangeKind;
  text: string;
}

export const FORECAST_HORIZON = 16;
export const AIR_HORIZON = 5;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sat 24 Oct" */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** US EPA (2016) AQI bands, as on aqicn.org. */
export function aqiBand(aqi: number | null): string | null {
  if (aqi === null) return null;
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

/** Badge tone for an AQI value. */
export function aqiTone(aqi: number | null): 'good' | 'warning' | 'serious' | 'critical' | 'neutral' {
  if (aqi === null) return 'neutral';
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'warning';
  if (aqi <= 150) return 'serious';
  return 'critical';
}

/** A small weather picture for a WMO code. */
export function weatherIcon(code: number | null): string {
  if (code === null) return '·';
  if (code <= 1) return '☀️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 95) return '⛈️';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '❄️';
  return '🌦️';
}

export type TripStage = 'booked' | 'forecast' | 'air' | 'travelling';

/** Where a booked trip stands today. */
export function tripStage(start: string, end: string, today: string): TripStage {
  if (today >= start && today <= end) return 'travelling';
  const days = daysBetween(today, start);
  if (days < AIR_HORIZON) return 'air';
  if (days < FORECAST_HORIZON) return 'forecast';
  return 'booked';
}

/** The countdown pill: "52 days to go", "Tomorrow!", "Day 2 of 5". */
export function countdown(start: string, end: string, today: string): string {
  if (today > end) return 'Trip over';
  if (today >= start) return `Day ${daysBetween(start, today) + 1} of ${daysBetween(start, end) + 1}`;
  const n = daysBetween(today, start);
  if (n === 1) return 'Tomorrow!';
  return `${n} days to go`;
}

/** When the daily forecast first covers the trip (16 days before it starts). */
export const forecastFrom = (start: string) => addDays(start, -(FORECAST_HORIZON - 1));
/** When the air-quality forecast first covers the trip (5 days before). */
export const airFrom = (start: string) => addDays(start, -(AIR_HORIZON - 1));

/** One-line headline and rating for the forecast days. */
export function forecastSummary(days: ForecastDay[]): { rating: 'Fine' | 'Showery' | 'Wet' | 'Stormy'; headline: string } | null {
  const known = days.filter((d) => d.precipProb !== null);
  if (!known.length) return null;
  const wet = known.filter((d) => (d.precipProb ?? 0) >= 50);
  const storms = known.filter((d) => (d.code ?? 0) >= 95 && (d.precipProb ?? 0) >= 40);
  const dry = known.filter((d) => (d.precipProb ?? 0) < 30);
  const list = (xs: ForecastDay[]) => xs.slice(0, 3).map((d) => dayLabel(d.date).slice(0, 3)).join(', ');
  const rating = storms.length >= 2 || (storms.length && wet.length >= known.length / 2) ? 'Stormy' : wet.length > known.length / 2 ? 'Wet' : wet.length ? 'Showery' : 'Fine';
  const parts: string[] = [];
  if (storms.length) parts.push(`Storms likely on ${list(storms)}`);
  else if (wet.length) parts.push(`Rain likely on ${list(wet)}`);
  if (dry.length && dry.length < known.length) parts.push(`${list(dry)} look${dry.length === 1 ? 's' : ''} the driest`);
  if (!parts.length) parts.push(wet.length ? 'Rain likely most days' : 'Mostly dry');
  const s = parts.join('; ');
  return { rating, headline: `${s[0].toUpperCase()}${s.slice(1)}.` };
}

/** Packing notes from the forecast days (rain, heat, cold). */
export function packingFromForecast(days: ForecastDay[]): string[] {
  const out: string[] = [];
  const wet = days.filter((d) => (d.precipProb ?? 0) >= 50);
  if (wet.length) out.push(wet.length > days.length / 2 ? 'Umbrella or rain jacket: rain is likely most days' : `Compact umbrella for ${wet.slice(0, 3).map((d) => dayLabel(d.date).slice(0, 3)).join(', ')}`);
  const feels = Math.max(...days.map((d) => d.feelsMax ?? -99));
  const hi = Math.max(...days.map((d) => d.tMax ?? -99));
  const lo = Math.min(...days.map((d) => d.tMin ?? 99));
  if (feels >= 38) out.push(`Light, breathable clothes and sun protection (feels like ${Math.round(feels)} °C at midday)`);
  else if (hi >= 30) out.push(`Light, breathable clothes (highs around ${Math.round(hi)} °C)`);
  if (lo <= 0) out.push(`Warm coat, hat and gloves (lows down to ${Math.round(lo)} °C)`);
  else if (lo <= 10) out.push(`A warm layer for the evenings (lows around ${Math.round(lo)} °C)`);
  else if (lo <= 18) out.push(`A light jacket for the evenings (lows around ${Math.round(lo)} °C)`);
  else if (hi >= 28) out.push('A light layer for air-conditioned malls and transport');
  return out;
}

/**
 * Singapore's PSI from a 24-hour PM2.5 mean (NEA's PM2.5 sub-index breakpoints), shown only as a
 * hint next to the AQI.
 */
export function psiFromPm25(pm: number | null): number | null {
  if (pm === null) return null;
  const bands: [number, number, number, number][] = [
    [0, 12, 0, 50],
    [12, 55, 50, 100],
    [55, 150, 100, 200],
    [150, 250, 200, 300],
    [250, 350, 300, 400],
    [350, 500, 400, 500],
  ];
  const b = bands.find(([, hi]) => pm <= hi) ?? bands[bands.length - 1];
  return Math.round(b[2] + ((Math.min(pm, b[1]) - b[0]) / (b[1] - b[0])) * (b[3] - b[2]));
}

/** What to do about the worst air-quality day. */
export function airAdvice(days: AirDay[]): string {
  const worst = Math.max(...days.map((d) => d.aqi ?? 0));
  const dusty = days.some((d) => (d.dust ?? 0) >= 100);
  const cause = dusty ? ' Dust is the main cause.' : '';
  if (worst <= 50) return `Clean air expected.${cause}`;
  if (worst <= 100) return `Fine for sightseeing; unusually sensitive people may want to keep long outdoor exertion short on the worst day.${cause}`;
  if (worst <= 150) return `People with asthma or heart conditions, children and older adults should limit long outdoor exertion on the worst days; a mask helps.${cause}`;
  return `Plan indoor activities on the worst days and bring N95 masks.${cause}`;
}

// ---------------------------------------------------------------- itinerary (booked trips)

export type TravelMode = 'flight' | 'ferry' | 'coach' | 'bus' | 'train' | 'van' | 'car';
export const TRAVEL_MODES: TravelMode[] = ['flight', 'ferry', 'coach', 'bus', 'train', 'van', 'car'];
export const MODE_ICON: Record<TravelMode, string> = { flight: '✈', ferry: '⛴', coach: '🚌', bus: '🚌', train: '🚆', van: '🚐', car: '🚗' };
export const MODE_LABEL: Record<TravelMode, string> = { flight: 'Flight', ferry: 'Ferry', coach: 'Coach', bus: 'Bus', train: 'Train', van: 'Shuttle van', car: 'Car' };
export const modeIcon = (m: TravelMode | null | undefined) => (m ? MODE_ICON[m] : '·');

/** How the land-destinations data names its modes. */
export function landMode(s: string): TravelMode | null {
  const k = s.toLowerCase();
  if (k.includes('coach')) return 'coach';
  if (k.includes('bus')) return 'bus';
  if (k.includes('train') || k.includes('rail')) return 'train';
  if (k.includes('van') || k.includes('shuttle')) return 'van';
  if (k.includes('car') || k.includes('taxi')) return 'car';
  return null;
}

/** One way of travelling (legs[i] arrives at stops[i]; the last leg goes home to Singapore). */
export interface Leg {
  mode: TravelMode | null;
  /** Local times, e.g. "08:00". */
  depart?: string;
  arrive?: string;
  /** As typed, e.g. "S$45". */
  price?: string;
  /** Flight numbers or operator, e.g. "SQ618" or "KKKL". */
  detail?: string;
}

export interface Stay {
  name?: string;
  price?: string;
}

export interface Stop {
  destId: number;
  nights: number;
  stay?: Stay;
}

export interface Itinerary {
  stops: Stop[];
  /** stops.length + 1 legs: Singapore → first stop, between stops, last stop → Singapore. */
  legs: Leg[];
}

export const MAX_STOPS = 8;

export interface StopDates {
  destId: number;
  /** Arrival day. */
  arrive: string;
  /** The day you leave (the next stop's arrival, or the trip's last day). */
  leave: string;
  /** Trip days spent here: arrival day up to the day before leaving (the last stop keeps its last day). */
  days: string[];
}

function plusDays(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Each stop's dates. A travel day counts for the place you arrive at. */
export function stopDates(it: Itinerary, start: string, end: string): StopDates[] {
  let at = start;
  return it.stops.map((s, i) => {
    const arrive = at;
    const leave = i === it.stops.length - 1 ? end : plusDays(arrive, s.nights);
    at = leave;
    const last = i === it.stops.length - 1 ? leave : plusDays(leave, -1);
    const days: string[] = [];
    for (let d = arrive; d <= last; d = plusDays(d, 1)) days.push(d);
    return { destId: s.destId, arrive, leave, days };
  });
}

/** Leg labels: "Singapore → Malacca", "Malacca → Kuala Lumpur", "Kuala Lumpur → Singapore". */
export function legEnds(names: string[]): [string, string][] {
  const route = ['Singapore', ...names, 'Singapore'];
  return route.slice(0, -1).map((from, i) => [from, route[i + 1]]);
}

/** A price typed as "S$45" or "45.50" → 45.5; null when there's no number. */
export function parsePrice(s: string | undefined): number | null {
  const m = s?.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Everything priced so far: legs and stays. Null when nothing has a price yet. */
export function tripTotal(it: Itinerary): number | null {
  const all = [...it.legs.map((l) => l.price), ...it.stops.map((s) => s.stay?.price)].map(parsePrice).filter((x): x is number => x !== null);
  return all.length ? Math.round(all.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

/**
 * Checks and tidies an itinerary for a range of `totalNights` whose saved destinations are
 * `destIds`. Returns an error message instead when it doesn't fit.
 */
export function cleanItinerary(input: unknown, destIds: number[], totalNights: number): Itinerary | string {
  const x = input as { stops?: unknown; legs?: unknown } | null;
  if (!x || !Array.isArray(x.stops) || !x.stops.length) return 'Choose at least one place you’re visiting.';
  if (x.stops.length > MAX_STOPS) return `Up to ${MAX_STOPS} places per trip.`;
  const str = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const stops: Stop[] = [];
  for (const s of x.stops as Record<string, unknown>[]) {
    const destId = Number(s?.destId);
    const nights = Number(s?.nights);
    if (!destIds.includes(destId)) return 'Choose places saved for these dates.';
    if (stops.some((o) => o.destId === destId)) return 'Each place can only be visited once.';
    if (!Number.isInteger(nights) || nights < 0) return 'Nights must be whole numbers.';
    const st = s.stay as Record<string, unknown> | undefined;
    const stay: Stay = { name: str(st?.name), price: str(st?.price, 30) };
    stops.push({ destId, nights, ...(stay.name || stay.price ? { stay } : {}) });
  }
  const sum = stops.reduce((a, s) => a + s.nights, 0);
  if (stops.length > 1 && sum !== totalNights) return `The nights add up to ${sum}; these dates have ${totalNights}.`;
  if (stops.length === 1) stops[0].nights = totalNights;
  const rawLegs = Array.isArray(x.legs) ? (x.legs as Record<string, unknown>[]) : [];
  const legs: Leg[] = [];
  for (let i = 0; i <= stops.length; i++) {
    const l = rawLegs[i] ?? {};
    const mode = TRAVEL_MODES.includes(l.mode as TravelMode) ? (l.mode as TravelMode) : null;
    const leg: Leg = { mode };
    for (const k of ['depart', 'arrive'] as const) if (str(l[k], 10)) leg[k] = str(l[k], 10);
    if (str(l.price, 30)) leg.price = str(l.price, 30);
    if (str(l.detail)) leg.detail = str(l.detail);
    legs.push(leg);
  }
  return { stops, legs };
}
