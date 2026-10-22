// How the trip will feel, beyond rain and the thermometer: feels-like temperature, nights and
// cold (including snow), and daylight. Display only; the suitability score is unchanged.
//
// Feels-like highs/lows and snowfall come from ERA5 for the same 10 same-date windows as the
// charts. Daylight is calculated from latitude and date (NOAA solar position), so it needs no data.

import type { DailyWeather } from '../types';
import { addDays, daysBetween, type YearWindow } from './dates';
import { mean, notNull } from './stats';

/** Feels like 38 °C or more: the "Right now" map's threshold for Bad heat. */
export const FEELS_VERY_HOT_C = 38;
/** Nights below this need a jacket. */
export const COOL_NIGHT_C = 15;
export const COLD_NIGHT_C = 5;
export const FROST_C = 0;
/** A snow day has at least this much fresh snowfall. */
export const SNOW_DAY_CM = 1;
/** Day-night swing worth dressing in layers for. */
const BIG_SWING_C = 12;

/** Departure city, for the daylight comparison. */
const HOME = { name: 'Singapore', lat: 1.36, lon: 103.99 };

export interface FeelsLike {
  years: number;
  /** Mean daily feels-like high and low over the trip. */
  highMean: number;
  lowMean: number | null;
  /** Feels-like high minus the actual high (positive: humidity makes it feel hotter). */
  highGap: number | null;
  /** Highest feels-like high in any year. */
  hottest: number;
  /** Per trip, on average. */
  veryHotDaysMean: number;
  /** Days whose feels-like high stays at or below freezing, per trip. */
  freezingDaysMean: number;
}

export interface Nights {
  years: number;
  lowMean: number;
  /** Mean day-night swing (high minus low). */
  swingMean: number | null;
  coldest: { c: number; year: number };
  /** Per trip, on average. */
  coolNightsMean: number;
  coldNightsMean: number;
  frostNightsMean: number;
  /** Null when snowfall wasn't available. */
  snow: { years: number; daysMean: number; yearsWithSnow: number } | null;
}

export interface DaylightDay {
  date: string;
  hours: number;
  /** Local "HH:MM", or null without a time zone or during polar day/night. */
  sunrise: string | null;
  sunset: string | null;
  polar: 'day' | 'night' | null;
}

export interface Daylight {
  first: DaylightDay;
  last: DaylightDay;
  meanHours: number;
  /** Mean daylight minus the departure city's over the same dates. */
  vsHomeHours: number;
  homeName: string;
}

export interface TripComfort {
  feelsLike: FeelsLike | null;
  nights: Nights | null;
  daylight: Daylight;
  /** Plain-language takeaways for planning and packing. */
  notes: string[];
}

// ------------------------------------------------------------------ daylight

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const J2000 = 2451545;
const julianToMs = (j: number) => (j - 2440587.5) * 86_400_000;

function localTime(ms: number, timeZone?: string): string | null {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  } catch {
    return null;
  }
}

/** Sunrise, sunset and day length (sunrise equation, standard −0.833° refraction altitude). */
export function daylightOn(date: string, lat: number, lon: number, timeZone?: string): DaylightDay {
  // Days since J2000 at approximate local solar noon (longitude east-positive).
  const noonUtc = Date.parse(`${date}T12:00:00Z`) / 86_400_000 + 2440587.5;
  const jStar = noonUtc - J2000 - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = J2000 + jStar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * lambda));
  const sinDec = Math.sin(rad(lambda)) * Math.sin(rad(23.4397));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * sinDec) / (Math.cos(rad(lat)) * cosDec);
  if (cosW >= 1) return { date, hours: 0, sunrise: null, sunset: null, polar: 'night' };
  if (cosW <= -1) return { date, hours: 24, sunrise: null, sunset: null, polar: 'day' };
  const w = deg(Math.acos(cosW));
  return {
    date,
    hours: (2 * w) / 15,
    sunrise: localTime(julianToMs(transit - w / 360), timeZone),
    sunset: localTime(julianToMs(transit + w / 360), timeZone),
    polar: null,
  };
}

export function tripDaylight(start: string, end: string, lat: number, lon: number, timeZone?: string): Daylight {
  const n = daysBetween(start, end) + 1;
  const days = Array.from({ length: n }, (_, i) => daylightOn(addDays(start, i), lat, lon, timeZone));
  const home = Array.from({ length: n }, (_, i) => daylightOn(addDays(start, i), HOME.lat, HOME.lon).hours);
  const meanHours = mean(days.map((d) => d.hours))!;
  return { first: days[0], last: days[n - 1], meanHours, vsHomeHours: meanHours - mean(home)!, homeName: HOME.name };
}

export function formatHours(h: number): string {
  const total = Math.round(Math.abs(h) * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return hh === 0 ? `${mm}m` : mm === 0 ? `${hh}h` : `${hh}h ${mm}m`;
}

// ------------------------------------------------------------------ feels-like and nights

/** Trip days of one year's window that are present in `byDate`. */
function windowDays(byDate: Map<string, DailyWeather>, w: YearWindow): DailyWeather[] {
  const n = daysBetween(w.start, w.end) + 1;
  return Array.from({ length: n }, (_, i) => byDate.get(addDays(w.start, i))).filter(notNull);
}

function analyseFeelsLike(perYear: { days: DailyWeather[] }[], tripDays: number): FeelsLike | null {
  const years = perYear.filter((y) => y.days.filter((d) => notNull(d.feelsMaxC)).length >= Math.ceil(tripDays * 0.8));
  if (!years.length) return null;
  const days = years.flatMap((y) => y.days);
  const highs = days.map((d) => d.feelsMaxC).filter(notNull);
  const lows = days.map((d) => d.feelsMinC).filter(notNull);
  const gaps = days.map((d) => (notNull(d.feelsMaxC) && notNull(d.tMaxC) ? d.feelsMaxC - d.tMaxC : null)).filter(notNull);
  // Scale each year's count to the full trip length, as the rain figures do.
  const perTrip = (pred: (d: DailyWeather) => boolean) =>
    mean(
      years.map((y) => {
        const have = y.days.filter((d) => notNull(d.feelsMaxC));
        return (have.filter(pred).length / have.length) * tripDays;
      }),
    )!;
  return {
    years: years.length,
    highMean: mean(highs)!,
    lowMean: mean(lows),
    highGap: mean(gaps),
    hottest: Math.max(...highs),
    veryHotDaysMean: perTrip((d) => d.feelsMaxC! >= FEELS_VERY_HOT_C),
    freezingDaysMean: perTrip((d) => d.feelsMaxC! <= FROST_C),
  };
}

function analyseNights(perYear: { year: number; days: DailyWeather[] }[], tripDays: number): Nights | null {
  const years = perYear.filter((y) => y.days.filter((d) => notNull(d.tMinC)).length >= Math.ceil(tripDays * 0.8));
  if (!years.length) return null;
  const days = years.flatMap((y) => y.days);
  const lows = days.map((d) => d.tMinC).filter(notNull);
  const swings = days.map((d) => (notNull(d.tMaxC) && notNull(d.tMinC) ? d.tMaxC - d.tMinC : null)).filter(notNull);
  let coldest = { c: Infinity, year: 0 };
  for (const y of years) for (const d of y.days) if (notNull(d.tMinC) && d.tMinC < coldest.c) coldest = { c: d.tMinC, year: y.year };
  const perTrip = (pred: (c: number) => boolean) =>
    mean(
      years.map((y) => {
        const have = y.days.map((d) => d.tMinC).filter(notNull);
        return (have.filter(pred).length / have.length) * tripDays;
      }),
    )!;
  const snowYears = years.filter((y) => y.days.filter((d) => notNull(d.snowCm)).length >= Math.ceil(tripDays * 0.8));
  const snowDays = snowYears.map((y) => {
    const have = y.days.map((d) => d.snowCm).filter(notNull);
    return (have.filter((s) => s >= SNOW_DAY_CM).length / have.length) * tripDays;
  });
  return {
    years: years.length,
    lowMean: mean(lows)!,
    swingMean: mean(swings),
    coldest,
    coolNightsMean: perTrip((c) => c < COOL_NIGHT_C),
    coldNightsMean: perTrip((c) => c < COLD_NIGHT_C),
    frostNightsMean: perTrip((c) => c < FROST_C),
    snow: snowYears.length
      ? { years: snowYears.length, daysMean: mean(snowDays)!, yearsWithSnow: snowYears.filter((y) => y.days.some((d) => (d.snowCm ?? 0) >= SNOW_DAY_CM)).length }
      : null,
  };
}

// ------------------------------------------------------------------ takeaways

const c0 = (n: number) => `${Math.round(n)} °C`;
const about = (n: number, word: string) => {
  const r = Math.round(n);
  return r <= 1 ? `about one ${word}` : `about ${r} ${word}s`;
};

function takeaways(f: FeelsLike | null, nt: Nights | null, dl: Daylight, tMaxMean: number | null): string[] {
  const out: string[] = [];
  if (f) {
    if (f.highGap !== null && f.highGap >= 3) {
      out.push(`Humidity makes afternoons feel about ${c0(f.highMean)}, roughly ${Math.round(f.highGap)} °C hotter than the thermometer. Plan outdoor sightseeing for mornings and evenings.`);
    } else if (f.highGap !== null && f.highGap <= -3) {
      out.push(`Wind makes days feel colder than the thermometer: highs feel like about ${c0(f.highMean)}.`);
    }
    if (f.veryHotDaysMean >= 0.5) out.push(`Expect ${about(f.veryHotDaysMean, 'day')} that feel ${FEELS_VERY_HOT_C} °C or hotter. Take an indoor break around midday.`);
    if (f.freezingDaysMean >= 0.5) out.push(`On ${about(f.freezingDaysMean, 'day')} it feels below freezing even at the warmest time of day. Pack a warm coat, hat and gloves.`);
  }
  if (nt) {
    if (nt.frostNightsMean >= 0.5) out.push(`Frost on ${about(nt.frostNightsMean, 'night')} per trip; the coldest night in the last ${nt.years} years was ${c0(nt.coldest.c)} (${nt.coldest.year}).`);
    else if (nt.coldNightsMean >= 0.5) out.push(`Nights are cold, dropping below ${COLD_NIGHT_C} °C on ${about(nt.coldNightsMean, 'night')}. Pack a warm layer.`);
    else if (nt.coolNightsMean >= 0.5 && (tMaxMean ?? 0) >= 20) out.push(`Evenings cool down to about ${c0(nt.lowMean)}. Bring a light jacket.`);
    if (nt.swingMean !== null && nt.swingMean >= BIG_SWING_C) out.push(`Big day-night swing of about ${Math.round(nt.swingMean)} °C, so dress in layers.`);
    if (nt.snow && nt.snow.yearsWithSnow > 0) {
      out.push(
        nt.snow.daysMean >= 0.5
          ? `Snow is likely: ${about(nt.snow.daysMean, 'snow day')} per trip (≥${SNOW_DAY_CM} cm), in ${nt.snow.yearsWithSnow} of the last ${nt.snow.years} years.`
          : `Snow is possible: it fell on these dates in ${nt.snow.yearsWithSnow} of the last ${nt.snow.years} years.`,
      );
    }
  }
  if (dl.first.polar === 'night' || dl.last.polar === 'night') out.push('The sun does not rise on some trip days (polar night).');
  else if (dl.first.polar === 'day' || dl.last.polar === 'day') out.push('The sun does not set on some trip days (midnight sun).');
  else if (Math.abs(dl.vsHomeHours) >= 0.75) {
    const times = dl.first.sunrise && dl.first.sunset ? ` (sunrise about ${dl.first.sunrise}, sunset about ${dl.first.sunset})` : '';
    out.push(
      dl.vsHomeHours < 0
        ? `Short days: about ${formatHours(dl.meanHours)} of daylight${times}, ${formatHours(dl.vsHomeHours)} less than ${dl.homeName}. Start early to fit sightseeing in.`
        : `Long days: about ${formatHours(dl.meanHours)} of daylight${times}, ${formatHours(dl.vsHomeHours)} more than ${dl.homeName}.`,
    );
  }
  return out;
}

export function analyseComfort(
  daily: DailyWeather[],
  windows: YearWindow[],
  tripStart: string,
  tripEnd: string,
  place: { lat: number; lon: number; timeZone?: string },
  tMaxMean: number | null = null,
): TripComfort {
  const tripDays = daysBetween(tripStart, tripEnd) + 1;
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const perYear = windows.map((w) => ({ year: w.year, days: windowDays(byDate, w) }));
  const feelsLike = analyseFeelsLike(perYear, tripDays);
  const nights = analyseNights(perYear, tripDays);
  const daylight = tripDaylight(tripStart, tripEnd, place.lat, place.lon, place.timeZone);
  return { feelsLike, nights, daylight, notes: takeaways(feelsLike, nights, daylight, tMaxMean) };
}
