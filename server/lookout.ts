// Puff's Lookout: keeps watch over booked trips (a saved range with an itinerary of one or more
// stops) and logs what changes, so the app can say what's new since you booked and since your
// last visit. Each stop is watched over its own dates (stopDates in src/lib/lookout.ts).
//
// What's watched per stop, once it's in range:
//   forecast     Open-Meteo daily forecast for the trip days within 16 days       every 3 h
//   air          Open-Meteo CAMS air quality, the trip days within 5 days           every 3 h
//                (US AQI from PM2.5 and PM10, the scale aqicn.org headlines; CAMS ozone peaks
//                are left out, as they run far above what stations report)
//   events       SerpApi Google Events for the city, from the month before        every 7 days
//   advisory     the stored MFA page for the destination's country (AdvisoryStore)  every check
//   alerts       stored US embassy / UK FCDO alerts near the stop or country-wide   every check
//                (AlertStore; informational, never changes MFA level or cover)
// The first check after booking is the baseline and logs nothing; afterwards each difference
// worth knowing becomes a row in lookout_changes (named after the stop when there are several).
// The analysis summaries seen when booking are kept as `baseline` ({ destId: summary }).
//
//   POST   /api/saved/:id/book          { itinerary, booked_on?, baseline?, prune? } books (or edits
//                                       the itinerary); prune removes the places not visited,
//                                       after copying their saved fares into the trip archive
//   DELETE /api/saved/:id/book          "Change plans": back to planning
//   GET    /api/saved/:id/lookout       checks what's due (briefly), then state + changes
//   POST   /api/saved/:id/lookout/seen  marks everything as seen

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db';
import type { AdvisoryStore } from './advisories';
import type { AlertStore } from './alerts';
import type { FareCache } from './fareCache';
import { eventDays, eventsChip } from './serpapi';
import { isBooked, type SavedDestination, type SavedRange, type SavedRanges } from './savedRanges';
import { isArchived, localToday, type TripArchive } from './tripArchive';
import { unitsFor, type Upstream } from './upstream';
import { LEVEL_LABEL } from '../src/lib/advisory';
import { alertsAt, KIND_LABEL, SOURCE_LABEL, type TravelAlert } from '../src/lib/alerts';
import { AIR_HORIZON, aqiBand, dayLabel, FORECAST_HORIZON, stopDates, type AdvisoryWatch, type ChangeKind, type ForecastDay, type LiveEvent, type LookoutChange, type LookoutState, type PlaceWatch, type WatchedEvent } from '../src/lib/lookout';

const HOUR = 3600_000;
const DAY_MS = 24 * HOUR;
const FORECAST_EVERY = 3 * HOUR;
const AIR_EVERY = 3 * HOUR;
const EVENTS_EVERY = 7 * DAY_MS;
/** A failed events search (allowance used, network) is retried after this. */
const EVENTS_RETRY = DAY_MS;
/** The page waits at most this long for due checks before showing what's stored. */
const PAGE_WAIT_MS = 8_000;

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FORECAST_VARS = ['weather_code', 'precipitation_probability_max', 'precipitation_sum', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max'] as const;

export { aqiBand, dayLabel };

function addDays(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const tripDays = (r: { start: string; end: string }) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / DAY_MS) + 1;

/** The part of a trip within `days` days from today (inclusive), or null. */
export function within(r: { start: string; end: string }, today: string, days: number): { start: string; end: string } | null {
  const start = r.start > today ? r.start : today;
  const last = addDays(today, days - 1);
  const end = r.end < last ? r.end : last;
  return start <= end ? { start, end } : null;
}

// ---------------------------------------------------------------- what changed

const isStorm = (code: number | null) => code !== null && code >= 95;

export function diffForecast(prev: PlaceWatch['forecast'], next: NonNullable<PlaceWatch['forecast']>, total: number, started: boolean): string[] {
  const out: string[] = [];
  if (!prev) {
    if (started && next.days.length) out.push(next.days.length >= total ? `The forecast now covers all ${total} days of your trip.` : `The forecast now covers ${next.days.length} of your ${total} days.`);
    return out;
  }
  if (prev.days.length < total && next.days.length >= total && prev.days.length > 0) out.push(`The forecast now covers all ${total} days of your trip.`);
  else if (prev.days.length === 0 && next.days.length) out.push(`The forecast now covers ${next.days.length} of your ${total} days.`);
  const before = new Map(prev.days.map((d) => [d.date, d]));
  for (const d of next.days) {
    const p = before.get(d.date);
    if (!p) continue;
    if (p.precipProb !== null && d.precipProb !== null && Math.abs(d.precipProb - p.precipProb) >= 20) {
      out.push(`Rain chance on ${dayLabel(d.date)} ${d.precipProb > p.precipProb ? 'up' : 'down'} from ${p.precipProb}% to ${d.precipProb}%${isStorm(d.code) ? ', with thunderstorms' : ''}.`);
    }
    if (p.tMax !== null && d.tMax !== null && Math.abs(d.tMax - p.tMax) >= 3) {
      out.push(`High on ${dayLabel(d.date)} now ${Math.round(d.tMax)} °C (was ${Math.round(p.tMax)} °C).`);
    }
  }
  return out;
}

export function diffAir(prev: PlaceWatch['air'], next: NonNullable<PlaceWatch['air']>, started: boolean): string[] {
  const out: string[] = [];
  if (!prev) {
    if (started && next.days.length) {
      const worst = Math.max(...next.days.map((d) => d.aqi ?? 0));
      out.push(`The air-quality forecast now covers ${next.days.length} of your days: up to AQI ${worst} (${aqiBand(worst)}).`);
    }
    return out;
  }
  const before = new Map(prev.days.map((d) => [d.date, d]));
  for (const d of next.days) {
    const p = before.get(d.date);
    if (!p || p.aqi === null || d.aqi === null || aqiBand(p.aqi) === aqiBand(d.aqi)) continue;
    out.push(`Air quality on ${dayLabel(d.date)} now ${aqiBand(d.aqi)} (AQI ${d.aqi}, was ${p.aqi}).`);
  }
  return out;
}

export function diffEvents(prev: PlaceWatch['events'], next: NonNullable<PlaceWatch['events']>): string[] {
  if (!prev) {
    const n = next.items.length;
    return n ? [`Puff found ${n} event${n === 1 ? '' : 's'} on your dates.`] : [];
  }
  const seen = new Set(prev.items.map((e) => e.key));
  return next.items.filter((e) => !seen.has(e.key)).map((e) => `New event: ${e.title} · ${dayLabel(e.from)}${e.to !== e.from ? ` – ${dayLabel(e.to)}` : ''}.`);
}

export function diffAdvisory(prev: AdvisoryWatch | undefined, next: AdvisoryWatch): string[] {
  if (!prev) return [];
  const where = next.title ?? 'this country';
  if (prev.level !== next.level) return [`MFA now says “${LEVEL_LABEL[next.level]}” for ${where} (was “${LEVEL_LABEL[prev.level]}”).`];
  if (next.mfaDate && prev.mfaDate !== next.mfaDate) return [`MFA updated its ${where} page (${next.mfaDate}): still “${LEVEL_LABEL[next.level]}”.`];
  return [];
}

/** New alerts for a stop (ones not seen at an earlier check). The first check logs nothing. */
export function diffAlerts(prev: string[] | undefined, next: TravelAlert[]): string[] {
  if (!prev) return [];
  const seen = new Set(prev);
  return next
    .filter((a) => !seen.has(a.id))
    .map((a) => {
      const where = a.places.length ? ` (${a.places.map((p) => p.name).join(', ')})` : '';
      return `New ${SOURCE_LABEL[a.source]} ${KIND_LABEL[a.kind].toLowerCase()}${where}: ${a.summary} MFA's advice hasn't changed, and your insurance cover is unaffected.`;
    });
}

/** Events that overlap the trip, merged with what was seen before (keeping when each was first seen). */
export function mergeEvents(found: LiveEvent[], trip: { start: string; end: string }, prev: WatchedEvent[], now: number): WatchedEvent[] {
  const before = new Map(prev.map((e) => [e.key, e]));
  const out = new Map<string, WatchedEvent>();
  for (const e of found) {
    const days = eventDays(e.startDate, e.when, trip.start);
    if (!days || days.to < trip.start || days.from > trip.end) continue;
    const key = `${e.title.toLowerCase().replace(/\s+/g, ' ').trim()}|${days.from}`;
    if (out.has(key)) continue;
    out.set(key, { ...e, ...days, key, firstSeen: before.get(key)?.firstSeen ?? now });
  }
  return [...out.values()].sort((a, b) => a.from.localeCompare(b.from) || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------- store and watcher

interface OmDaily {
  daily?: { time: string[] } & Record<string, (number | null)[]>;
}
interface OmAir {
  hourly?: { time: string[] } & Record<string, (number | null)[]>;
  current?: { time?: string; us_aqi_pm2_5?: number | null; us_aqi_pm10?: number | null; pm2_5?: number | null };
}

export class Lookout {
  private busy = new Map<number, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private saved: SavedRanges,
    private up: Upstream,
    private deps: { advisories?: AdvisoryStore; alerts?: AlertStore; events?: FareCache; archive?: TripArchive; captureFares?: () => void; now?: () => number } = {},
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS lookout_state (
      range_id INTEGER PRIMARY KEY, dest_id INTEGER NOT NULL, baseline TEXT, state TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS lookout_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, range_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS lookout_changes_range ON lookout_changes (range_id, at)');
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private row(rangeId: number): { dest_id: number; baseline: string | null; state: string } | undefined {
    return this.db.prepare('SELECT dest_id, baseline, state FROM lookout_state WHERE range_id = ?').get(rangeId) as { dest_id: number; baseline: string | null; state: string } | undefined;
  }

  state(rangeId: number): LookoutState {
    const r = this.row(rangeId);
    if (!r) return {};
    const s = JSON.parse(r.state) as LookoutState & PlaceWatch & { advisory?: AdvisoryWatch };
    // State saved before itineraries: one place, kept at the top level.
    if (!s.places && (s.forecast || s.air || s.events || s.advisory)) {
      const { forecast, air, events, errors, advisory, started } = s;
      const cc = advisory ? (this.saved.destinations(rangeId).find((d) => d.id === r.dest_id)?.cc ?? 'XX') : null;
      return { started, places: { [r.dest_id]: { forecast, air, events, errors } }, ...(advisory && cc ? { advisories: { [cc]: advisory } } : {}) };
    }
    return s;
  }

  baseline(rangeId: number): unknown {
    const r = this.row(rangeId);
    return r?.baseline ? JSON.parse(r.baseline) : null;
  }

  private saveState(rangeId: number, destId: number, s: LookoutState) {
    this.db
      .prepare('INSERT INTO lookout_state (range_id, dest_id, baseline, state, updated_at) VALUES (?,?,NULL,?,?) ON CONFLICT (range_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at')
      .run(rangeId, destId, JSON.stringify(s), this.now());
  }

  /** A fresh watch for a newly booked destination, keeping the analysis seen when booking. */
  start(rangeId: number, destId: number, baseline: unknown) {
    this.removeRange(rangeId);
    this.db.prepare('INSERT INTO lookout_state (range_id, dest_id, baseline, state, updated_at) VALUES (?,?,?,?,?)').run(rangeId, destId, baseline ? JSON.stringify(baseline) : null, '{}', this.now());
  }

  removeRange(rangeId: number) {
    this.db.prepare('DELETE FROM lookout_state WHERE range_id = ?').run(rangeId);
    this.db.prepare('DELETE FROM lookout_changes WHERE range_id = ?').run(rangeId);
  }

  private log(rangeId: number, kind: ChangeKind, texts: string[], place?: string) {
    const ins = this.db.prepare('INSERT INTO lookout_changes (range_id, at, kind, text) VALUES (?,?,?,?)');
    for (const t of texts) ins.run(rangeId, this.now(), kind, place ? `${place}: ${t}` : t);
  }

  changes(rangeId: number, limit = 60): LookoutChange[] {
    return this.db.prepare('SELECT id, at, kind, text FROM lookout_changes WHERE range_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(rangeId, limit) as unknown as LookoutChange[];
  }

  /** Changes since the Lookout was last opened (or since booking). */
  unread(r: SavedRange): number {
    const since = r.lookout_seen ?? r.booked_at ?? 0;
    return (this.db.prepare('SELECT COUNT(*) AS n FROM lookout_changes WHERE range_id = ? AND at > ?').get(r.id, since) as { n: number }).n;
  }

  /** Booked trips still to come or under way. */
  watched(today = localToday()): SavedRange[] {
    return this.saved.list().filter((r) => isBooked(r) && r.end >= today);
  }

  /** Runs whatever is due for one booked trip (one run per trip at a time). */
  check(r: SavedRange, opts: { background?: boolean } = {}): Promise<void> {
    let p = this.busy.get(r.id);
    if (!p) {
      p = this.run(r, opts.background ?? true).finally(() => this.busy.delete(r.id));
      this.busy.set(r.id, p);
    }
    return p;
  }

  private async run(r: SavedRange, background: boolean) {
    const booking = this.saved.booking(r);
    if (!booking) return;
    const dests = new Map(this.saved.destinations(r.id).map((d) => [d.id, d]));
    if (!this.row(r.id)) this.start(r.id, booking.destId, null);
    const today = localToday(new Date(this.now()));
    const s = this.state(r.id);
    const started = Boolean(s.started);
    const now = this.now();
    const lane = background ? { lane: 'saved' as const, maxWaitMs: 0 } : {};
    const multi = booking.itinerary.stops.length > 1;
    s.places ??= {};
    s.advisories ??= {};
    s.alerts ??= {};
    const al = this.deps.alerts;
    const activeAlerts = al ? (void al.ensure(), al.active()) : null;
    const ccsDone = new Set<string>();

    for (const stop of stopDates(booking.itinerary, r.start, r.end)) {
      const dest = dests.get(stop.destId);
      if (!dest || !stop.days.length) continue;
      const trip = { start: stop.days[0], end: stop.days[stop.days.length - 1] };
      const p: PlaceWatch = (s.places[dest.id] ??= {});
      const name = multi ? dest.name : undefined;

      const fWin = within(trip, today, FORECAST_HORIZON);
      // Also refetch when a new trip day comes within the horizon.
      const fLast = p.forecast?.days.at(-1)?.date;
      if (fWin && (!p.forecast || now - p.forecast.at >= FORECAST_EVERY || (fLast !== undefined && fLast < fWin.end))) {
        try {
          const next = { at: now, days: await this.fetchForecast(dest, fWin, lane) };
          this.log(r.id, 'forecast', diffForecast(p.forecast, next, stop.days.length, started), name);
          p.forecast = next;
          if (p.errors) delete p.errors.forecast;
        } catch (e) {
          // Keep the last forecast; try again next time.
          p.errors = { ...p.errors, forecast: (e as Error).message };
        }
      }

      const aWin = within(trip, today, AIR_HORIZON);
      if (aWin && (!p.air || now - p.air.at >= AIR_EVERY)) {
        try {
          const next = { at: now, ...(await this.fetchAir(dest, aWin, lane)) };
          this.log(r.id, 'air', diffAir(p.air, next, started), name);
          p.air = next;
          if (p.errors) delete p.errors.air;
        } catch (e) {
          p.errors = { ...p.errors, air: (e as Error).message };
        }
      }

      const chip = eventsChip(trip.start, trip.end, today);
      const ev = this.deps.events;
      const lastTry = p.events?.triedAt ?? p.events?.at ?? 0;
      const due = !p.events || (p.events.error ? now - lastTry >= EVENTS_RETRY : now - p.events.at >= EVENTS_EVERY);
      if (chip && ev?.configured && due) {
        const path = `/search?${new URLSearchParams({ q: dest.name, chip, end: trip.end, gl: dest.cc })}`;
        const res = await ev.get(path, { background: true });
        if (res.ok && !res.body.saved?.stale) {
          const next = { at: now, items: mergeEvents((res.body.events as LiveEvent[] | undefined) ?? [], trip, p.events?.items ?? [], now) };
          this.log(r.id, 'events', diffEvents(p.events, next), name);
          p.events = next;
        } else {
          const reason = res.ok ? 'SerpApi couldn’t be reached; showing the last events found.' : res.reason;
          p.events = { at: p.events?.at ?? 0, items: p.events?.items ?? [], error: reason, triedAt: now };
        }
      }

      // Alerts near this stop or for its whole country (ids seen so far, so each logs once).
      if (activeAlerts) {
        const { near, country } = alertsAt(activeAlerts, dest, now);
        const here = [...near, ...country];
        const prev = s.alerts[dest.id];
        this.log(r.id, 'alert', diffAlerts(prev, here), name);
        s.alerts[dest.id] = [...new Set([...(prev ?? []), ...here.map((a) => a.id)])].slice(-50);
      }

      // One MFA page per country, however many stops are in it.
      const adv = this.deps.advisories;
      if (adv && !ccsDone.has(dest.cc)) {
        ccsDone.add(dest.cc);
        const page = adv.pages().find((pg) => pg.cc === dest.cc) ?? null;
        const next: AdvisoryWatch = { at: now, slug: page?.slug ?? null, title: page?.title ?? dest.country, level: page?.level ?? 'none', mfaDate: page?.mfaDate ?? null };
        this.log(r.id, 'advisory', diffAdvisory(s.advisories[dest.cc], next));
        s.advisories[dest.cc] = next;
      }
    }

    s.started ??= now;
    this.saveState(r.id, booking.destId, s);
  }

  private async fetchForecast(d: SavedDestination, win: { start: string; end: string }, lane: object): Promise<ForecastDay[]> {
    const q = new URLSearchParams({ latitude: String(d.lat), longitude: String(d.lon), daily: FORECAST_VARS.join(','), timezone: 'auto', start_date: win.start, end_date: win.end });
    const days = tripDays(win);
    const data = await this.up.fetchJson<OmDaily>(`${FORECAST_URL}?${q}`, unitsFor(1, days, FORECAST_VARS.length), lane);
    const dl = data.daily;
    if (!dl) return [];
    const at = (k: string, i: number) => dl[k]?.[i] ?? null;
    return dl.time.map((date, i) => ({
      date,
      code: at('weather_code', i),
      precipProb: at('precipitation_probability_max', i),
      precipMm: at('precipitation_sum', i),
      tMax: at('temperature_2m_max', i),
      tMin: at('temperature_2m_min', i),
      feelsMax: at('apparent_temperature_max', i),
    }));
  }

  private async fetchAir(d: SavedDestination, win: { start: string; end: string }, lane: object): Promise<Omit<NonNullable<PlaceWatch['air']>, 'at'>> {
    const q = new URLSearchParams({ latitude: String(d.lat), longitude: String(d.lon), hourly: 'us_aqi_pm2_5,us_aqi_pm10,pm2_5,dust', current: 'us_aqi_pm2_5,us_aqi_pm10,pm2_5', timezone: 'auto', forecast_days: String(AIR_HORIZON) });
    const data = await this.up.fetchJson<OmAir>(`${AIR_URL}?${q}`, unitsFor(1, AIR_HORIZON, 7), lane);
    const pmAqi = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null ? null : Math.max(a ?? 0, b ?? 0));
    const h = data.hourly;
    const byDay = new Map<string, { aqi: number[]; pm: number[]; dust: number[] }>();
    h?.time.forEach((t, i) => {
      const date = t.slice(0, 10);
      if (date < win.start || date > win.end) return;
      const x = byDay.get(date) ?? { aqi: [], pm: [], dust: [] };
      const a = pmAqi(h.us_aqi_pm2_5?.[i], h.us_aqi_pm10?.[i]);
      const p = h.pm2_5?.[i];
      const u = h.dust?.[i];
      if (a != null) x.aqi.push(a);
      if (p != null) x.pm.push(p);
      if (u != null) x.dust.push(u);
      byDay.set(date, x);
    });
    const days = [...byDay.entries()].map(([date, x]) => ({
      date,
      aqi: x.aqi.length ? Math.round(Math.max(...x.aqi)) : null,
      pm25: x.pm.length ? Math.round((x.pm.reduce((a, b) => a + b, 0) / x.pm.length) * 10) / 10 : null,
      dust: x.dust.length ? Math.round(Math.max(...x.dust)) : null,
    }));
    const c = data.current;
    return { days, now: c ? { aqi: pmAqi(c.us_aqi_pm2_5, c.us_aqi_pm10), pm25: c.pm2_5 ?? null, time: c.time ?? null } : null };
  }

  /** Background checks for every watched trip. */
  async tick() {
    for (const r of this.watched()) await this.check(r).catch(() => undefined);
  }

  startTimer(everyMs = 10 * 60_000) {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const m = url.pathname.match(/^\/api\/saved\/(\d+)\/(book|lookout|lookout\/seen)$/);
      if (!m) return next();
      try {
        const id = Number(m[1]);
        const r = this.saved.get(id);
        if (!r) return send(res, 404, { error: true, reason: 'Not found' });
        const archived = isArchived(r, localToday());
        if (m[2] === 'book') {
          if (archived) return send(res, 409, { error: true, reason: 'Past trips are read-only.' });
          if (req.method === 'DELETE') {
            this.saved.unbook(id);
            this.removeRange(id);
            return send(res, 200, { ok: true });
          }
          if (req.method !== 'POST') return send(res, 405, { error: true, reason: 'Method not allowed' });
          const body = (await readJson(req, 65_536)) as Record<string, unknown>;
          const wasBooked = isBooked(r);
          const out = this.saved.book(id, body);
          if (out === null) return send(res, 404, { error: true, reason: 'Not found' });
          if (typeof out === 'string') return send(res, 400, { error: true, reason: out });
          const booking = this.saved.booking(out)!;
          if (body.prune === true) {
            // Keep what was fetched for the places left out: their fares go into the trip archive
            // (weather history is stored permanently anyway) before they leave the list.
            try {
              this.deps.captureFares?.();
            } catch {
              /* never let archiving block the booking */
            }
            this.saved.prune(id, booking.itinerary.stops.map((st) => st.destId));
          }
          if (!wasBooked || !this.row(id)) {
            const snaps = this.deps.archive?.snapshots(id);
            const given = body.baseline && typeof body.baseline === 'object' ? (body.baseline as Record<string, unknown>) : {};
            const baseline = Object.fromEntries(booking.itinerary.stops.map((st) => [st.destId, given[st.destId] ?? snaps?.get(st.destId)?.body ?? null]));
            this.start(id, booking.destId, baseline);
          }
          void this.check(out, { background: false }).catch(() => undefined);
          return send(res, 200, { ok: true, booking });
        }
        if (!isBooked(r)) return send(res, 409, { error: true, reason: 'These dates aren’t booked yet.' });
        if (m[2] === 'lookout/seen') {
          if (req.method !== 'POST') return send(res, 405, { error: true, reason: 'Method not allowed' });
          this.saved.markSeen(id, this.now());
          return send(res, 200, { ok: true });
        }
        if (req.method !== 'GET') return send(res, 405, { error: true, reason: 'Method not allowed' });
        if (!archived) await Promise.race([this.check(r, { background: false }).catch(() => undefined), new Promise((ok) => setTimeout(ok, PAGE_WAIT_MS))]);
        const booking = this.saved.booking(r);
        const all = this.saved.destinations(id);
        const dests = (booking?.itinerary.stops ?? []).map((st) => all.find((d) => d.id === st.destId)).filter((d): d is SavedDestination => Boolean(d));
        return send(res, 200, {
          range: { id: r.id, label: r.label, start: r.start, end: r.end, booked_on: r.booked_on ?? null },
          dests,
          booking,
          baseline: this.baseline(id),
          state: this.state(id),
          changes: this.changes(id),
          eventsConfigured: Boolean(this.deps.events?.configured),
        });
      } catch (e) {
        return send(res, 400, { error: true, reason: (e as Error).message });
      }
    };
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}
