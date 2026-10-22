// Flight rules settings (src/lib/flightRules.ts), stored in SQLite (app_settings).
//
//   GET /api/settings/flight-rules   { rules, defaults }
//   PUT /api/settings/flight-rules   { rules: {...} }  → invalid fields fall back to the defaults

import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_FLIGHT_RULES, normaliseRules, type FlightRules } from '../src/lib/flightRules';
import type { DB } from './db';

const KEY = 'flight_rules';

export class FlightRulesStore {
  constructor(private db: DB) {
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  get(): FlightRules {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    try {
      return normaliseRules(row ? JSON.parse(row.value) : null);
    } catch {
      return { ...DEFAULT_FLIGHT_RULES };
    }
  }

  set(input: unknown): FlightRules {
    const rules = normaliseRules(input as Partial<FlightRules>);
    this.db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(rules));
    return rules;
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      if (!(req.url ?? '').startsWith('/api/settings/flight-rules')) return next();
      if (req.method === 'GET') return send(res, 200, { rules: this.get(), defaults: DEFAULT_FLIGHT_RULES });
      if (req.method === 'PUT') {
        try {
          const body = JSON.parse(await readBody(req)) as { rules?: unknown };
          return send(res, 200, { rules: this.set(body.rules), defaults: DEFAULT_FLIGHT_RULES });
        } catch {
          return send(res, 400, { error: true, reason: 'Body must be JSON: { "rules": { ... } }' });
        }
      }
      return send(res, 405, { error: true, reason: 'Use GET or PUT' });
    };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) reject(new Error('too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
