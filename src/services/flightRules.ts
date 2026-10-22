// Flight rules settings, stored by the local server (server/flightRulesStore.ts).

import { DEFAULT_FLIGHT_RULES, normaliseRules, type FlightRules } from '../lib/flightRules';
import { getJson, ServiceError } from './http';

const URL_ = '/api/settings/flight-rules';

/** Saved rules, or the defaults when the server can't be reached. */
export async function getFlightRules(): Promise<FlightRules> {
  try {
    return normaliseRules((await getJson<{ rules: FlightRules }>(URL_)).rules);
  } catch {
    return { ...DEFAULT_FLIGHT_RULES };
  }
}

export async function saveFlightRules(rules: FlightRules): Promise<FlightRules> {
  const res = await fetch(URL_, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules }) });
  const data = (await res.json().catch(() => ({}))) as { rules?: FlightRules; reason?: string };
  if (!res.ok || !data.rules) throw new ServiceError(data.reason ?? `HTTP ${res.status}`, res.status);
  return normaliseRules(data.rules);
}
