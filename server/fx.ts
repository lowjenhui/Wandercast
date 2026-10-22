// Singapore dollar exchange rates for the page subtitles, from ExchangeRate-API's open endpoint
// (no key; one request returns every currency against SGD, updated daily). The latest response is
// kept in SQLite and refreshed at most every 12 hours; when the provider can't be reached the
// stored one is served.
//
//   GET /api/fx?cc=TH,JP   → FxResponse (src/lib/fx.ts) for those countries' currencies
//
// Country → currency comes from the world-countries package (the first listed currency).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db';
import type { FxRate, FxResponse } from '../src/lib/fx';

const URL_SGD = 'https://open.er-api.com/v6/latest/SGD';
const REFRESH_MS = 12 * 3600_000;
const SOURCE = { name: 'Rates by ExchangeRate-API', url: 'https://www.exchangerate-api.com' };

interface Country {
  cca2: string;
  currencies?: Record<string, { name: string; symbol?: string }>;
}

/** Country code → its main currency, from world-countries. */
export function loadCurrencies(root: string): Map<string, { code: string; symbol: string | null }> {
  const list = JSON.parse(readFileSync(join(root, 'node_modules', 'world-countries', 'countries.json'), 'utf8')) as Country[];
  const out = new Map<string, { code: string; symbol: string | null }>();
  for (const c of list) {
    const [code, info] = Object.entries(c.currencies ?? {})[0] ?? [];
    if (code) out.set(c.cca2, { code, symbol: info?.symbol ?? null });
  }
  return out;
}

export class FxStore {
  private loading: Promise<void> | null = null;

  constructor(
    private db: DB,
    private currencies: Map<string, { code: string; symbol: string | null }>,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS fx_rates (base TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  }

  private row(): { body: string; fetched_at: number } | undefined {
    return this.db.prepare("SELECT body, fetched_at FROM fx_rates WHERE base = 'SGD'").get() as { body: string; fetched_at: number } | undefined;
  }

  /** Refresh the stored rates when they're older than 12 hours (one request at a time). */
  ensure(): Promise<void> {
    const r = this.row();
    if (r && this.now() - r.fetched_at < REFRESH_MS) return Promise.resolve();
    this.loading ??= (async () => {
      try {
        const res = await this.fetchFn(URL_SGD, { signal: AbortSignal.timeout(15_000) });
        const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
        if (res.ok && body.result === 'success' && body.rates) {
          this.db.prepare("INSERT OR REPLACE INTO fx_rates (base, body, fetched_at) VALUES ('SGD', ?, ?)").run(JSON.stringify(body), this.now());
        }
      } catch {
        /* keep serving the stored rates */
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Rates for these countries (Singapore and unknown currencies are left out). */
  rates(ccs: string[]): FxResponse {
    const r = this.row();
    const body = r ? (JSON.parse(r.body) as { rates?: Record<string, number>; time_last_update_unix?: number }) : null;
    const seen = new Set<string>();
    const rates: FxRate[] = [];
    for (const cc of ccs) {
      const cur = this.currencies.get(cc.toUpperCase());
      const perSgd = cur ? body?.rates?.[cur.code] : undefined;
      if (!cur || cur.code === 'SGD' || !perSgd || seen.has(cur.code)) continue;
      seen.add(cur.code);
      rates.push({ cc: cc.toUpperCase(), code: cur.code, symbol: cur.symbol, perSgd });
    }
    const date = body?.time_last_update_unix ? new Date(body.time_last_update_unix * 1000).toISOString().slice(0, 10) : null;
    return { date, rates, source: SOURCE };
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== '/api/fx') return next();
      await this.ensure();
      const ccs = (url.searchParams.get('cc') ?? '').split(',').filter((c) => /^[A-Za-z]{2}$/.test(c));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.rates(ccs)));
    };
  }
}
