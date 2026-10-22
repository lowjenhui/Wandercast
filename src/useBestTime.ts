import { useEffect, useState } from 'react';
import { bestTimeFetchRange } from './lib/bestTime';
import { addDays } from './lib/dates';
import type { OniSeries } from './lib/enso';
import { getEnso } from './services/enso';
import { services } from './services';
import { mapLimit } from './useTripEvaluation';
import type { DailyWeather, Place, SourceRef } from './types';

export interface BestTimeHistory {
  daily: DailyWeather[];
  oni: OniSeries | null;
  ensoSource: SourceRef | null;
  datasetName: string;
  sources: SourceRef[];
  /** IANA time zone of the place, for local sunrise and sunset. */
  timezone?: string;
  /** Years that couldn't be retrieved (the scores then use fewer years). */
  notes: string[];
}

export type BestTimeLoad =
  | { state: 'idle' }
  | { state: 'loading'; done: number; total: number }
  | { state: 'error'; message: string }
  | { state: 'done'; value: BestTimeHistory };

/** Calendar-year pieces of a range, so progress can be shown and stored years return at once. */
function yearChunks(start: string, end: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (let s = start; s <= end; ) {
    const yEnd = `${s.slice(0, 4)}-12-31`;
    const e = yEnd < end ? yEnd : end;
    out.push({ start: s, end: e });
    s = addDays(e, 1);
  }
  return out;
}

/**
 * About 10 years of daily ERA5 history for one place. Stored years come straight from the
 * local database; missing ones are fetched on the search lane and stored permanently, so a
 * repeat search costs nothing.
 */
export function useBestTimeHistory(place: Place | null): BestTimeLoad {
  const [load, setLoad] = useState<BestTimeLoad>({ state: 'idle' });
  const lat = place?.latitude;
  const lon = place?.longitude;

  useEffect(() => {
    if (lat === undefined || lon === undefined) {
      setLoad({ state: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    const range = bestTimeFetchRange();
    const chunks = yearChunks(range.start, range.end);
    let done = 0;
    setLoad({ state: 'loading', done, total: chunks.length });
    const ensoP = getEnso().catch(() => null);
    const notes: string[] = [];

    void (async () => {
      try {
        const parts = await mapLimit(chunks, 3, async (c) => {
          try {
            return await services.weather.getDaily(lat, lon, c.start, c.end, ctrl.signal);
          } catch (e) {
            if (ctrl.signal.aborted) throw e;
            notes.push(`${c.start.slice(0, 4)}: ${(e as Error).message}`);
            return null;
          } finally {
            done++;
            if (!ctrl.signal.aborted) setLoad({ state: 'loading', done, total: chunks.length });
          }
        });
        const ok = parts.filter((p) => p !== null);
        if (!ok.length) throw new Error(notes[0]?.replace(/^\d{4}: /, '') ?? 'Weather provider returned no data');
        const enso = await ensoP;
        if (ctrl.signal.aborted) return;
        setLoad({
          state: 'done',
          value: {
            daily: ok.flatMap((p) => p.daily),
            oni: enso?.series ?? null,
            ensoSource: enso?.source ?? null,
            datasetName: ok[0].datasetName,
            sources: ok[0].sources,
            timezone: ok[0].timezone,
            notes: notes.sort(),
          },
        });
      } catch (e) {
        if (!ctrl.signal.aborted) setLoad({ state: 'error', message: (e as Error).message });
      }
    })();
    return () => ctrl.abort();
  }, [lat, lon]);

  return load;
}
