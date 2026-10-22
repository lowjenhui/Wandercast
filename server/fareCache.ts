// Fare cache: each fare provider's local route (Travelpayouts at /api/fares/*, SerpApi Google
// Flights at /api/live-fares/*) is forwarded upstream with its key (server-side only), and every
// successful response is stored in SQLite (fare_cache, keyed by provider prefix + request).
//
// - Cache-first: a response saved within FRESH_MS is served without calling the API.
// - Fallback: when the API fails (rate limit, rejected or missing key, monthly budget used up,
//   network) the last saved response is served, however old, marked stale so the Flights
//   section can say so.
// - Retention: fares whose departure has passed are dropped on read, and a saved response is
//   deleted once all of its departures have passed (prune()).
// - Budget: providers with a monthly search allowance (SerpApi) count upstream calls per
//   calendar month in fare_usage; background prefetch leaves `backgroundReserve` of it for
//   searches people make.
//
// Every JSON body sent to the browser carries `saved: { at, stale }` when it came from the
// database. While a provider is rate-limited, calls pause until Retry-After (or RATE_PAUSE_MS).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db';

export const FRESH_MS = 6 * 3600_000;
const RATE_PAUSE_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;
export const NOT_CONFIGURED = 'No airfare provider is configured and no saved fares exist for this search.';

const todayUTC = () => new Date().toISOString().slice(0, 10);

export type FareBody = Record<string, unknown>;

export interface FareProvider {
  /** Shown in errors, e.g. "Travelpayouts". */
  name: string;
  /** Key prefix in fare_cache and fare_usage. */
  prefix: string;
  /** Local route the browser calls, e.g. /api/fares. */
  route: string;
  configured: boolean;
  /** Searches allowed per calendar month, if the provider has an allowance. */
  monthlyLimit?: number;
  /** Part of the monthly allowance background prefetch leaves for searches people make. */
  backgroundReserve?: number;
  /** The upstream request for a local path (the part after `route`). */
  request(path: string): { url: string; init?: RequestInit };
  /** A 200 response as stored (trimmed to what the app reads), or why it's unusable. */
  accept(body: FareBody): { body: FareBody } | { reason: string };
  /** Departure dates in a stored body. */
  departures(body: FareBody, path: string): string[];
  /** The body without fares departing before `today`. */
  upcoming(body: FareBody, path: string, today: string): FareBody;
  /** Searches the provider says were used this month (free to ask), to correct the local count. */
  usage?(fetchFn: typeof fetch): Promise<number | null>;
}

/** Cache key: path with sorted query parameters, so equal requests share a row. */
export function fareKey(path: string): string {
  const u = new URL(path, 'http://local');
  u.searchParams.sort();
  return `${u.pathname}?${u.searchParams}`;
}

export type FareResult =
  | { ok: true; body: FareBody & { saved?: { at: number; stale: boolean } } }
  | { ok: false; status: number; reason: string; retryAfter?: number };

type Upstream = { ok: true; body: FareBody } | { ok: false; status: number; reason: string; retryAfter?: number };

export class FareCache {
  private pausedUntil = 0;
  /** Requests in flight, so the same search asked for twice at once is only sent once. */
  private inflight = new Map<string, Promise<FareResult>>();

  constructor(
    private db: DB,
    readonly provider: FareProvider,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS fare_cache (
      key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL, last_depart TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS fare_usage (
      prefix TEXT NOT NULL, month TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY (prefix, month)
    ) WITHOUT ROWID`);
    // Rows saved before providers had prefixes are Travelpayouts responses.
    db.exec("UPDATE OR IGNORE fare_cache SET key = 'tp:' || key WHERE key LIKE '/%'");
  }

  get configured(): boolean {
    return this.provider.configured;
  }

  /** True while the API is rate-limited (or not configured): calls are skipped. */
  get paused(): boolean {
    return !this.configured || this.now() < this.pausedUntil;
  }

  private month() {
    return new Date(this.now()).toISOString().slice(0, 7);
  }

  /** Upstream calls this calendar month. */
  used(): number {
    const r = this.db.prepare('SELECT calls FROM fare_usage WHERE prefix = ? AND month = ?').get(this.provider.prefix, this.month()) as { calls: number } | undefined;
    return r?.calls ?? 0;
  }

  /** Whether the monthly allowance has room for one more call (background calls keep the reserve). */
  canSpend(background = false): boolean {
    const { monthlyLimit, backgroundReserve = 0 } = this.provider;
    if (monthlyLimit === undefined) return true;
    return this.used() < monthlyLimit - (background ? backgroundReserve : 0);
  }

  private count() {
    this.db
      .prepare('INSERT INTO fare_usage (prefix, month, calls) VALUES (?, ?, 1) ON CONFLICT (prefix, month) DO UPDATE SET calls = calls + 1')
      .run(this.provider.prefix, this.month());
  }

  /** Replace this month's local count with the provider's own figure, when it reports one. */
  async syncUsage(): Promise<number | null> {
    if (!this.provider.usage || !this.configured) return null;
    const n = await this.provider.usage(this.fetchFn).catch(() => null);
    if (n === null) return null;
    this.db
      .prepare('INSERT INTO fare_usage (prefix, month, calls) VALUES (?, ?, ?) ON CONFLICT (prefix, month) DO UPDATE SET calls = excluded.calls')
      .run(this.provider.prefix, this.month(), n);
    return n;
  }

  private key(path: string) {
    return this.provider.prefix + fareKey(path);
  }

  private row(path: string): { body: string; fetched_at: number } | undefined {
    return this.db.prepare('SELECT body, fetched_at FROM fare_cache WHERE key = ?').get(this.key(path)) as { body: string; fetched_at: number } | undefined;
  }

  /** The stored response for a path, with its cache key (for the trip archive). */
  stored(path: string): { key: string; body: string; fetched_at: number } | undefined {
    const r = this.row(path);
    return r && { key: this.key(path), ...r };
  }

  isSaved(path: string): boolean {
    return Boolean(this.row(path));
  }

  isFresh(path: string): boolean {
    const r = this.row(path);
    return Boolean(r && this.now() - r.fetched_at < FRESH_MS);
  }

  private fromRow(path: string, r: { body: string; fetched_at: number }, stale: boolean): FareResult {
    const body = this.provider.upcoming(JSON.parse(r.body) as FareBody, path, todayUTC());
    return { ok: true, body: { ...body, saved: { at: r.fetched_at, stale } } };
  }

  private store(path: string, body: FareBody) {
    const departs = this.provider.departures(body, path).filter(Boolean).sort();
    // A response with no fares is kept until tomorrow; it's still a valid "nothing found".
    const last = departs.at(-1) ?? todayUTC();
    this.db
      .prepare('INSERT OR REPLACE INTO fare_cache (key, body, fetched_at, last_depart) VALUES (?, ?, ?, ?)')
      .run(this.key(path), JSON.stringify(body), this.now(), last);
  }

  /** Saved response if fresh, else the API (saving the result), else the last saved response. */
  get(path: string, opts: { background?: boolean } = {}): Promise<FareResult> {
    const key = this.key(path);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.load(path, opts.background ?? false).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async load(path: string, background: boolean): Promise<FareResult> {
    const saved = this.row(path);
    if (saved && this.now() - saved.fetched_at < FRESH_MS) return this.fromRow(path, saved, false);

    const live = await this.fetchUpstream(path, background);
    if (live.ok) {
      this.store(path, live.body);
      return { ok: true, body: this.provider.upcoming(live.body, path, todayUTC()) };
    }
    if (saved) return this.fromRow(path, saved, true);
    return live;
  }

  private async fetchUpstream(path: string, background: boolean): Promise<Upstream> {
    const p = this.provider;
    if (!p.configured) return { ok: false, status: 501, reason: NOT_CONFIGURED };
    if (this.now() < this.pausedUntil) {
      return { ok: false, status: 429, reason: `The ${p.name} rate limit was reached; try again later.`, retryAfter: Math.ceil((this.pausedUntil - this.now()) / 1000) };
    }
    if (!this.canSpend(background)) {
      return { ok: false, status: 429, reason: `This month's ${p.name} search allowance (${p.monthlyLimit}) is used up.` };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const { url, init } = p.request(path);
      const res = await this.fetchFn(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429) {
        const retry = Number(res.headers.get('Retry-After'));
        this.pausedUntil = this.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : RATE_PAUSE_MS);
        return { ok: false, status: 429, reason: `The ${p.name} rate limit or search allowance was reached; try again later.` };
      }
      let body: FareBody;
      try {
        body = JSON.parse(text) as FareBody;
      } catch {
        return { ok: false, status: res.ok ? 502 : res.status, reason: res.ok ? `${p.name} returned an unreadable response.` : text.slice(0, 200) || `HTTP ${res.status}` };
      }
      if (!res.ok) return { ok: false, status: res.status, reason: String(body.error || body.message || `HTTP ${res.status}`).slice(0, 200) };
      const accepted = p.accept(body);
      if ('reason' in accepted) return { ok: false, status: 502, reason: accepted.reason };
      // Count only searches that ran: providers don't charge for errors.
      if (p.monthlyLimit !== undefined) this.count();
      return { ok: true, body: accepted.body };
    } catch (e) {
      return { ok: false, status: 502, reason: (e as Error).name === 'AbortError' ? `${p.name} timed out.` : `Network error: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Delete saved responses whose departures have all passed. */
  prune(): number {
    return Number(this.db.prepare('DELETE FROM fare_cache WHERE key LIKE ? AND last_depart < ?').run(`${this.provider.prefix}%`, todayUTC()).changes);
  }

  stats() {
    const r = this.db.prepare('SELECT COUNT(*) AS n, MIN(fetched_at) AS oldest FROM fare_cache WHERE key LIKE ?').get(`${this.provider.prefix}%`) as { n: number; oldest: number | null };
    return {
      provider: this.provider.name,
      saved: r.n,
      oldest: r.oldest,
      configured: this.configured,
      pausedUntil: this.pausedUntil > this.now() ? this.pausedUntil : null,
      ...(this.provider.monthlyLimit !== undefined ? { usedThisMonth: this.used(), monthlyLimit: this.provider.monthlyLimit } : {}),
    };
  }

  /** `archived` serves past trips from the trip archive: stored fares only, never the API. */
  handler(archived?: { rangeOf: (req: IncomingMessage) => number | null; fare: (rangeId: number, key: string) => { body: string; fetched_at: number } | undefined }) {
    const route = `${this.provider.route}/`;
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = req.url ?? '/';
      if (!url.startsWith(route)) return next();
      if (url.startsWith(`${route}status`)) return send(res, 200, this.stats());
      const rangeId = archived?.rangeOf(req) ?? null;
      if (rangeId !== null) {
        const row = archived!.fare(rangeId, this.key(url.slice(this.provider.route.length)));
        if (!row) return send(res, 404, { reason: 'Not saved for this trip.' });
        return send(res, 200, { ...(JSON.parse(row.body) as FareBody), saved: { at: row.fetched_at, stale: false, archived: true } });
      }
      const r = await this.get(url.slice(this.provider.route.length));
      if (r.ok) return send(res, 200, r.body);
      send(res, r.status, { reason: r.reason }, r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {});
    };
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

// --- Travelpayouts (Aviasales Data API): cached fares other travellers found ---

type TpRow = { depart_date?: string; departure_at?: string };
const tpDepart = (r: TpRow) => (r.depart_date ?? r.departure_at ?? '').slice(0, 10);

export function travelpayouts(token: string): FareProvider {
  return {
    name: 'Travelpayouts',
    prefix: 'tp:',
    route: '/api/fares',
    configured: Boolean(token),
    request: (path) => ({ url: `https://api.travelpayouts.com${path}`, init: { headers: { 'X-Access-Token': token } } }),
    accept: (body) => (Array.isArray(body.data) ? { body } : { reason: String(body.error || 'Travelpayouts returned no fare data.') }),
    departures: (body) => ((body.data as TpRow[] | undefined) ?? []).map(tpDepart),
    upcoming: (body, _path, today) => (Array.isArray(body.data) ? { ...body, data: (body.data as TpRow[]).filter((x) => tpDepart(x) >= today) } : body),
  };
}
