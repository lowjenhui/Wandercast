// Provider wiring. Swap an implementation here without touching the UI.
import { openMeteoAirQuality, openMeteoCurrent } from './currentWeather';
import { gdacsHazards, type HazardService } from './hazards';
import { PointStore, type PointData } from './weatherStore';
import { travelpayoutsFares, type FareService } from './fares';
import { openMeteoGeocoding, type GeocodingService } from './geocoding';
import { curatedSeasonalRisks, type SeasonalRiskService } from './seasonalRisks';
import { openMeteoEra5, type WeatherHistoryService } from './weather';

export const services: {
  geocoding: GeocodingService;
  weather: WeatherHistoryService;
  current: PointStore<PointData>;
  hazards: HazardService;
  fares: FareService;
  risks: SeasonalRiskService;
} = {
  geocoding: openMeteoGeocoding,
  weather: openMeteoEra5,
  current: new PointStore<PointData>({
    // Weather is essential; air quality is best-effort.
    // Read from the database only; the API is used only when the user reloads the map.
    fetchBatch: async (points, { refresh }) => {
      const [w, a] = await Promise.allSettled([openMeteoCurrent.getCurrent(points, undefined, refresh), openMeteoAirQuality.getCurrent(points, undefined, refresh)]);
      if (w.status === 'rejected') throw w.reason;
      return points.map((_, i) => ({ weather: w.value[i] ?? null, aq: a.status === 'fulfilled' ? (a.value[i] ?? null) : null }));
    },
    costPerPoint: (refresh) => (refresh ? 2 : 0),
    batchSize: 80,
    ttlMs: 15 * 60_000,
    storageKey: 'wandercast.pointWeather.v4',
  }),
  hazards: gdacsHazards,
  fares: travelpayoutsFares,
  risks: curatedSeasonalRisks,
};
