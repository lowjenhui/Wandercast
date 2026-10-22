// ENSO index (NOAA ONI) from the local server, which keeps it in SQLite and refreshes weekly.

import { OniSeries, type OniPoint } from '../lib/enso';
import { getJson } from './http';

export interface EnsoData {
  series: OniSeries;
  source: { name: string; url: string };
  fetchedAt: number;
}

let cached: Promise<EnsoData> | null = null;

/** Shared across callers; a failure is not cached, so the next caller retries. */
export function getEnso(): Promise<EnsoData> {
  cached ??= getJson<{ series: OniPoint[]; source: { name: string; url: string }; fetchedAt: number }>('/api/climate/enso', {}, 30_000)
    .then((d) => ({ series: new OniSeries(d.series), source: d.source, fetchedAt: d.fetchedAt }))
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}
