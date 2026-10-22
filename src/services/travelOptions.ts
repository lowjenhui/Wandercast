// How a booked place can be reached from Singapore, from the destination data: ferries and
// overland routes where they exist, otherwise flights (direct, connecting or via a gateway).

import { useEffect, useState } from 'react';
import { haversineKm } from '../lib/geo';
import { landMode, MODE_ICON, type TravelMode } from '../lib/lookout';
import { todayISO } from '../lib/dates';
import { estimateFlightHours, formatHours } from '../lib/outlook';
import { destinationHours, directAirlinesOn, ferryHours, ferryText, landOnly, landText, loadDestinations, travelLabel, viaText, type Destination } from './destinations';

export interface TravelOption {
  mode: TravelMode;
  /** e.g. "≈1h direct", "4–6h coach from Golden Mile". */
  label: string;
}

/** The destination record within 25 km of a place, if any. */
export function nearestDestination(dests: Destination[], lat: number, lon: number): Destination | null {
  let best: Destination | null = null;
  let bestKm = 25;
  for (const d of dests) {
    const km = haversineKm(lat, lon, d.lat, d.lon);
    if (km < bestKm) [best, bestKm] = [d, km];
  }
  return best;
}

const strip = (s: string) => s.replace(/^[✈⛴🚌🚆🚐🚗]️?\s*/u, '');

/** The ways from Singapore to a place (and back), best known first. */
export function travelOptions(dests: Destination[], lat: number, lon: number): TravelOption[] {
  const d = nearestDestination(dests, lat, lon);
  if (!d) return [{ mode: 'flight', label: 'Flight' }];
  if (d.ferry) return [{ mode: 'ferry', label: strip(ferryText(d.ferry)) }];
  const out: TravelOption[] = [];
  if (!(d.land && landOnly(d))) out.push({ mode: 'flight', label: d.via ? `Flight, then ${strip(viaText(d.via))}` : strip(travelLabel({ ...d, land: undefined })) });
  if (d.land) {
    const seen = new Set<TravelMode>();
    for (const m of d.land.modes) {
      const mode = landMode(m);
      if (mode && !seen.has(mode)) {
        seen.add(mode);
        out.push({ mode, label: `${strip(landText(d.land))} from ${d.land.from}` });
      }
    }
  }
  return out.length ? out : [{ mode: 'flight', label: 'Flight' }];
}

/** All modes, for legs between stops (the app has no route data there). */
export const ANY_MODE: TravelMode[] = ['flight', 'coach', 'bus', 'train', 'ferry', 'van', 'car'];

/** The destination list (with ferry, overland and gateway details), loaded once. */
export function useDestinationData(): Destination[] | null {
  const [dests, setDests] = useState<Destination[] | null>(null);
  useEffect(() => {
    loadDestinations().then(setDests, () => setDests([]));
  }, []);
  return dests;
}

export { MODE_ICON };

export type GettingThereKind = 'direct' | 'connection' | 'via' | 'ferry' | 'overland';

/** How you'd usually get to a point from Singapore, for lists: the kind, door-to-door hours and a short label. */
export function gettingThere(dests: Destination[], lat: number, lon: number): { kind: GettingThereKind; hours: number; label: string } {
  const ferry = dests.find((x) => x.ferry && haversineKm(x.lat, x.lon, lat, lon) < 25);
  if (ferry?.ferry) return { kind: 'ferry', hours: ferryHours(ferry.ferry), label: travelLabel(ferry) };
  // A known place within 15 km (e.g. Hoi An, reached via Da Nang) brings its travel info.
  const d = dests.find((x) => !x.ferry && haversineKm(x.lat, x.lon, lat, lon) < 15);
  if (d) {
    const kind: GettingThereKind = d.land && landOnly(d) ? 'overland' : d.via ? 'via' : directAirlinesOn(d, todayISO()) ? 'direct' : 'connection';
    return { kind, hours: destinationHours(d), label: travelLabel(d) };
  }
  const hours = estimateFlightHours(lat, lon);
  return { kind: 'connection', hours, label: `✈ ≈${formatHours(hours)} · connection` };
}
