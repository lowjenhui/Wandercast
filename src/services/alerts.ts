// Unrest and security alerts (US embassies, UK FCDO) from the local server. Informational only:
// nothing here feeds MFA levels, insurer cover, ratings or filtering.

import { useEffect, useState } from 'react';
import { alertsAt, type AlertFeed, type PlaceAlerts, type TravelAlert } from '../lib/alerts';
import { getJson } from './http';

let cached: Promise<AlertFeed> | null = null;

/** Shared across callers; a failure is not cached, so the next caller retries. */
export function loadAlerts(): Promise<AlertFeed> {
  cached ??= getJson<AlertFeed>('/api/alerts').catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

/** Active alerts once loaded (empty while loading or if the server couldn't be reached). */
export function useAlerts(): TravelAlert[] {
  const [alerts, setAlerts] = useState<TravelAlert[]>([]);
  useEffect(() => {
    let live = true;
    loadAlerts().then(
      (f) => live && setAlerts(f.alerts),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return alerts;
}

/** Alerts for a place (city-matched and country-level). */
export function useAlertsAt(p: { cc: string; lat: number; lon: number } | null): PlaceAlerts {
  const alerts = useAlerts();
  return p ? alertsAt(alerts, p) : { near: [], country: [] };
}
