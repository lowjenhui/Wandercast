import type { WeatherHistory } from '../types';
import { getJson, OPEN_METEO, type ServiceError } from './http';

export interface WeatherHistoryService {
  /** Daily history for an inclusive date range at a location. */
  /** `extended` adds feels-like highs and lows and snowfall (first use refetches stored days). */
  getDaily(lat: number, lon: number, start: string, end: string, signal?: AbortSignal, opts?: { maxWaitSec?: number; extended?: boolean; storedOnly?: boolean }): Promise<WeatherHistory>;
}

interface ArchiveResponse {
  latitude: number;
  longitude: number;
  elevation?: number;
  timezone?: string;
  daily?: {
    time: string[];
    precipitation_sum: (number | null)[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    relative_humidity_2m_mean?: (number | null)[];
    apparent_temperature_max?: (number | null)[];
    apparent_temperature_min?: (number | null)[];
    snowfall_sum?: (number | null)[];
  };
  error?: boolean;
  reason?: string;
}

/**
 * Open-Meteo Historical Weather API pinned to the ERA5 reanalysis model, so every
 * year comes from the same consistent dataset (no blending with newer models).
 */
export const openMeteoEra5: WeatherHistoryService = {
  async getDaily(lat, lon, start, end, signal, opts = {}) {
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      start_date: start,
      end_date: end,
      daily: `precipitation_sum,temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean${opts.extended ? ',apparent_temperature_max,apparent_temperature_min,snowfall_sum' : ''}`,
      models: 'era5',
      timezone: 'auto',
    });
    // Stored days only: the server never calls the API (places not stored come back empty).
    if (opts.storedOnly) params.set('stored', '1');
    // The cache server answers 429 with Retry-After when the shared API budget is busy.
    let data: ArchiveResponse | undefined;
    // Optional fetches can cap the total time spent waiting on a busy budget.
    let waitLeft = opts.maxWaitSec ?? Infinity;
    for (let attempt = 0; ; attempt++) {
      try {
        data = await getJson<ArchiveResponse>(`${OPEN_METEO.archive}?${params}`, { signal }, 90_000);
        break;
      } catch (e) {
        const err = e as ServiceError;
        // Short waits are retried; a used-up daily allowance is reported straight away.
        const wait = err.retryAfter ?? 15;
        if (err.status !== 429 || attempt >= 4 || signal?.aborted || wait > 90 || wait > waitLeft) throw e;
        waitLeft -= wait;
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    if (data.error || !data.daily) throw new Error(data.reason ?? 'Weather provider returned no data');
    const d = data.daily;
    return {
      daily: d.time.map((date, i) => ({
        date,
        precipMm: d.precipitation_sum[i] ?? null,
        tMaxC: d.temperature_2m_max[i] ?? null,
        tMinC: d.temperature_2m_min[i] ?? null,
        rhMeanPct: d.relative_humidity_2m_mean?.[i] ?? null,
        ...(opts.extended
          ? { feelsMaxC: d.apparent_temperature_max?.[i] ?? null, feelsMinC: d.apparent_temperature_min?.[i] ?? null, snowCm: d.snowfall_sum?.[i] ?? null }
          : {}),
      })),
      dataKind: 'reanalysis',
      datasetName: 'ECMWF ERA5 reanalysis (via Open-Meteo)',
      datasetNote:
        'ERA5 is a model-based reanalysis: weather observations blended into a global model on a ~25 km grid. It is consistent across years, but it is not a weather-station record. Local conditions, especially rainfall in hilly or coastal areas, can differ.',
      sources: [
        { name: 'Open-Meteo Historical Weather API', url: 'https://open-meteo.com/en/docs/historical-weather-api' },
        { name: 'ECMWF ERA5 (Copernicus Climate Change Service)', url: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels' },
      ],
      gridLatitude: data.latitude,
      gridLongitude: data.longitude,
      gridElevationM: data.elevation,
      timezone: data.timezone,
    };
  },
};
