// Pre-fetches fares for each saved range's destinations, so the Flights section has saved fares
// to fall back on when a provider is unavailable. One request per tick, newest destinations
// first, using the same requests as the Flights section (src/lib/fareRequests.ts).
//
// - refresh: true (Travelpayouts): a request saved within FRESH_MS is skipped, so each
//   destination is refreshed about every 6 hours.
// Booked trips (Puff's Lookout) are skipped: the tickets are already bought.
//
// - refresh: false (SerpApi, which has a small monthly allowance): each request is fetched once,
//   while the allowance has room beyond the reserve kept for searches people make.

import type { FareCache } from './fareCache';
import { isBooked, type SavedRanges } from './savedRanges';

const ORIGIN = 'SIN';
/** A request that failed (e.g. no fares on the route, rejected key) is retried after this. */
const RETRY_MS = 3600_000;
const todayUTC = () => new Date().toISOString().slice(0, 10);

export type PlanFn = (origin: string, destination: string, start: string, end: string, today: string) => string[];

export class FarePrefetcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private failed = new Map<string, number>();

  constructor(
    private fares: FareCache,
    private saved: SavedRanges,
    private plan: PlanFn,
    private opts: { refresh: boolean; tickMs: number },
  ) {}

  /** Fare request paths still to fetch, newest destination first. */
  pending(today = todayUTC()): string[] {
    const ranges = new Map(this.saved.list().filter((r) => r.start >= today && !isBooked(r)).map((r) => [r.id, r]));
    const paths = this.saved
      .destinations()
      .filter((d) => ranges.has(d.range_id) && /^[A-Z]{3}$/.test(d.code) && d.code !== ORIGIN)
      .sort((a, b) => b.created_at - a.created_at)
      .flatMap((d) => {
        const r = ranges.get(d.range_id)!;
        return this.plan(ORIGIN, d.code, r.start, r.end, today);
      });
    const now = Date.now();
    const done = (p: string) => (this.opts.refresh ? this.fares.isFresh(p) : this.fares.isSaved(p));
    return [...new Set(paths)].filter((p) => !done(p) && now - (this.failed.get(p) ?? 0) >= RETRY_MS);
  }

  /** One request's worth of work. True if it fetched something. */
  async step(): Promise<boolean> {
    if (this.busy || this.fares.paused || !this.fares.canSpend(true)) return false;
    const path = this.pending()[0];
    if (!path) return false;
    this.busy = true;
    try {
      const r = await this.fares.get(path, { background: true });
      if (r.ok && !r.body.saved?.stale) this.failed.delete(path);
      else this.failed.set(path, Date.now());
      return true;
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer || !this.fares.configured) return;
    this.timer = setInterval(() => void this.step().catch(() => undefined), this.opts.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
