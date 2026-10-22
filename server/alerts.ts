// Unrest and security alerts from other governments (US embassies, UK FCDO), stored in SQLite.
// Informational only: see src/lib/alerts.ts.
//
// Checked at most twice a day: the FCDO travel-advice index (one call, every country's latest
// change) and the "Alerts" RSS feed of the US embassy for each destination country (one every
// 1.5 s). Alerts are kept for 60 days and served while issued within the last ALERT_DAYS.
//
//   GET /api/alerts          → AlertFeed (active alerts)
//   GET /api/alerts/status   → { checkedAt, error, active, countries, failed }

import { readFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db';
import { titleToCc } from '../src/lib/advisory';
import { isActive, parseEmbassyFeed, parseFcdoIndex, type AlertFeed, type CityRef, type TravelAlert } from '../src/lib/alerts';

const REFRESH_MS = 12 * 3600_000;
const FEED_GAP_MS = 1500;
const KEEP_MS = 60 * 86400_000;
const UA = 'Mozilla/5.0 (Wandercast local travel planner)';
const FCDO_INDEX = 'https://www.gov.uk/api/content/foreign-travel-advice';

/** Embassy feed hosts that aren't "<cc>.usembassy.gov"; null: no US post with its own feed. */
const EMBASSY_HOST: Record<string, string | null> = {
  GB: 'uk.usembassy.gov',
  HK: 'hk.usconsulate.gov',
  MO: 'hk.usconsulate.gov',
  TW: 'www.ait.org.tw',
  BT: null, // no US embassy; FCDO only
  NC: null, // French territory: the Paris feed is about France
  SG: null,
  US: null,
};

export const embassyFeed = (cc: string): string | null => {
  const host = cc in EMBASSY_HOST ? EMBASSY_HOST[cc] : `${cc.toLowerCase()}.usembassy.gov`;
  return host ? `https://${host}/category/alert/feed/` : null;
};

/** GET as text. node:https rather than fetch: embassy sites send over 16 KB of headers, which
 *  fetch (undici) rejects. Follows up to 3 redirects. */
function fetchText(url: string, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA }, maxHeaderSize: 256 * 1024, timeout: 30_000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).href, redirects - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** Countries of every destination the app offers (map, ferry, overland, direct flights). */
export function destinationCountries(publicDir: string): string[] {
  const ccs = new Set<string>();
  for (const f of ['destinations.json', 'ferry-destinations.json', 'land-destinations.json', 'gateway-destinations.json', 'direct-cities.json']) {
    try {
      const d = JSON.parse(readFileSync(join(publicDir, f), 'utf8'));
      const list: unknown[] = Array.isArray(d) ? d : (d.cities ?? d.destinations ?? []);
      for (const x of list) if (x && typeof x === 'object' && 'cc' in x) ccs.add(String((x as { cc: string }).cc));
    } catch {
      /* a missing list only narrows the countries checked */
    }
  }
  return [...ccs].sort();
}

/** Cities the matcher looks for: the map's cities plus every destination's name. */
export function cityIndex(publicDir: string): CityRef[] {
  const out: CityRef[] = [];
  try {
    for (const [name, cc, lat, lon] of JSON.parse(readFileSync(join(publicDir, 'cities.json'), 'utf8')) as [string, string, number, number][]) out.push({ name, cc, lat, lon });
  } catch {
    /* destinations only */
  }
  for (const f of ['destinations.json', 'direct-cities.json']) {
    try {
      const d = JSON.parse(readFileSync(join(publicDir, f), 'utf8'));
      for (const x of (Array.isArray(d) ? d : d.cities) as { name: string; cc: string; lat: number; lon: number }[]) out.push({ name: x.name, cc: x.cc, lat: x.lat, lon: x.lon });
    } catch {
      /* skip */
    }
  }
  return out;
}

export class AlertStore {
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;
  private failed: string[] = [];
  private countries: { cc: string; name: string }[] = [];
  private ccs: string[];
  private cities: CityRef[];

  constructor(
    private db: DB,
    publicDir: string,
    private fetch: (url: string) => Promise<string> = fetchText,
    private gapMs = FEED_GAP_MS,
    private now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS travel_alerts (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, cc TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, url TEXT NOT NULL, issued TEXT NOT NULL, places TEXT NOT NULL, first_seen INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS travel_alerts_cc ON travel_alerts (cc, issued);
    `);
    try {
      this.countries = JSON.parse(readFileSync(join(publicDir, 'capitals.json'), 'utf8'));
    } catch {
      /* FCDO names then resolve through the alias table only */
    }
    this.ccs = destinationCountries(publicDir);
    this.cities = cityIndex(publicDir);
  }

  checkedAt(): number | null {
    const row = this.db.prepare("SELECT value FROM seed_state WHERE key = 'alerts_checked_at'").get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  /** Refresh if the last check is over 12 hours old (deduplicated). */
  ensure(force = false): Promise<void> {
    const at = this.checkedAt();
    if (!force && at && this.now() - at < REFRESH_MS) return Promise.resolve();
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async refresh() {
    const errors: string[] = [];
    const failed: string[] = [];
    const wanted = new Set(this.ccs);
    try {
      const index = JSON.parse(await this.fetch(FCDO_INDEX));
      this.save(parseFcdoIndex(index, (n) => titleToCc(n, this.countries), wanted));
    } catch (e) {
      errors.push(`FCDO: ${(e as Error).message}`);
    }
    for (const cc of this.ccs) {
      const url = embassyFeed(cc);
      if (!url) continue;
      if (this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
      try {
        this.save(parseEmbassyFeed(await this.fetch(url), cc, this.cities));
      } catch {
        failed.push(cc);
      }
    }
    if (failed.length) errors.push(`US embassy feeds failed: ${failed.join(', ')}`);
    this.db.prepare('DELETE FROM travel_alerts WHERE first_seen < ? AND issued < ?').run(this.now() - KEEP_MS, new Date(this.now() - KEEP_MS).toISOString());
    this.db.prepare("INSERT OR REPLACE INTO seed_state (key, value) VALUES ('alerts_checked_at', ?)").run(String(this.now()));
    this.failed = failed;
    this.lastError = errors.length ? errors.join('; ') : null;
    if (this.lastError) console.warn(`[alerts] ${this.lastError}`);
  }

  /** Inserts new alerts and refreshes stored ones (keeping when each was first seen). */
  private save(alerts: TravelAlert[]) {
    const up = this.db.prepare(
      `INSERT INTO travel_alerts (id, source, cc, kind, title, summary, url, issued, places, first_seen) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, summary = excluded.summary, url = excluded.url, issued = excluded.issued, places = excluded.places`,
    );
    for (const a of alerts) up.run(a.id, a.source, a.cc, a.kind, a.title, a.summary, a.url, a.issued, JSON.stringify(a.places), this.now());
  }

  /** Alerts issued within ALERT_DAYS, newest first. */
  active(): TravelAlert[] {
    const rows = this.db.prepare('SELECT * FROM travel_alerts ORDER BY issued DESC').all() as Record<string, string>[];
    const now = this.now();
    return rows
      .map((r) => ({
        id: r.id,
        source: r.source as TravelAlert['source'],
        cc: r.cc,
        kind: r.kind as TravelAlert['kind'],
        title: r.title,
        summary: r.summary,
        url: r.url,
        issued: r.issued,
        places: JSON.parse(r.places),
      }))
      .filter((a) => isActive(a, now));
  }

  feed(): AlertFeed {
    return { checkedAt: this.checkedAt(), alerts: this.active(), ...(this.lastError ? { error: this.lastError } : {}) };
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== '/api/alerts' && url.pathname !== '/api/alerts/status') return next();
      // Never wait on a full refresh (about 80 s): serve what's stored and refresh behind it.
      void this.ensure();
      const body =
        url.pathname === '/api/alerts'
          ? this.feed()
          : { checkedAt: this.checkedAt(), error: this.lastError, active: this.active().length, countries: this.ccs.length, failed: this.failed };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
  }
}
