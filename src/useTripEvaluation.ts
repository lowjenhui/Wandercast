import { useCallback, useRef, useState } from 'react';
import { addDays, daysBetween, monthName, monthsInRange } from './lib/dates';
import { assessFares, type FareAssessment } from './lib/fareAnalysis';
import { analyseComfort, type TripComfort } from './lib/comfort';
import { analyseRainContext, type RainContext } from './lib/rainContext';
import { ensoOutlook, type EnsoOutlook } from './lib/enso';
import { computeOdds } from './lib/tripOdds';
import { tripFetchPlan } from './lib/tripFetchPlan';
import { analyseWeather, type WeatherAnalysis } from './lib/weatherAnalysis';
import { getEnso } from './services/enso';
import { ORIGIN } from './services/airports';
import { services } from './services';
import { setArchiveRange } from './services/http';
import type { FareData, SeasonalRisk, TripQuery, WeatherHistory } from './types';

export type Async<T> = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; value: T };

export interface WeatherResult {
  rainContext: RainContext;
  history: WeatherHistory;
  analysis: WeatherAnalysis;
  risks: SeasonalRisk[];
  /** ENSO persistence outlook for the trip, when the index was available. */
  enso: EnsoOutlook | null;
  ensoSource: { name: string; url: string } | null;
  /** Notes about older years that couldn't be retrieved (the odds then use fewer years). */
  extraNotes: string[];
  /** Feels-like, nights and cold, and daylight (null when not requested). */
  comfort: TripComfort | null;
  /** Years whose feels-like and snowfall couldn't be retrieved. */
  comfortMissing: number;
}

export interface FareResult {
  data: FareData;
  assessment: FareAssessment | null;
}

export function useTripEvaluation() {
  const [weather, setWeather] = useState<Async<WeatherResult>>({ state: 'idle' });
  const [fares, setFares] = useState<Async<FareResult>>({ state: 'idle' });
  const [query, setQuery] = useState<TripQuery | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const run = useCallback((q: TripQuery) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    // Past trips are read from stored data only (every local API request carries the range id).
    setArchiveRange(q.archive?.rangeId ?? null);
    setQuery(q);
    setWeather({ state: 'loading' });
    setFares({ state: 'loading' });

    // Weather and fares load independently so one failure never blocks the other.
    void (async () => {
      try {
        const result = await evaluateWeather(q, ctrl.signal);
        if (!ctrl.signal.aborted) setWeather({ state: 'done', value: result });
      } catch (e) {
        if (!ctrl.signal.aborted) setWeather({ state: 'error', message: (e as Error).message });
      }
    })();

    void (async () => {
      try {
        // Ferry destinations aren't flown to; say so instead of searching air fares.
        const data: FareData = q.land?.only && !q.ferry
          ? {
              status: 'land',
              message: `${q.land.name} is reached overland from Singapore (${q.land.from}), typically ${q.land.minutes[0] === q.land.minutes[1] ? `about ${q.land.minutes[0]}` : `${q.land.minutes[0]}–${q.land.minutes[1]}`} min door to door including the checkpoint. See Getting there overland below.`,
              provider: 'Overland',
              sources: q.land.sources,
              comparable: [],
              routeWide: [],
              exactDates: [],
              hasLiveSearch: false,
              warnings: [],
            }
          : q.ferry
          ? {
              status: 'ferry',
              message: `${q.ferry.name} is reached by ferry from Singapore's ${q.ferry.terminal} terminal (${q.ferry.minutes[0] === q.ferry.minutes[1] ? `about ${q.ferry.minutes[0]}` : `${q.ferry.minutes[0]}–${q.ferry.minutes[1]}`} min to ${q.ferry.ports}).${q.ferry.operators.length ? ` Operators include ${q.ferry.operators.join(', ')}.` : ''}${q.ferry.notes ? ` ${q.ferry.notes}` : ''} Check the operator for fares and schedules.`,
              provider: 'Ferry',
              sources: q.ferry.sources,
              comparable: [],
              routeWide: [],
              exactDates: [],
              hasLiveSearch: false,
              warnings: [],
            }
          : await services.fares.getFares({ origin: ORIGIN.iata, destination: q.destinationCode, departDate: q.startDate, returnDate: q.endDate, asOf: q.archive?.asOf }, ctrl.signal);
        const assessment = data.status === 'ok' ? assessFares(data, q.startDate, q.manualFareSgd) : null;
        if (!ctrl.signal.aborted) setFares({ state: 'done', value: { data, assessment } });
      } catch (e) {
        if (!ctrl.signal.aborted) setFares({ state: 'error', message: (e as Error).message });
      }
    })();
  }, []);

  return { query, weather, fares, run };
}

/** `comfort: false` skips the feels-like/snow fetches (compare rows don't show them). */
export async function evaluateWeather(q: TripQuery, signal: AbortSignal, opts: { comfort?: boolean } = {}): Promise<WeatherResult> {
  const wantComfort = opts.comfort ?? true;
  // The same plan drives the server's background prefetch for saved destinations.
  // A past trip is analysed as of its start date, matching the history stored before it.
  const today = q.archive?.asOf;
  const plan = tripFetchPlan(q.startDate, q.endDate, today);
  const { windows, main } = plan;
  if (!main) throw new Error('No complete historical years are available for these dates.');

  const ensoP = getEnso().catch(() => null);
  const history = await services.weather.getDaily(q.place.latitude, q.place.longitude, main.start, main.end, signal);

  // Older years for the odds: only the trip ±7 days in each year, fetched through the cache
  // server (which stores every day in SQLite, so a repeat search costs no API budget).
  const older = plan.older;
  const extraNotes: string[] = [];
  const extra = await mapLimit(older, 3, async (w) => {
    try {
      // Optional extra years: don't hold up the result for long when the API budget is busy.
      return (await services.weather.getDaily(q.place.latitude, q.place.longitude, w.start, w.end, signal, { maxWaitSec: 20 })).daily;
    } catch (e) {
      if (signal.aborted) throw e;
      extraNotes.push(`${w.year}: ${(e as Error).message}`);
      return [];
    }
  });
  // Feels-like highs/lows and snowfall: only for the trip dates in the last 10 years (about
  // 1 API unit each the first time; stored afterwards). Optional, like the older years.
  let comfortMissing = 0;
  const extended = wantComfort
    ? (
        await mapLimit(windows, 3, async (w) => {
          try {
            return (await services.weather.getDaily(q.place.latitude, q.place.longitude, w.start, w.end, signal, { maxWaitSec: 20, extended: true })).daily;
          } catch (e) {
            if (signal.aborted) throw e;
            comfortMissing++;
            return [];
          }
        })
      ).flat()
    : [];
  const extByDate = new Map(extended.map((d) => [d.date, d]));
  const comfortDaily = history.daily.map((d) => {
    const x = extByDate.get(d.date);
    return x ? { ...d, feelsMaxC: x.feelsMaxC, feelsMinC: x.feelsMinC, snowCm: x.snowCm } : d;
  });

  const merged = new Map(history.daily.map((d) => [d.date, d]));
  extra.flat().forEach((d) => merged.has(d.date) || merged.set(d.date, d));
  const allDaily = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  const ensoData = await ensoP;
  const mid = addDays(q.startDate, Math.floor(daysBetween(q.startDate, q.endDate) / 2));
  const enso = ensoData ? ensoOutlook(ensoData.series, mid) : null;
  const odds = computeOdds(allDaily, q.startDate, q.endDate, { oni: ensoData?.series, enso, today });
  const tripMonths = monthsInRange(q.startDate, q.endDate);
  const risks = services.risks.risksFor(q.place, tripMonths);
  // A first pass gives the monthly climatology, which feeds a data-derived risk.
  const pre = analyseWeather(history.daily, windows, q.startDate, q.endDate, risks);

  const wetTripMonths = tripMonths.filter((m) => pre.wettestMonths.includes(m));
  if (wetTripMonths.length) {
    const ranked = pre.wettestMonths.map(monthName).join(', ');
    risks.push({
      id: 'data-wettest-months',
      title: `Among this location's wettest months`,
      description: `In the ${history.datasetName.split(' (')[0]} record for this location, the three wettest months on average are ${ranked}. Your trip falls in ${wetTripMonths.map(monthName).join(' and ')}.`,
      severity: 'info',
      inPeak: false,
      source: history.sources[0],
      basis: 'data',
    });
  }
  const analysis = analyseWeather(history.daily, windows, q.startDate, q.endDate, risks, odds);
  const rainContext = analyseRainContext(history.daily, windows, q.startDate, q.endDate);
  const comfort = wantComfort
    ? analyseComfort(comfortDaily, windows, q.startDate, q.endDate, { lat: q.place.latitude, lon: q.place.longitude, timeZone: history.timezone }, analysis.tMax.mean)
    : null;
  return { history, analysis, risks, rainContext, enso, ensoSource: ensoData?.source ?? null, extraNotes, comfort, comfortMissing };
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
