// Saved travel date ranges ("dates of interest"), stored in SQLite.
//
//   GET    /api/saved          list, soonest first
//   POST   /api/saved          { label?, start, end, booked_on? } → created row
//   PATCH  /api/saved/:id      { label?, start?, end?, booked_on? } → updated row (booked_on: null clears it)
//   DELETE /api/saved/:id
//   POST   /api/saved/:id/fetch  move this range to the front of the weather pre-fetch queue
//   POST   /api/saved/:id/destinations       { name, country, cc, lat, lon, code, admin1? } → added
//   DELETE /api/saved/:id/destinations/:did
//   PUT    /api/saved/:id/destinations/:did/snapshot   { ...analysis summary } (upcoming trips only)
//   POST   /api/saved/:id/book, DELETE …/book, GET …/lookout, POST …/lookout/seen  (server/lookout.ts)
//   GET    /api/settings/travel   flight-time exceptions (e.g. Japan from 3D2N)
//   PUT    /api/settings/travel   { exceptions: [...] }
//   GET    /api/settings/wander   your wander list (places you'd like to visit someday)
//   PUT    /api/settings/wander   { places: [{ name, country, cc, lat, lon }] }
// List and write responses include `weather` progress when a pre-fetcher is attached, and each
// range lists its probable destinations (with their own weather progress).
// Ranges whose end date has passed are `archived`: read-only (only DELETE is allowed), and each
// destination carries its last analysis `snapshot` (server/tripArchive.ts).
// A booked range (tickets bought for one of its destinations) carries `booking` and is watched
// on Puff's Lookout instead of being planned: fares and map-wide weather are no longer prefetched.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db';
import { isArchived, localToday, type TripArchive } from './tripArchive';
import { cleanItinerary, type Itinerary } from '../src/lib/lookout';

export const MAX_RANGE_DAYS = 92;

export interface SavedRange {
  id: number;
  label: string;
  start: string;
  end: string;
  created_at: number;
  /** When the trip was booked (YYYY-MM-DD), for insurers' advisory-timing rules. */
  booked_on?: string | null;
  /** The destination the tickets were bought for (Puff's Lookout), or null while planning. */
  booked_dest_id?: number | null;
  /** When it was marked as booked (ms). */
  booked_at?: number | null;
  /** The booked itinerary as JSON (stops, nights, legs); older rows hold { paid, flights, stay }. */
  booking_info?: string | null;
  /** When Puff's Lookout was last opened (ms), for "new since your last visit". */
  lookout_seen?: number | null;
}

/** A booked trip as the API shows it. */
export interface Booking {
  /** The first stop (kept in booked_dest_id). */
  destId: number;
  at: number;
  seenAt: number | null;
  itinerary: Itinerary;
}

const nightsOf = (r: { start: string; end: string }) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000);

export const isBooked = (r: SavedRange) => r.booked_dest_id != null;

/** A probable destination for a saved range, kept for side-by-side comparison. */
export interface SavedDestination {
  id: number;
  range_id: number;
  name: string;
  admin1: string | null;
  country: string;
  cc: string;
  lat: number;
  lon: number;
  /** Fare lookup code (city or airport IATA), or '' when unknown. */
  code: string;
  created_at: number;
}

/** A place allowed beyond the normal flight-time limit, from a minimum trip length. */
export interface TravelException {
  /** Country code; with `city`, only that city. */
  cc: string;
  city?: string;
  label: string;
  minDays: number;
}

/** A place on the wander list. */
export interface WanderPlace {
  name: string;
  country: string;
  cc: string;
  lat: number;
  lon: number;
}
const MAX_WANDER = 500;

export const DEFAULT_EXCEPTIONS: TravelException[] = [{ cc: 'JP', label: 'Japan', minDays: 3 }];
export const MAX_DESTINATIONS = 8;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

async function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

export class SavedRanges {
  /** Set by the plugin so deletes also clear archived fares and snapshots. */
  archive?: TripArchive;
  /** Set by the plugin so deletes also clear Puff's Lookout state (server/lookout.ts). */
  onRemove?: (id: number) => void;

  constructor(private db: DB) {
    db.exec(`CREATE TABLE IF NOT EXISTS saved_ranges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS saved_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      range_id INTEGER NOT NULL REFERENCES saved_ranges(id) ON DELETE CASCADE,
      name TEXT NOT NULL, admin1 TEXT, country TEXT NOT NULL, cc TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const cols = (db.prepare('PRAGMA table_info(saved_ranges)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('booked_on')) db.exec('ALTER TABLE saved_ranges ADD COLUMN booked_on TEXT');
    if (!cols.includes('booked_dest_id')) db.exec('ALTER TABLE saved_ranges ADD COLUMN booked_dest_id INTEGER');
    if (!cols.includes('booked_at')) db.exec('ALTER TABLE saved_ranges ADD COLUMN booked_at INTEGER');
    if (!cols.includes('booking_info')) db.exec('ALTER TABLE saved_ranges ADD COLUMN booking_info TEXT');
    if (!cols.includes('lookout_seen')) db.exec('ALTER TABLE saved_ranges ADD COLUMN lookout_seen INTEGER');
  }

  /** The booking as the API shows it, or null while the range is still being planned. */
  booking(r: SavedRange): Booking | null {
    if (r.booked_dest_id == null) return null;
    let raw: Record<string, unknown> = {};
    try {
      raw = r.booking_info ? (JSON.parse(r.booking_info) as Record<string, unknown>) : {};
    } catch {
      /* unreadable details: keep the booking itself */
    }
    // Bookings made before itineraries: one stop, details moved onto its legs and stay.
    const itinerary: Itinerary = Array.isArray(raw.stops)
      ? (raw as unknown as Itinerary)
      : {
          stops: [{ destId: r.booked_dest_id, nights: nightsOf(r), ...(typeof raw.stay === 'string' ? { stay: { name: raw.stay } } : {}) }],
          legs: [{ mode: null, ...(typeof raw.flights === 'string' ? { detail: raw.flights } : {}), ...(typeof raw.paid === 'string' ? { price: raw.paid } : {}) }, { mode: null }],
        };
    return { destId: r.booked_dest_id, at: r.booked_at ?? 0, seenAt: r.lookout_seen ?? null, itinerary };
  }

  /**
   * Marks a range as booked with an itinerary (or updates the itinerary of a booked range).
   * Returns an error message instead when invalid.
   */
  book(id: number, input: { itinerary?: unknown; booked_on?: unknown }): SavedRange | string | null {
    const r = this.get(id);
    if (!r) return null;
    const it = cleanItinerary(input.itinerary, this.destinations(id).map((d) => d.id), nightsOf(r));
    if (typeof it === 'string') return it;
    const bookedOn = input.booked_on === undefined ? (r.booked_on ?? localToday()) : this.cleanBookedOn(input.booked_on);
    if (bookedOn === undefined || bookedOn === null) return 'The booking date must be a date (YYYY-MM-DD).';
    if (bookedOn > localToday()) return 'The booking date can’t be in the future.';
    // Editing a booked trip keeps when it was booked (and so the Lookout baseline).
    const at = r.booked_at ?? Date.now();
    this.db
      .prepare('UPDATE saved_ranges SET booked_dest_id = ?, booked_at = ?, booking_info = ?, booked_on = ? WHERE id = ?')
      .run(it.stops[0].destId, at, JSON.stringify(it), bookedOn, id);
    return this.get(id)!;
  }

  /** Removes the range's destinations that aren't in `keep`, keeping their archived data. */
  prune(id: number, keep: number[]): number {
    let n = 0;
    for (const d of this.destinations(id)) if (!keep.includes(d.id)) n += Number(this.db.prepare('DELETE FROM saved_destinations WHERE id = ?').run(d.id).changes);
    return n;
  }

  /** "Change plans": back to planning. The booking date stays (it still matters for insurance). */
  unbook(id: number): SavedRange | null {
    if (!this.get(id)) return null;
    this.db.prepare('UPDATE saved_ranges SET booked_dest_id = NULL, booked_at = NULL, booking_info = NULL, lookout_seen = NULL WHERE id = ?').run(id);
    return this.get(id)!;
  }

  /** Records that Puff's Lookout was opened now. */
  markSeen(id: number, at = Date.now()) {
    this.db.prepare('UPDATE saved_ranges SET lookout_seen = ? WHERE id = ?').run(at, id);
  }

  destinations(rangeId?: number): SavedDestination[] {
    return (
      rangeId === undefined
        ? this.db.prepare('SELECT * FROM saved_destinations ORDER BY range_id, id').all()
        : this.db.prepare('SELECT * FROM saved_destinations WHERE range_id = ? ORDER BY id').all(rangeId)
    ) as unknown as SavedDestination[];
  }

  /** Adds a destination to a range; returns an error message instead when invalid or a duplicate. */
  addDestination(rangeId: number, input: Record<string, unknown>): SavedDestination | string | null {
    if (!this.get(rangeId)) return null;
    const str = (v: unknown, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const name = str(input.name);
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    const cc = str(input.cc, 2).toUpperCase();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !/^[A-Z]{2}$/.test(cc)) return 'Choose a destination from the list.';
    const existing = this.destinations(rangeId);
    if (existing.length >= MAX_DESTINATIONS) return `Up to ${MAX_DESTINATIONS} destinations per saved range.`;
    const near = existing.find((d) => Math.hypot(d.lat - lat, (d.lon - lon) * Math.cos((lat * Math.PI) / 180)) < 0.15);
    if (near) return `${near.name} is already on this list.`;
    const r = this.db
      .prepare('INSERT INTO saved_destinations (range_id, name, admin1, country, cc, lat, lon, code, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(rangeId, name, str(input.admin1) || null, str(input.country) || cc, cc, lat, lon, str(input.code, 4).toUpperCase(), Date.now());
    return this.db.prepare('SELECT * FROM saved_destinations WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as SavedDestination;
  }

  removeDestination(rangeId: number, id: number): boolean {
    const r = this.get(rangeId);
    if (r && this.booking(r)?.itinerary.stops.some((st) => st.destId === id)) this.unbook(rangeId);
    this.archive?.removeDestination(id);
    return this.db.prepare('DELETE FROM saved_destinations WHERE id = ? AND range_id = ?').run(id, rangeId).changes > 0;
  }

  exceptions(): TravelException[] {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'travel_exceptions'").get() as { value: string } | undefined;
    if (!row) return DEFAULT_EXCEPTIONS;
    try {
      return JSON.parse(row.value) as TravelException[];
    } catch {
      return DEFAULT_EXCEPTIONS;
    }
  }

  setExceptions(input: unknown): TravelException[] | string {
    if (!Array.isArray(input) || input.length > 30) return 'Send a list of up to 30 exceptions.';
    const out: TravelException[] = [];
    for (const x of input as Record<string, unknown>[]) {
      const cc = typeof x.cc === 'string' ? x.cc.toUpperCase() : '';
      const minDays = Number(x.minDays);
      if (!/^[A-Z]{2}$/.test(cc) || !Number.isInteger(minDays) || minDays < 1 || minDays > 30) return 'Each exception needs a country code and a minimum trip length of 1–30 days.';
      const city = typeof x.city === 'string' && x.city.trim() ? x.city.trim().slice(0, 60) : undefined;
      const label = typeof x.label === 'string' && x.label.trim() ? x.label.trim().slice(0, 60) : city ?? cc;
      out.push({ cc, ...(city ? { city } : {}), label, minDays });
    }
    this.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('travel_exceptions', ?)").run(JSON.stringify(out));
    return out;
  }

  /** The wander list: places marked 🎈 in the weather library, shown on the map and in Sunny picks. */
  wanderList(): WanderPlace[] {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'wander_list'").get() as { value: string } | undefined;
    try {
      return row ? (JSON.parse(row.value) as WanderPlace[]) : [];
    } catch {
      return [];
    }
  }

  setWanderList(input: unknown): WanderPlace[] | string {
    if (!Array.isArray(input) || input.length > MAX_WANDER) return `Send a list of up to ${MAX_WANDER} places.`;
    const out: WanderPlace[] = [];
    for (const x of input as Record<string, unknown>[]) {
      const lat = Number(x.lat);
      const lon = Number(x.lon);
      const name = typeof x.name === 'string' ? x.name.trim().slice(0, 80) : '';
      const cc = typeof x.cc === 'string' ? x.cc.toUpperCase().slice(0, 2) : '';
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'Each place needs a name and coordinates.';
      out.push({ name, country: typeof x.country === 'string' ? x.country.slice(0, 80) : '', cc, lat, lon });
    }
    this.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('wander_list', ?)").run(JSON.stringify(out));
    return out;
  }

  list(): SavedRange[] {
    return this.db.prepare('SELECT * FROM saved_ranges ORDER BY start, end, id').all() as unknown as SavedRange[];
  }

  get(id: number): SavedRange | undefined {
    return this.db.prepare('SELECT * FROM saved_ranges WHERE id = ?').get(id) as unknown as SavedRange | undefined;
  }

  /** Returns an error message for invalid input, or null when it's fine. */
  private validate(start: unknown, end: unknown, exceptId?: number): string | null {
    if (!isDate(start) || !isDate(end)) return 'Choose a start and an end date.';
    if (end < start) return 'The end date must be on or after the start date.';
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) return `Saved ranges can be up to ${MAX_RANGE_DAYS} days (this one is ${days}).`;
    const dup = this.db.prepare('SELECT * FROM saved_ranges WHERE start = ? AND end = ? AND id != ?').get(start, end, exceptId ?? -1) as SavedRange | undefined;
    if (dup) return `These dates are already saved${dup.label ? ` as “${dup.label}”` : ''}.`;
    return null;
  }

  /** A booking date, null to clear, or undefined when invalid. */
  private cleanBookedOn(v: unknown): string | null | undefined {
    if (v === null || v === '') return null;
    return isDate(v) ? v : undefined;
  }

  private cleanLabel(label: unknown): string {
    return typeof label === 'string' ? label.trim().slice(0, 60) : '';
  }

  /** Validates and stores a range; returns an error message instead when invalid. */
  add(input: { label?: unknown; start?: unknown; end?: unknown; booked_on?: unknown }): SavedRange | string {
    const err = this.validate(input.start, input.end);
    if (err) return err;
    const booked = input.booked_on === undefined ? null : this.cleanBookedOn(input.booked_on);
    if (booked === undefined) return 'The booking date must be a date (YYYY-MM-DD).';
    const r = this.db
      .prepare('INSERT INTO saved_ranges (label, start, end, created_at, booked_on) VALUES (?, ?, ?, ?, ?)')
      .run(this.cleanLabel(input.label), input.start as string, input.end as string, Date.now(), booked);
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** Updates any of label, start, end and booked_on; returns an error message instead when invalid. */
  update(id: number, input: { label?: unknown; start?: unknown; end?: unknown; booked_on?: unknown }): SavedRange | string | null {
    const cur = this.get(id);
    if (!cur) return null;
    const start = input.start ?? cur.start;
    const end = input.end ?? cur.end;
    const err = this.validate(start, end, id);
    if (err) return err;
    const label = input.label === undefined ? cur.label : this.cleanLabel(input.label);
    const booked = input.booked_on === undefined ? (cur.booked_on ?? null) : this.cleanBookedOn(input.booked_on);
    if (booked === undefined) return 'The booking date must be a date (YYYY-MM-DD).';
    this.db.prepare('UPDATE saved_ranges SET label = ?, start = ?, end = ?, booked_on = ? WHERE id = ?').run(label, start as string, end as string, booked, id);
    return this.get(id)!;
  }

  remove(id: number): boolean {
    this.archive?.removeRange(id);
    this.onRemove?.(id);
    this.db.prepare('DELETE FROM saved_destinations WHERE range_id = ?').run(id);
    return this.db.prepare('DELETE FROM saved_ranges WHERE id = ?').run(id).changes > 0;
  }

  handler(
    hooks: {
      progress?: (r: SavedRange) => unknown;
      destProgress?: (r: SavedRange, d: SavedDestination) => unknown;
      /** Sunny windows history for a destination (years stored of those needed). */
      sunnyProgress?: (d: SavedDestination) => unknown;
      /** Puff's Lookout summary for a booked range (e.g. unread changes). */
      lookout?: (r: SavedRange) => unknown;
      onChange?: () => void;
      prioritize?: (id: number) => void;
    } = {},
  ) {
    const withDest = (r: SavedRange) => (d: SavedDestination) => ({
      ...d,
      ...(hooks.destProgress ? { weather: hooks.destProgress(r, d) } : {}),
      ...(hooks.sunnyProgress ? { sunny: hooks.sunnyProgress(d) } : {}),
    });
    const withProgress = (row: SavedRange) => {
      const { booked_dest_id: _d, booked_at: _a, booking_info: _i, lookout_seen: _s, ...r } = row;
      const archived = isArchived(r);
      const snaps = this.archive?.snapshots(r.id);
      const booking = this.booking(row);
      return {
        ...r,
        archived,
        booking,
        ...(booking && hooks.lookout ? { lookout: hooks.lookout(row) } : {}),
        // Past and booked trips aren't pre-fetched map-wide, so they carry no weather progress.
        ...(hooks.progress && !archived && !booking ? { weather: hooks.progress(r) } : {}),
        destinations: this.destinations(r.id).map((d) => {
          const snap = snaps?.get(d.id);
          return { ...withDest(r)(d), ...(snap ? { snapshot: { ...(snap.body as object), at: snap.at } } : {}) };
        }),
      };
    };
    const readOnly = (r: SavedRange) => isArchived(r, localToday());
    const READ_ONLY = 'Past trips are read-only.';
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/api/settings/travel') {
        try {
          if (req.method === 'GET') return send(res, 200, { exceptions: this.exceptions(), defaults: DEFAULT_EXCEPTIONS });
          if (req.method === 'PUT') {
            const out = this.setExceptions(((await readJson(req)) as { exceptions?: unknown }).exceptions);
            return typeof out === 'string' ? send(res, 400, { error: true, reason: out }) : send(res, 200, { exceptions: out, defaults: DEFAULT_EXCEPTIONS });
          }
          return send(res, 405, { error: true, reason: 'Method not allowed' });
        } catch (e) {
          return send(res, 400, { error: true, reason: (e as Error).message });
        }
      }
      if (url.pathname === '/api/settings/wander') {
        try {
          if (req.method === 'GET') return send(res, 200, { places: this.wanderList() });
          if (req.method === 'PUT') {
            const out = this.setWanderList(((await readJson(req, 65_536)) as { places?: unknown }).places);
            return typeof out === 'string' ? send(res, 400, { error: true, reason: out }) : send(res, 200, { places: out });
          }
          return send(res, 405, { error: true, reason: 'Method not allowed' });
        } catch (e) {
          return send(res, 400, { error: true, reason: (e as Error).message });
        }
      }
      const dm = url.pathname.match(/^\/api\/saved\/(\d+)\/destinations(?:\/(\d+)(\/snapshot)?)?$/);
      if (dm) {
        try {
          const range = this.get(Number(dm[1]));
          if (!range) return send(res, 404, { error: true, reason: 'Not found' });
          if (readOnly(range)) return send(res, 409, { error: true, reason: READ_ONLY });
          if (req.method === 'PUT' && dm[2] && dm[3]) {
            const dest = this.destinations(range.id).find((d) => d.id === Number(dm[2]));
            if (!dest || !this.archive) return send(res, 404, { error: true, reason: 'Not found' });
            const body = await readJson(req, 16_384);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: true, reason: 'Send the snapshot as a JSON object.' });
            this.archive.putSnapshot(range.id, dest.id, body);
            return send(res, 200, { ok: true });
          }
          if (dm[3]) return send(res, 405, { error: true, reason: 'Method not allowed' });
          if (req.method === 'POST' && !dm[2]) {
            const out = this.addDestination(range.id, (await readJson(req)) as Record<string, unknown>);
            if (out === null) return send(res, 404, { error: true, reason: 'Not found' });
            if (typeof out === 'string') return send(res, 400, { error: true, reason: out });
            hooks.onChange?.();
            return send(res, 201, withDest(range)(out));
          }
          if (req.method === 'DELETE' && dm[2]) return this.removeDestination(range.id, Number(dm[2])) ? send(res, 200, { ok: true }) : send(res, 404, { error: true, reason: 'Not found' });
          return send(res, 405, { error: true, reason: 'Method not allowed' });
        } catch (e) {
          return send(res, 400, { error: true, reason: (e as Error).message });
        }
      }
      const m = url.pathname.match(/^\/api\/saved(?:\/(\d+)(\/fetch)?)?$/);
      if (!m) return next();
      try {
        if (req.method === 'GET' && !m[1]) return send(res, 200, this.list().map(withProgress));
        if (req.method === 'POST' && m[1] && m[2]) {
          const r = this.get(Number(m[1]));
          if (!r) return send(res, 404, { error: true, reason: 'Not found' });
          if (readOnly(r)) return send(res, 409, { error: true, reason: READ_ONLY });
          hooks.prioritize?.(r.id);
          hooks.onChange?.();
          return send(res, 202, withProgress(r));
        }
        if (req.method === 'POST' && !m[1]) {
          const out = this.add((await readJson(req)) as Record<string, unknown>);
          if (typeof out === 'string') return send(res, 400, { error: true, reason: out });
          hooks.onChange?.();
          return send(res, 201, withProgress(out));
        }
        if (req.method === 'PATCH' && m[1] && !m[2]) {
          const cur = this.get(Number(m[1]));
          if (cur && readOnly(cur)) return send(res, 409, { error: true, reason: READ_ONLY });
          const out = this.update(Number(m[1]), (await readJson(req)) as Record<string, unknown>);
          if (out === null) return send(res, 404, { error: true, reason: 'Not found' });
          if (typeof out === 'string') return send(res, 400, { error: true, reason: out });
          hooks.onChange?.();
          return send(res, 200, withProgress(out));
        }
        if (req.method === 'DELETE' && m[1]) return this.remove(Number(m[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: true, reason: 'Not found' });
        return send(res, 405, { error: true, reason: 'Method not allowed' });
      } catch (e) {
        return send(res, 400, { error: true, reason: (e as Error).message });
      }
    };
  }
}
