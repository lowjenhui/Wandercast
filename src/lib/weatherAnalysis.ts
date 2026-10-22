import type { DailyWeather, SeasonalRisk } from '../types';
import { addDays, daysBetween, formatShortDate, monthsInRange, type YearWindow } from './dates';
import type { TripOdds } from './tripOdds';
import { clamp, mean, median, notNull, quantile, scoreLinear, stdDev } from './stats';

export const WET_DAY_MM = 1;
export const HEAVY_RAIN_MM = 20;
export const HOT_DAY_C = 33;
/** Average daily highs at or below this, or at or above SEVERE_HEAT_C, rate Challenging at best. */
export const SEVERE_COLD_C = 0;
export const SEVERE_HEAT_C = 38;
/** Average daily highs below this are Generally pleasant at best, however dry. */
export const COOL_C = 15;

export interface YearStats {
  year: number;
  start: string;
  end: string;
  daysWithData: number;
  wetDays: number;
  totalRainMm: number;
  heavyRainDays: number;
  wettestDayMm: number;
  meanTMaxC: number | null;
  meanTMinC: number | null;
  meanRhPct: number | null;
  hotDays: number;
  /** Per trip day: precipitation (index aligned with trip day). */
  dailyPrecip: (number | null)[];
}

export interface Range {
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  sd: number | null;
}

export interface MonthClimate {
  month: number;
  meanRainMm: number | null;
  meanWetDays: number | null;
  meanTMaxC: number | null;
  inTrip: boolean;
}

export type SuitabilityRating = 'Pleasant' | 'Generally pleasant' | 'Mixed' | 'Challenging';
export type Confidence = 'high' | 'medium' | 'low';

export interface ScoreComponent {
  key: 'rain' | 'temperature' | 'humidity' | 'risk';
  label: string;
  score: number; // 0–100 (risk: penalty points)
  note: string;
}

export interface Suitability {
  score: number;
  rating: SuitabilityRating;
  headline: string;
  components: ScoreComponent[];
}

export interface WeatherAnalysis {
  tripDays: number;
  years: YearStats[]; // newest first
  wetDays: Range;
  totalRain: Range;
  tMax: Range;
  tMin: Range;
  rh: Range | null;
  heavyRainDaysMean: number | null;
  hotDaysMean: number | null;
  dailyWetChance: { label: string; pct: number }[];
  lastYear: YearStats | null;
  lastYearNotes: string[];
  monthly: MonthClimate[];
  wettestMonths: number[];
  confidence: Confidence;
  confidenceNotes: string[];
  suitability: Suitability | null;
  /** Probabilities from weighted sample trips over more years (null when not computed). */
  odds: TripOdds | null;
}

function range(xs: number[]): Range {
  return {
    mean: mean(xs),
    median: median(xs),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    min: xs.length ? Math.min(...xs) : null,
    max: xs.length ? Math.max(...xs) : null,
    sd: stdDev(xs),
  };
}

export function yearStats(byDate: Map<string, DailyWeather>, w: YearWindow): YearStats {
  const n = daysBetween(w.start, w.end) + 1;
  const days: (DailyWeather | undefined)[] = [];
  for (let i = 0; i < n; i++) days.push(byDate.get(addDays(w.start, i)));
  const precip = days.map((d) => d?.precipMm ?? null);
  const p = precip.filter(notNull);
  const tmax = days.map((d) => d?.tMaxC).filter(notNull);
  const tmin = days.map((d) => d?.tMinC).filter(notNull);
  const rh = days.map((d) => d?.rhMeanPct).filter(notNull);
  return {
    year: w.year,
    start: w.start,
    end: w.end,
    daysWithData: p.length,
    wetDays: p.filter((x) => x >= WET_DAY_MM).length,
    totalRainMm: p.reduce((a, b) => a + b, 0),
    heavyRainDays: p.filter((x) => x >= HEAVY_RAIN_MM).length,
    wettestDayMm: p.length ? Math.max(...p) : 0,
    meanTMaxC: mean(tmax),
    meanTMinC: mean(tmin),
    meanRhPct: mean(rh),
    hotDays: tmax.filter((x) => x >= HOT_DAY_C).length,
    dailyPrecip: precip,
  };
}

/** Mean monthly rainfall/temperature across all complete months in the dataset. */
export function monthlyClimate(daily: DailyWeather[], tripMonths: number[]): MonthClimate[] {
  const groups = new Map<string, DailyWeather[]>();
  for (const d of daily) {
    const key = d.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }
  const perMonth = new Map<number, { rain: number[]; wet: number[]; tmax: number[] }>();
  for (const [key, days] of groups) {
    const [y, m] = key.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const p = days.map((d) => d.precipMm).filter(notNull);
    if (p.length < daysInMonth * 0.9) continue; // skip incomplete months
    const slot = perMonth.get(m) ?? { rain: [], wet: [], tmax: [] };
    slot.rain.push((p.reduce((a, b) => a + b, 0) / p.length) * daysInMonth);
    slot.wet.push((p.filter((x) => x >= WET_DAY_MM).length / p.length) * daysInMonth);
    const t = mean(days.map((d) => d.tMaxC).filter(notNull));
    if (t !== null) slot.tmax.push(t);
    perMonth.set(m, slot);
  }
  return Array.from({ length: 12 }, (_, i) => {
    const s = perMonth.get(i + 1);
    return {
      month: i + 1,
      meanRainMm: s ? mean(s.rain) : null,
      meanWetDays: s ? mean(s.wet) : null,
      meanTMaxC: s ? mean(s.tmax) : null,
      inTrip: tripMonths.includes(i + 1),
    };
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function rainScore(wetShare: number, heavyPerWeek: number): number {
  // 10% of days wet or fewer is ideal; 60%+ is poor. Heavy-rain days cost extra.
  return clamp(scoreLinear(wetShare, 0.1, 0.6) - heavyPerWeek * 8, 0, 100);
}

function temperatureScore(tmax: number, tmin: number): number {
  // Comfortable daytime highs 20–29 °C; scale down to 0 at 5 °C or 38 °C.
  let s = tmax < 20 ? scoreLinear(tmax, 20, 5) : tmax > 29 ? scoreLinear(tmax, 29, 38) : 100;
  if (tmin < 0) s -= Math.min(20, -tmin * 3); // freezing nights
  return clamp(s, 0, 100);
}

function humidityScore(rh: number, tmax: number): number {
  // Humidity matters mostly when it is warm.
  const raw = scoreLinear(rh, 65, 90);
  const weight = clamp((tmax - 18) / 10, 0, 1);
  return 100 - (100 - raw) * weight;
}

export function scoreSuitability(
  input: { wetShare: number; heavyPerWeek: number; tMax: number; tMin: number; rh: number | null },
  risks: SeasonalRisk[],
): Suitability {
  const rain = rainScore(input.wetShare, input.heavyPerWeek);
  const temp = temperatureScore(input.tMax, input.tMin);
  const hum = input.rh === null ? null : humidityScore(input.rh, input.tMax);
  const riskPenalty = Math.min(
    25,
    risks.reduce((a, r) => a + (r.severity === 'high' ? (r.inPeak ? 15 : 10) : r.severity === 'moderate' ? 5 : 0), 0),
  );
  const base = hum === null ? rain * 0.55 + temp * 0.45 : rain * 0.45 + temp * 0.35 + hum * 0.2;
  const score = Math.round(clamp(base - riskPenalty, 0, 100));
  let rating: SuitabilityRating =
    score >= 75 ? 'Pleasant' : score >= 60 ? 'Generally pleasant' : score >= 45 ? 'Mixed' : 'Challenging';
  // Weakest link: one very poor factor (e.g. cold, or near-daily rain) caps the overall rating.
  const weakestScore = Math.min(rain, temp, hum ?? 100);
  const order: SuitabilityRating[] = ['Challenging', 'Mixed', 'Generally pleasant', 'Pleasant'];
  // Severe cold or heat is never better than Challenging, however dry and calm: average highs at
  // or below freezing (Harbin or Sapporo in January), or at or above 38 °C.
  const severe = input.tMax <= SEVERE_COLD_C || input.tMax >= SEVERE_HEAT_C;
  // Cool days (highs below 15 °C, Beijing in March) are never fully pleasant either: in cool
  // weather humidity scores full marks, which would otherwise lift a dry, chilly trip to Pleasant.
  const cap: SuitabilityRating = severe
    ? 'Challenging'
    : weakestScore < 25
      ? 'Mixed'
      : weakestScore < 50 || input.tMax < COOL_C
        ? 'Generally pleasant'
        : 'Pleasant';
  if (order.indexOf(rating) > order.indexOf(cap)) rating = cap;

  const pct = Math.round(input.wetShare * 100);
  const components: ScoreComponent[] = [
    {
      key: 'rain',
      label: 'Rain',
      score: Math.round(rain),
      note:
        pct <= 15 ? `Mostly dry: about ${pct}% of days are wet.`
        : pct <= 35 ? `Some showers likely: about ${pct}% of days are wet.`
        : pct <= 55 ? `Frequently wet: about ${pct}% of days are wet.`
        : `Very wet: about ${pct}% of days are wet.`,
    },
    {
      key: 'temperature',
      label: 'Temperature',
      score: Math.round(temp),
      note:
        input.tMax >= SEVERE_HEAT_C ? `Extreme heat: average highs near ${input.tMax.toFixed(0)} °C.`
        : input.tMax <= SEVERE_COLD_C ? `Freezing: average highs near ${input.tMax.toFixed(0)} °C, below zero even by day.`
        : input.tMax > 33 ? `Hot: average highs near ${input.tMax.toFixed(0)} °C.`
        : input.tMax > 29 ? `Warm to hot: average highs near ${input.tMax.toFixed(0)} °C.`
        : input.tMax >= 20 ? `Comfortable: average highs near ${input.tMax.toFixed(0)} °C.`
        : input.tMax >= 10 ? `Cool: average highs near ${input.tMax.toFixed(0)} °C.`
        : `Cold: average highs near ${input.tMax.toFixed(0)} °C${input.tMin < 0 ? ', with frost at night' : ''}.`,
    },
  ];
  if (hum !== null && input.rh !== null) {
    components.push({
      key: 'humidity',
      label: 'Humidity',
      score: Math.round(hum),
      note:
        input.rh >= 80 && input.tMax >= 26 ? `Muggy: mean relative humidity ${input.rh.toFixed(0)}%.`
        : input.rh >= 70 ? `Fairly humid: mean relative humidity ${input.rh.toFixed(0)}%.`
        : `Comfortable humidity: mean ${input.rh.toFixed(0)}%.`,
    });
  }
  if (riskPenalty > 0) {
    components.push({
      key: 'risk',
      label: 'Seasonal risks',
      score: -riskPenalty,
      note: `Overlaps ${risks.filter((r) => r.severity !== 'info').map((r) => r.title.toLowerCase()).join('; ')}.`,
    });
  }

  const weakest = [...components].filter((c) => c.key !== 'risk').sort((a, b) => a.score - b.score)[0];
  const headline =
    rating === 'Pleasant' ? 'Historically, these dates usually have pleasant weather.'
    : rating === 'Generally pleasant' ? `Usually decent weather. The main drawback: ${weakest.note.charAt(0).toLowerCase() + weakest.note.slice(1)}`
    : rating === 'Mixed' ? `Mixed conditions are typical. ${weakest.note}`
    : `These dates have often had difficult weather. ${weakest.note}`;

  return { score, rating, headline, components };
}

export function analyseWeather(
  daily: DailyWeather[],
  windows: YearWindow[],
  tripStart: string,
  tripEnd: string,
  risks: SeasonalRisk[],
  odds: TripOdds | null = null,
): WeatherAnalysis {
  const tripDays = daysBetween(tripStart, tripEnd) + 1;
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const all = windows.map((w) => yearStats(byDate, w));
  // Keep only years with at least 80% of trip days present.
  const years = all.filter((y) => y.daysWithData >= Math.ceil(tripDays * 0.8));

  const wet = years.map((y) => (y.wetDays / y.daysWithData) * tripDays);
  const rain = years.map((y) => (y.totalRainMm / y.daysWithData) * tripDays);
  const tMax = years.map((y) => y.meanTMaxC).filter(notNull);
  const tMin = years.map((y) => y.meanTMinC).filter(notNull);
  const rh = years.map((y) => y.meanRhPct).filter(notNull);

  const dailyWetChance = Array.from({ length: tripDays }, (_, i) => {
    const vals = years.map((y) => y.dailyPrecip[i]).filter(notNull);
    return {
      label: formatShortDate(addDays(tripStart, i)),
      pct: vals.length ? Math.round((vals.filter((v) => v >= WET_DAY_MM).length / vals.length) * 100) : 0,
    };
  });

  const monthly = monthlyClimate(daily, monthsInRange(tripStart, tripEnd));
  const wettestMonths = [...monthly]
    .filter((m) => m.meanRainMm !== null)
    .sort((a, b) => b.meanRainMm! - a.meanRainMm!)
    .slice(0, 3)
    .map((m) => m.month);

  const wetR = range(wet);
  const rainR = range(rain);
  const tMaxR = range(tMax);
  const lastYear = years[0] && years[0].year === windows[0]?.year ? years[0] : null;
  const lastYearNotes: string[] = [];
  if (lastYear && wetR.mean !== null && rainR.median !== null && tMaxR.mean !== null) {
    const dWet = lastYear.wetDays - wetR.mean;
    lastYearNotes.push(
      Math.abs(dWet) < 1
        ? `${plural(lastYear.wetDays, 'wet day')}: about average (${wetR.mean.toFixed(1)}).`
        : `${plural(lastYear.wetDays, 'wet day')}: ${dWet > 0 ? 'wetter' : 'drier'} than the ${years.length}-year average of ${wetR.mean.toFixed(1)}.`,
    );
    // Ignore ratios for tiny amounts: 3 mm vs 2 mm is not "well above normal".
    const diff = lastYear.totalRainMm - rainR.median;
    const ratio = rainR.median > 0 ? lastYear.totalRainMm / rainR.median : null;
    const verdict =
      Math.abs(diff) < 10 ? 'similar to normal'
      : ratio === null || ratio > 1.5 ? 'well above normal'
      : ratio < 0.67 ? 'well below normal'
      : 'within the normal range';
    lastYearNotes.push(`${lastYear.totalRainMm.toFixed(0)} mm of rain vs a typical (median) ${rainR.median.toFixed(0)} mm: ${verdict}.`);
    if (lastYear.meanTMaxC !== null) {
      const dT = lastYear.meanTMaxC - tMaxR.mean;
      lastYearNotes.push(
        `Average high ${lastYear.meanTMaxC.toFixed(1)} °C (${dT >= 0 ? '+' : ''}${dT.toFixed(1)} °C vs the multi-year average).`,
      );
    }
    if (lastYear.heavyRainDays > 0) {
      lastYearNotes.push(`${plural(lastYear.heavyRainDays, 'heavy-rain day')} of ≥${HEAVY_RAIN_MM} mm; the wettest day had ${lastYear.wettestDayMm.toFixed(0)} mm.`);
    }
  }

  const confidenceNotes: string[] = [];
  let confidence: Confidence = 'high';
  if (odds) {
    const ny = odds.years;
    confidence = ny >= 15 ? 'high' : ny >= 8 ? 'medium' : 'low';
    confidenceNotes.push(
      `Odds use ${odds.samples} sample trips from ${ny} years (${odds.firstYear}–${odds.lastYear}), sliding your dates up to ±${odds.pad} days; weighting leaves the equivalent of about ${Math.round(odds.effectiveYears)} independent years.`,
    );
  } else if (years.length < 5) {
    confidence = 'low';
    confidenceNotes.push(`Only ${years.length} complete year(s) of data were available.`);
  } else if (years.length < 8) {
    confidence = 'medium';
    confidenceNotes.push(`${years.length} complete years available (target 10).`);
  } else {
    confidenceNotes.push(`${years.length} complete years of consistent reanalysis data.`);
  }
  if (rh.length === 0) confidenceNotes.push('Humidity was not available for this location.');
  const cv = rainR.mean && rainR.sd ? rainR.sd / rainR.mean : 0;
  if (cv > 0.8 && years.length >= 5 && (rainR.median ?? 0) >= 10) {
    if (confidence === 'high') confidence = 'medium';
    confidenceNotes.push('Rainfall varies a lot from year to year, so any single trip may differ considerably from the average.');
  }
  if (tripDays < 4) confidenceNotes.push('For very short trips, a single rainy day changes the picture a lot.');

  const suitability =
    odds && odds.meanTMax !== null && odds.meanTMin !== null
      ? scoreSuitability(
          { wetShare: odds.meanWetShare, heavyPerWeek: odds.meanHeavyPerWeek, tMax: odds.meanTMax, tMin: odds.meanTMin, rh: odds.meanRh },
          risks,
        )
      : years.length && wetR.mean !== null && tMaxR.mean !== null && tMin.length
      ? scoreSuitability(
          {
            wetShare: wetR.mean / tripDays,
            heavyPerWeek: ((mean(years.map((y) => y.heavyRainDays)) ?? 0) / tripDays) * 7,
            tMax: tMaxR.mean,
            tMin: mean(tMin)!,
            rh: mean(rh),
          },
          risks,
        )
      : null;

  return {
    tripDays,
    years,
    wetDays: wetR,
    totalRain: rainR,
    tMax: tMaxR,
    tMin: range(tMin),
    rh: rh.length ? range(rh) : null,
    heavyRainDaysMean: mean(years.map((y) => y.heavyRainDays)),
    hotDaysMean: mean(years.map((y) => y.hotDays)),
    dailyWetChance,
    lastYear,
    lastYearNotes,
    monthly,
    wettestMonths,
    confidence,
    confidenceNotes,
    suitability,
    odds,
  };
}
