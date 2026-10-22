import type { FareData, FareObservation } from '../types';
import { formatPrice } from './currency';
import { daysBetween, todayISO } from './dates';
import { median, quantile } from './stats';

export const MIN_BENCHMARK_SAMPLE = 8;
export const MIN_ROUTE_SAMPLE = 15;

export interface FareBenchmark {
  sampleSize: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  sufficient: boolean;
  observedFrom?: string;
  observedTo?: string;
  observationSpanDays?: number;
  departFrom?: string;
  departTo?: string;
  directShare: number | null;
}

export type FareValue = 'Good value' | 'Typical' | 'Expensive';
export type SeasonalPosition = 'Cheaper than usual' | 'About usual' | 'Pricier than usual';

export interface FareAssessment {
  benchmark: FareBenchmark;
  routeWide: FareBenchmark;
  /** Fare used for the value judgement and where it came from. */
  reference: { priceSgd: number; kind: 'manual' | 'live' | 'cached-exact' } | null;
  value: FareValue | null;
  percentile: number | null;
  seasonal: { position: SeasonalPosition; ratio: number } | null;
  headline: string;
  limitations: string[];
}

export function benchmarkOf(obs: FareObservation[]): FareBenchmark {
  const prices = obs.map((o) => o.priceSgd);
  const found = obs.map((o) => o.foundAt?.slice(0, 10)).filter((x): x is string => Boolean(x)).sort();
  const departs = obs.map((o) => o.departDate).sort();
  const withTransfers = obs.filter((o) => o.transfers !== undefined);
  return {
    sampleSize: obs.length,
    median: median(prices),
    p25: quantile(prices, 0.25),
    p75: quantile(prices, 0.75),
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    sufficient: obs.length >= MIN_BENCHMARK_SAMPLE,
    observedFrom: found[0],
    observedTo: found[found.length - 1],
    observationSpanDays: found.length ? daysBetween(found[0], found[found.length - 1]) : undefined,
    departFrom: departs[0],
    departTo: departs[departs.length - 1],
    directShare: withTransfers.length ? withTransfers.filter((o) => o.transfers === 0).length / withTransfers.length : null,
  };
}

function percentileRank(xs: number[], x: number): number {
  return Math.round((xs.filter((v) => v < x).length + 0.5 * xs.filter((v) => v === x).length) / xs.length * 100);
}

export function assessFares(data: FareData, departDate: string, manualFareSgd?: number): FareAssessment {
  const benchmark = benchmarkOf(data.comparable);
  const routeWide = benchmarkOf(data.routeWide);
  const cheapestLive = data.live?.cheapestTotal ?? null;
  const limitations: string[] = [
    'Travelpayouts fares are prices that Aviasales users found in recent searches and that the provider cached. They are not a complete record of all fares, and the provider keeps no multi-year fare history.',
    cheapestLive !== null
      ? 'Live prices come from Google Flights through SerpApi for 1 adult in economy, as two one-way tickets (outbound plus return). A return ticket on one airline can be cheaper, prices can change before booking, and a saved search may be up to 6 hours old (or older when shown as saved).'
      : 'No live prices are available for this search, so current bookable fares are not shown. Cached fares may have changed or sold out.',
  ];

  const cheapestExact = data.exactDates.length ? Math.min(...data.exactDates.map((o) => o.priceSgd)) : null;
  const reference =
    manualFareSgd && manualFareSgd > 0
      ? { priceSgd: manualFareSgd, kind: 'manual' as const }
      : cheapestLive !== null
        ? { priceSgd: cheapestLive, kind: 'live' as const }
        : cheapestExact !== null
          ? { priceSgd: cheapestExact, kind: 'cached-exact' as const }
          : null;

  let value: FareValue | null = null;
  let percentile: number | null = null;
  if (benchmark.sufficient && reference && benchmark.p25 !== null && benchmark.p75 !== null) {
    percentile = percentileRank(data.comparable.map((o) => o.priceSgd), reference.priceSgd);
    value = reference.priceSgd <= benchmark.p25 ? 'Good value' : reference.priceSgd <= benchmark.p75 ? 'Typical' : 'Expensive';
  }

  let seasonal: FareAssessment['seasonal'] = null;
  if (benchmark.sufficient && routeWide.sampleSize >= MIN_ROUTE_SAMPLE && benchmark.median && routeWide.median) {
    const ratio = benchmark.median / routeWide.median;
    seasonal = { ratio, position: ratio < 0.9 ? 'Cheaper than usual' : ratio > 1.1 ? 'Pricier than usual' : 'About usual' };
  }

  if (!benchmark.sufficient) {
    limitations.push(
      `Only ${benchmark.sampleSize} comparable fare observation(s) were found. At least ${MIN_BENCHMARK_SAMPLE} are needed for a reliable typical range and median.`,
    );
  }
  if (benchmark.observationSpanDays !== undefined && benchmark.observationSpanDays < 30) {
    limitations.push(
      `The observations span only ${benchmark.observationSpanDays + 1} day(s) of searches. This reflects recent pricing for nearby dates, not a long-run historical average.`,
    );
  }
  if (data.status === 'ok' && daysBetween(todayISO(), departDate) <= 14) {
    limitations.push('Departure is soon. Fares usually rise close to departure, so cached prices are especially likely to be out of date.');
  }

  const fmt = formatPrice;
  let headline: string;
  if (value && reference) {
    const src =
      reference.kind === 'manual' ? 'The fare you entered'
      : reference.kind === 'live' ? 'The cheapest live Google Flights outbound plus return for your dates'
      : 'The cheapest recently cached fare for your exact dates';
    headline = `${src} (${fmt(reference.priceSgd)}) looks ${value === 'Good value' ? 'like good value' : value === 'Typical' ? 'typical' : 'expensive'} against comparable trips (median ${fmt(benchmark.median!)}).`;
  } else if (reference?.kind === 'live') {
    headline = `The cheapest live Google Flights outbound plus return for your dates is ${fmt(reference.priceSgd)}. There are too few comparable observations to judge whether that is good value.`;
  } else if (benchmark.sufficient) {
    headline = `Comparable trips have recently been seen for ${fmt(benchmark.p25!)}–${fmt(benchmark.p75!)} (median ${fmt(benchmark.median!)}). No fare for your exact dates was available to compare.`;
  } else {
    headline = 'Not enough airfare evidence to judge whether these dates are good value.';
  }

  return { benchmark, routeWide, reference, value, percentile, seasonal, headline, limitations };
}

