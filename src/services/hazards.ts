import { getJson } from './http';

export type HazardKind = 'cyclone' | 'fire' | 'flood';

export interface Hazard {
  id: string;
  kind: HazardKind;
  name: string;
  alert: 'Green' | 'Orange' | 'Red' | string;
  lat: number;
  lon: number;
  countries: string;
  from: string;
  to: string;
  url?: string;
}

export interface HazardService {
  getActive(signal?: AbortSignal): Promise<Hazard[]>;
}

interface GdacsResponse {
  features?: Array<{
    geometry: { type: string; coordinates: [number, number] };
    properties: {
      eventtype: string;
      eventid: number;
      name: string;
      alertlevel: string;
      country?: string;
      fromdate: string;
      todate: string;
      iscurrent?: string | boolean;
      url?: { report?: string };
    };
  }>;
}

const KIND: Record<string, HazardKind> = { TC: 'cyclone', WF: 'fire', FL: 'flood' };

export const GDACS_SOURCE = { name: 'GDACS: Global Disaster Alert and Coordination System (UN / EU JRC)', url: 'https://www.gdacs.org/' };

let cache: { at: number; value: Promise<Hazard[]> } | null = null;
const CACHE_MS = 30 * 60_000;

/** Current GDACS events: tropical cyclones, wildfires and floods. Cached for 30 min. */
export const gdacsHazards: HazardService = {
  getActive() {
    // Shared, cached request: deliberately not tied to any one caller's abort signal.
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    const value = getJson<GdacsResponse>('https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP', {}, 20_000).then((d) =>
      (d.features ?? [])
        .filter((f) => KIND[f.properties.eventtype] && f.geometry?.type === 'Point' && String(f.properties.iscurrent) !== 'false')
        .map((f) => ({
          id: `${f.properties.eventtype}-${f.properties.eventid}`,
          kind: KIND[f.properties.eventtype],
          name: f.properties.name,
          alert: f.properties.alertlevel,
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          countries: f.properties.country ?? '',
          from: f.properties.fromdate,
          to: f.properties.todate,
          url: f.properties.url?.report,
        })),
    );
    cache = { at: Date.now(), value };
    value.catch(() => (cache = null));
    return value;
  },
};
