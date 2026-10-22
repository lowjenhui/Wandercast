// Recent rain vs normal: has it been unusually wet at a place lately?
//
// Rain over the last 7 and 30 days is compared with the same calendar days in the past 10
// years. It flags heavy rain, not flooding itself: floods from rivers upstream can show only
// a moderate signal (Bangkok, Oct 2026: 1.6× normal).

export type RecentRainLevel = 'usual' | 'wetter' | 'much-wetter';

/** Below this much normal rain over 30 days, a single shower would read as several times normal. */
export const MIN_NORMAL_30_MM = 30;
/** The 7-day trigger also needs this much rain, so a dry-season shower doesn't count. */
export const MIN_RAIN_7_MM = 30;

export const WETTER = { r30: 1.5, r7: 2 };
export const MUCH_WETTER = { r30: 2, r7: 3 };

export interface RecentRainWeek {
  /** First day of the week. */
  start: string;
  /** Null when too few days of the week are stored. */
  mm: number | null;
  normalMm: number;
}

export interface RecentRain {
  lat: number;
  lon: number;
  /** Last day counted (yesterday). */
  end: string;
  mm7: number;
  normal7: number;
  mm30: number;
  normal30: number;
  wetDays30: number;
  usualWetDays30: number;
  /** Past years the normal is built from. */
  years: number;
  level: RecentRainLevel;
  /** Oldest first; only in the single-place response. */
  weeks?: RecentRainWeek[];
}

export function recentRainLevel(x: { mm7: number; normal7: number; mm30: number; normal30: number }): RecentRainLevel {
  if (x.normal30 < MIN_NORMAL_30_MM) return 'usual';
  const r30 = x.mm30 / x.normal30;
  const r7 = x.normal7 > 0 && x.mm7 >= MIN_RAIN_7_MM ? x.mm7 / x.normal7 : 0;
  if (r30 >= MUCH_WETTER.r30 || r7 >= MUCH_WETTER.r7) return 'much-wetter';
  if (r30 >= WETTER.r30 || r7 >= WETTER.r7) return 'wetter';
  return 'usual';
}

export const RECENT_RAIN_LABEL: Record<RecentRainLevel, string> = {
  usual: 'About usual',
  wetter: 'Wetter than usual',
  'much-wetter': 'Much wetter than usual',
};

/** "1.6×" style multiple of normal, or null where the normal is too small to compare. */
export function timesNormal(mm: number, normal: number): string | null {
  if (normal <= 0) return null;
  const r = mm / normal;
  return `${r < 10 ? r.toFixed(1) : Math.round(r)}×`;
}
