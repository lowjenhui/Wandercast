// Shared domain types. Services return these shapes so providers can be swapped
// without touching the UI.

export interface Place {
  id: string;
  name: string;
  admin1?: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

export interface Airport {
  iata: string;
  cityCode: string;
  name: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  distanceKm: number;
}

export interface TripQuery {
  place: Place;
  /** Destination code used for fare lookups (city or airport IATA). */
  destinationCode: string;
  destinationLabel: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD, inclusive
  manualFareSgd?: number;
  /** When the trip was booked (YYYY-MM-DD), for insurers' advisory-timing rules. */
  bookedOn?: string;
  /** Set when the destination is normally reached by ferry from Singapore. */
  ferry?: { name: string; terminal: string; ports: string; minutes: [number, number]; operators: string[]; notes?: string; sources: SourceRef[] };
  /** Set when the destination is also (or only, with `only`) reached overland by coach, bus or train. */
  land?: { name: string; modes: string[]; from: string; minutes: [number, number]; operators: string[]; notes?: string; sources: SourceRef[]; only: boolean };
  /** No direct flight of its own: fares are for the gateway city, then a transfer. */
  via?: { code: string; name: string; minutes: [number, number]; mode: string };
  /** A past trip (archived daydream date): shown from stored data only, as of `asOf` (its start). */
  archive?: { rangeId: number; label: string; asOf: string };
  /** Opened from a saved destination of a daydream date: its analysis summary is saved for later. */
  savedRef?: { rangeId: number; destId: number };
}

export interface SourceRef {
  name: string;
  url: string;
}

/** One day of historical weather, nulls where the provider has gaps. */
export interface DailyWeather {
  date: string;
  precipMm: number | null;
  tMaxC: number | null;
  tMinC: number | null;
  rhMeanPct: number | null;
  /** Feels-like high and low, and snowfall: only present when requested (`extended`). */
  feelsMaxC?: number | null;
  feelsMinC?: number | null;
  snowCm?: number | null;
}

export interface WeatherHistory {
  daily: DailyWeather[];
  dataKind: 'reanalysis' | 'station';
  datasetName: string;
  datasetNote: string;
  sources: SourceRef[];
  gridLatitude: number;
  gridLongitude: number;
  gridElevationM?: number;
  /** IANA time zone of the place (e.g. "Asia/Tokyo"), for local sunrise and sunset times. */
  timezone?: string;
}

export type RiskSeverity = 'high' | 'moderate' | 'info';

export interface SeasonalRisk {
  id: string;
  title: string;
  description: string;
  severity: RiskSeverity;
  inPeak: boolean;
  source: SourceRef;
  /** 'reference' = curated climatology; 'data' = derived from this location's history. */
  basis: 'reference' | 'data';
}

/** A single fare seen by a provider, with when it was observed. */
export interface FareObservation {
  priceSgd: number;
  departDate: string;
  returnDate?: string;
  foundAt?: string;
  transfers?: number;
  airline?: string;
  origin: string;
  destination: string;
  link?: string;
}

export type FareStatus = 'ok' | 'not-configured' | 'unavailable' | 'error' | 'past-dates' | 'ferry' | 'land';

/** When fares came from the local database: the oldest save, and whether it's a fallback. */
export interface FareSaved {
  at: number;
  stale: boolean;
  /** Served from a past trip's fare archive. */
  archived?: boolean;
}

/** One flight within a live one-way option. Times are local to each airport, e.g. "2026-12-04 08:35". */
export interface LiveSegment {
  from: string;
  to: string;
  departTime: string;
  arriveTime: string;
  minutes: number;
  airline?: string;
  /** e.g. "TR 636"; its first two characters are the airline's IATA code. */
  flightNumber?: string;
  /** Airline logo URL from Google Flights. */
  logo?: string;
}

/** One live one-way option from Google Flights (SerpApi). */
export interface LiveLeg {
  priceSgd: number;
  airlines: string[];
  logo?: string;
  stops: number;
  totalMinutes: number;
  departTime: string;
  arriveTime: string;
  flightNumbers: string[];
  /** Airports along the route, e.g. ["SIN", "KUL", "BKK"]. */
  route: string[];
  segments: LiveSegment[];
  /** `country` is the connection airport's ISO country code, when known. */
  layovers: { airport: string; minutes: number; overnight: boolean; country?: string }[];
  /** Listed by Google Flights among its best flights (its own pick of price, time and stops). */
  googleBest: boolean;
}

export interface LiveFares {
  status: 'ok' | 'not-configured' | 'error';
  message?: string;
  /** One-way options leaving Singapore on the start date. */
  outbound: LiveLeg[];
  /** One-way options back to Singapore leaving the evening before or on the end date. */
  inbound: LiveLeg[];
  /** Google's own view of one-way prices on the outbound date. */
  insights?: { lowest?: number; level?: string; typicalRange?: [number, number] };
  /** Cheapest outbound plus cheapest return landing on the end date (any times), or null. */
  cheapestTotal: number | null;
  /** Google Flights pages for the outbound and return searches, for booking. */
  urls: { outbound?: string; inbound?: string };
  /** Long-haul only: a round-trip search, as outbound options priced for the whole return ticket. */
  roundTrip?: { options: LiveLeg[]; url?: string };
  saved?: FareSaved;
}

export interface FareData {
  status: FareStatus;
  message?: string;
  provider: string;
  sources: SourceRef[];
  /** Fares observed for comparable trips (nearby departure dates, similar stay length). */
  comparable: FareObservation[];
  /** Fares observed for comparable stay length across all upcoming departures on the route. */
  routeWide: FareObservation[];
  /** Most recently cached fares for the exact dates (not a live quote). */
  exactDates: FareObservation[];
  /** True only when a real-time, bookable search provider is wired in. */
  hasLiveSearch: boolean;
  warnings: string[];
  /** Set when some fares were served from the database instead of the provider. */
  saved?: FareSaved;
  /** Live Google Flights prices for the exact dates (SerpApi), when configured. */
  live?: LiveFares;
}
