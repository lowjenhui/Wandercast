// The wander list: places you'd like to visit someday, marked 🎈 in the weather library and shown
// on the map and in Sunny picks. Stored by the local server (/api/settings/wander) and shared by
// every component through one in-memory copy.

import { useSyncExternalStore } from 'react';
import { haversineKm } from '../lib/geo';
import { getJson } from './http';

export interface WanderPlace {
  name: string;
  country: string;
  cc: string;
  lat: number;
  lon: number;
}

/** A place counts as on the list within this distance (map points and library places differ slightly). */
const MATCH_KM = 15;

let places: WanderPlace[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load() {
  loaded ??= getJson<{ places: WanderPlace[] }>('/api/settings/wander').then(
    (r) => {
      places = r.places;
      emit();
    },
    () => {
      loaded = null; // retry on the next subscriber
    },
  );
}

function subscribe(l: () => void) {
  listeners.add(l);
  load();
  return () => listeners.delete(l);
}

/** Whether a point is on the list. */
export const onWanderList = (list: WanderPlace[], lat: number, lon: number) => list.some((p) => haversineKm(p.lat, p.lon, lat, lon) < MATCH_KM);

/** Add or remove a place; saved to the server (the change shows at once and is undone if saving fails). */
export async function toggleWander(p: WanderPlace): Promise<void> {
  const before = places;
  places = onWanderList(places, p.lat, p.lon) ? places.filter((x) => haversineKm(x.lat, x.lon, p.lat, p.lon) >= MATCH_KM) : [...places, p];
  emit();
  try {
    const res = await fetch('/api/settings/wander', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ places }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    places = before;
    emit();
    throw e;
  }
}

/** The wander list (empty until loaded). */
export function useWanderList(): WanderPlace[] {
  return useSyncExternalStore(subscribe, () => places);
}
