// Metered access to Open-Meteo. Every upstream request goes through here so the free-tier
// limits (~600 units/min, 5,000/hour, 10,000/day) are respected, with interactive requests
// taking priority over background seeding.

import type { DB } from './db';

/**
 * Daily split (9,500 units): background work never touches the last 2,000 (kept for your own
 * searches), and it's shared between two lanes with their own caps, so neither starves the other:
 *   saved lane  ≤ 4,500  saved destinations, places the app asked for (the wanted queue), and
 *                        saved date ranges
 *   seeding     ≤ 3,000  general history (full years, so any dates are covered) and forecasts
 */
export const LIMITS = {
  perMinute: 500,
  perHour: 4500,
  perDay: 9500,
  interactiveReserve: 2000,
  savedPerDay: 4500,
  seedPerDay: 3000,
  savedPerMinute: 300,
  seedPerMinute: 250,
};

/**
 * Open-Meteo counts a location as several calls when a request covers more than 14 days or
 * more than 10 variables. This mirrors that rule so the budget matches what they meter.
 */
export function unitsFor(locations: number, days: number, variables: number): number {
  return locations * Math.max(1, Math.ceil(days / 14)) * Math.max(1, Math.ceil(variables / 10));
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds after which a retry is likely to succeed (for 429s). */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export class Upstream {
  private log: { at: number; units: number }[] = [];
  private blockedUntil = 0;
  lastInteractiveAt = 0;

  constructor(private db: DB) {}

  private used(windowMs: number, now = Date.now()) {
    return this.log.filter((e) => now - e.at < windowMs).reduce((a, e) => a + e.units, 0);
  }

  /** Today's units: total, general seeding, and the saved-dates lane. */
  usedToday(): { units: number; seedUnits: number; savedUnits: number } {
    const row = this.db.prepare('SELECT units, seed_units, saved_units FROM usage WHERE day = ?').get(today()) as
      | { units: number; seed_units: number; saved_units: number }
      | undefined;
    return { units: row?.units ?? 0, seedUnits: row?.seed_units ?? 0, savedUnits: row?.saved_units ?? 0 };
  }

  status() {
    const day = this.usedToday();
    return {
      lastMinute: this.used(60_000),
      lastHour: this.used(3_600_000),
      today: day.units,
      seedToday: day.seedUnits,
      savedToday: day.savedUnits,
      blockedUntil: this.blockedUntil > Date.now() ? this.blockedUntil : null,
      limits: LIMITS,
    };
  }

  /**
   * Whether a request of this size could run now. Lanes: interactive (false), background
   * seeding (true), or pre-fetching for saved travel dates ('saved').
   */
  canSpend(units: number, lane: boolean | 'saved'): boolean {
    const now = Date.now();
    if (this.blockedUntil > now) return false;
    const day = this.usedToday();
    if (day.units + units > LIMITS.perDay) return false;
    if (this.used(3_600_000, now) + units > LIMITS.perHour) return false;
    const minute = this.used(60_000, now);
    if (lane && day.units + units > LIMITS.perDay - LIMITS.interactiveReserve) return false;
    if (lane === 'saved') {
      if (now - this.lastInteractiveAt < 2000) return false;
      if (day.savedUnits + units > LIMITS.savedPerDay) return false;
      return minute + units <= LIMITS.savedPerMinute;
    }
    if (lane) {
      if (now - this.lastInteractiveAt < 4000) return false;
      if (day.seedUnits + units > LIMITS.seedPerDay) return false;
      return minute + units <= LIMITS.seedPerMinute;
    }
    return minute + units <= LIMITS.perMinute;
  }

  private record(units: number, lane: boolean | 'saved') {
    this.log.push({ at: Date.now(), units });
    this.log = this.log.filter((e) => Date.now() - e.at < 3_600_000);
    this.db
      .prepare(
        'INSERT INTO usage (day, units, seed_units, saved_units) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units, seed_units = seed_units + excluded.seed_units, saved_units = saved_units + excluded.saved_units',
      )
      .run(today(), units, lane === true ? units : 0, lane === 'saved' ? units : 0);
  }

  /** Seconds until a request of this size is likely to fit the budget again. */
  retryAfterSec(units: number): number {
    const now = Date.now();
    if (this.blockedUntil > now) return Math.ceil((this.blockedUntil - now) / 1000);
    if (this.usedToday().units + units > LIMITS.perDay) {
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      return Math.ceil((midnight.getTime() - now) / 1000);
    }
    if (this.used(3_600_000, now) + units > LIMITS.perHour) return 600;
    const recent = this.log.filter((e) => now - e.at < 60_000).sort((a, b) => a.at - b.at);
    let freed = this.used(60_000, now);
    for (const e of recent) {
      freed -= e.units;
      if (freed + units <= LIMITS.perMinute) return Math.max(2, Math.ceil((e.at + 60_000 - now) / 1000));
    }
    return 20;
  }

  /**
   * Fetch JSON from Open-Meteo, waiting up to `maxWaitMs` for budget. Interactive callers
   * wait briefly and otherwise get a 429 with a Retry-After hint; the seeder passes 0.
   */
  async fetchJson<T>(url: string, units: number, opts: { seed?: boolean; lane?: 'saved'; maxWaitMs?: number } = {}): Promise<T> {
    const seed = Boolean(opts.seed || opts.lane);
    if (!seed) this.lastInteractiveAt = Date.now();
    const deadline = Date.now() + (opts.maxWaitMs ?? 3000);
    while (!this.canSpend(units, opts.lane ?? seed)) {
      // Don't wait for budget that can't free up in time (e.g. today's allowance is used up):
      // callers then serve what's stored straight away.
      if (Date.now() >= deadline || Date.now() + this.retryAfterSec(units) * 1000 > deadline) {
        const daily = this.usedToday().units + units > LIMITS.perDay;
        throw new UpstreamError(
          daily
            ? 'The daily free weather API allowance is used up. Data already saved is still available; new data resumes after 00:00 UTC (08:00 Singapore time).'
            : 'Weather API budget is temporarily used up; please retry shortly.',
          429,
          this.retryAfterSec(units),
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.record(units, opts.lane ?? seed);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429) {
        this.blockedUntil = Date.now() + 65_000;
        throw new UpstreamError('Open-Meteo rate limit reached; backing off for a minute.', 429, 65);
      }
      if (!res.ok) throw new UpstreamError(`Open-Meteo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(`Open-Meteo request failed: ${(e as Error).message}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }
}
