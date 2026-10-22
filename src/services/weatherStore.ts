// Point-level caches + rate-limited fetch queues for map data (current weather, trip outlooks).
//
// Open-Meteo's free tier allows ~600 location-calls per minute per client, and every
// location in a multi-point request counts (multi-year requests count once per year).
// All stores share one per-minute budget. Requests are queued (most recently visible
// first), batched, and cached in memory and localStorage.

import type { AirQuality, CurrentWeather } from '../lib/currentConditions';
import type { LatLon } from './currentWeather';
import type { ServiceError } from './http';

export interface PointRequest extends LatLon {
  id: string;
}

export interface Entry<T> {
  at: number;
  value: T;
}

export interface StoreStatus {
  pending: number;
  rateLimitedUntil: number | null;
  lastError: string | null;
}

/**
 * Shared per-minute budget for map requests. The local cache server meters the real
 * Open-Meteo quota; this just stops the browser flooding it with requests.
 */
const budget = {
  limit: 2000,
  spent: [] as { at: number; n: number }[],
  left(now = Date.now()) {
    this.spent = this.spent.filter((s) => now - s.at < 60_000);
    return this.limit - this.spent.reduce((a, s) => a + s.n, 0);
  },
  take(n: number) {
    this.spent.push({ at: Date.now(), n });
  },
  nextFreeInMs() {
    const oldest = this.spent[0]?.at ?? Date.now();
    return Math.max(50, oldest + 60_000 - Date.now() + 50);
  },
  blockedUntil: 0,
};

export interface PointStoreOptions<T> {
  fetchBatch: (points: PointRequest[], ctx: { refresh: boolean }) => Promise<(T | null)[]>;
  /** Budget units each point costs (e.g. 2 for weather + air quality, 5 for five years of history). */
  costPerPoint: number | ((refresh: boolean) => number);
  batchSize: number;
  ttlMs: number;
  /** A shorter lifetime for some values (e.g. "not stored yet" placeholders). */
  ttlFor?: (value: T | null) => number | undefined;
  storageKey?: string;
}

export class PointStore<T> {
  private data = new Map<string, Entry<T | null>>();
  private queue: PointRequest[] = [];
  private inFlight = new Set<string>();
  private attempts = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer: number | null = null;
  private saveTimer: number | null = null;
  private version = 0;
  private status: StoreStatus = { pending: 0, rateLimitedUntil: null, lastError: null };
  /** True from reload() until the requests it triggers are done. */
  private refreshing = false;

  constructor(private opts: PointStoreOptions<T>) {
    this.restore();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;
  getStatus = () => this.status;

  /** Cached value (null = provider had no data for the point), or undefined if not loaded. */
  get(id: string): T | null | undefined {
    const d = this.data.get(id);
    return d && Date.now() - d.at < this.ttl(d.value) ? d.value : undefined;
  }

  /** Drop everything and ask for fresh data on the next requests (the caller re-requests). */
  reload() {
    this.data.clear();
    this.queue = [];
    this.attempts.clear();
    this.refreshing = true;
    this.persist();
    this.setStatus({ pending: this.inFlight.size });
  }

  isRefreshing = () => this.refreshing;

  private cost(refresh = this.refreshing) {
    const c = this.opts.costPerPoint;
    return typeof c === 'function' ? c(refresh) : c;
  }

  /** Fetches these points fresh from the API now (a place the user asked to load), not just stored data. */
  loadFresh(points: PointRequest[]) {
    const fresh = points.filter((p) => !this.inFlight.has(p.id));
    if (!fresh.length) return;
    fresh.forEach((p) => {
      this.data.delete(p.id);
      this.attempts.delete(p.id);
      this.inFlight.add(p.id);
    });
    budget.take(fresh.length * this.cost(true));
    this.setStatus({ pending: this.queue.length + this.inFlight.size });
    void this.fetchBatch(fresh, true);
  }

  private ttl(v: T | null): number {
    return this.opts.ttlFor?.(v) ?? this.opts.ttlMs;
  }

  latest(): number | null {
    let max: number | null = null;
    for (const d of this.data.values()) if (max === null || d.at > max) max = d.at;
    return max;
  }

  /** Ask for data for these points. Later calls take priority over earlier queued ones. */
  request(points: PointRequest[]) {
    const wanted = points.filter((p) => this.get(p.id) === undefined && !this.inFlight.has(p.id));
    const ids = new Set(wanted.map((p) => p.id));
    this.queue = [...wanted, ...this.queue.filter((q) => !ids.has(q.id))];
    this.setStatus({ pending: this.queue.length + this.inFlight.size });
    this.pump();
  }

  private schedule(ms: number) {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.pump();
    }, ms);
  }

  private pump() {
    const now = Date.now();
    if (budget.blockedUntil > now) {
      this.setStatus({ rateLimitedUntil: budget.blockedUntil });
      this.schedule(budget.blockedUntil - now + 50);
      return;
    }
    if (this.status.rateLimitedUntil) this.setStatus({ rateLimitedUntil: null });

    while (this.queue.length) {
      const cost = this.cost();
      const size = cost === 0 ? this.opts.batchSize : Math.min(this.opts.batchSize, Math.floor(budget.left() / cost));
      if (size <= 0) {
        this.schedule(budget.nextFreeInMs());
        return;
      }
      const batch = this.queue.splice(0, size);
      budget.take(batch.length * cost);
      batch.forEach((p) => this.inFlight.add(p.id));
      void this.fetchBatch(batch, this.refreshing);
    }
  }

  private async fetchBatch(batch: PointRequest[], refresh: boolean) {
    try {
      const values = await this.opts.fetchBatch(batch, { refresh });
      const at = Date.now();
      batch.forEach((p, i) => this.data.set(p.id, { at, value: values[i] ?? null }));
      this.recheckLater(batch.filter((_, i) => this.opts.ttlFor?.(values[i] ?? null) !== undefined));
      this.setStatus({ lastError: null });
      this.persist();
    } catch (e) {
      const err = e as ServiceError;
      if (err.status === 429) {
        // The cache server says when budget frees up; wait that long, then carry on.
        budget.blockedUntil = Math.max(budget.blockedUntil, Date.now() + (err.retryAfter ?? 20) * 1000);
        this.queue.push(...batch);
        this.setStatus({ rateLimitedUntil: budget.blockedUntil, lastError: 'Weather API budget is busy; resuming shortly.' });
      } else {
        // Timeouts and network errors: retry a few times before giving up on these points.
        const retry = batch.filter((p) => (this.attempts.get(p.id) ?? 0) < 3);
        retry.forEach((p) => this.attempts.set(p.id, (this.attempts.get(p.id) ?? 0) + 1));
        batch.filter((p) => !retry.includes(p)).forEach((p) => this.data.set(p.id, { at: Date.now(), value: null }));
        this.setStatus({ lastError: (e as Error).message });
        if (retry.length) window.setTimeout(() => this.request(retry), 5000);
      }
    } finally {
      batch.forEach((p) => this.inFlight.delete(p.id));
      if (!this.queue.length && !this.inFlight.size) this.refreshing = false;
      this.setStatus({ pending: this.queue.length + this.inFlight.size });
      if (this.queue.length) this.pump();
    }
  }

  private rechecks = new Map<string, number>();

  /** Re-read short-lived placeholders when they expire (up to ~40 times, e.g. an hour). */
  private recheckLater(points: PointRequest[]) {
    const due = points.filter((p) => {
      const n = (this.rechecks.get(p.id) ?? 0) + 1;
      this.rechecks.set(p.id, n);
      return n <= 40;
    });
    if (!due.length) return;
    const ms = Math.max(...due.map((p) => this.ttl(this.data.get(p.id)?.value ?? null))) + 200;
    window.setTimeout(() => this.request(due), ms);
  }

  private setStatus(patch: Partial<StoreStatus>) {
    this.status = { ...this.status, ...patch };
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  private restore() {
    if (!this.opts.storageKey) return;
    try {
      const raw = JSON.parse(localStorage.getItem(this.opts.storageKey) ?? 'null') as [string, Entry<T | null>][] | null;
      const now = Date.now();
      raw?.forEach(([id, d]) => now - d.at < this.ttl(d.value) && this.data.set(id, d));
    } catch {
      /* storage unavailable or corrupt: start empty */
    }
  }

  private persist() {
    const key = this.opts.storageKey;
    if (!key || this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const now = Date.now();
      try {
        localStorage.setItem(key, JSON.stringify([...this.data].filter(([, d]) => now - d.at < this.ttl(d.value))));
      } catch {
        /* ignore quota/private-mode errors */
      }
    }, 1000);
  }
}

/** Current conditions + air quality for a point. */
export interface PointData {
  weather: CurrentWeather | null;
  aq: AirQuality | null;
}
