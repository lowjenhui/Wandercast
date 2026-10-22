// Singapore MFA travel advisories and notices, stored in SQLite.
//
// MFA's list page (~580 KB) embeds every country page with its category ("Travel page", "… with
// travel advisory", "… with travel notice") and date. It is read at most daily; only flagged
// pages whose date changed are then fetched. Those pages are ~15 MB, but everything shown is in
// <main> within the first ~130 KB, so each download stops at </main>.
//
// Every check records each page's level in mfa_history (a row per level and MFA date, with the
// days it was first and last seen), so the app can later tell an advisory issued after a booking
// from one already in force.
//
//   GET /api/advisories          → AdvisoryFeed
//   GET /api/advisories/status   → { checkedAt, error, flagged, needsReview }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DB } from './db';
import { classifyAdvisory, countryNames, MFA_BASE, pageUrl, titleToCc, type AdvisoryFeed, type MfaHistory, type MfaPage, type PageLevel } from '../src/lib/advisory';

const REFRESH_MS = 24 * 3600_000;
const PAGE_GAP_MS = 1500; // be polite: one page every 1.5 s
const MAX_PAGE_BYTES = 2_000_000;
const UA = 'Mozilla/5.0 (Wandercast local travel planner)';

export interface ListItem {
  slug: string;
  title: string;
  date: string | null;
  category: MfaPage['category'];
}

const CATEGORY: Record<string, MfaPage['category']> = {
  'Travel page with travel advisory': 'advisory',
  'Travel page with travel notice': 'notice',
  'Travel page': 'page',
};

/** Every country page in the list page's embedded data. */
export function parseMfaList(html: string): ListItem[] {
  const s = html.replace(/\\"/g, '"');
  const re = /\{"id":"\/travelling-overseas\/travel-advisories-notices-and-visa-information\/([a-z0-9-]+)","date":"([^"]*)","plaintextTags":\[(.*?)\],"title":"([^"]+)"/g;
  const out = new Map<string, ListItem>();
  for (const m of s.matchAll(re)) {
    const tag = m[3].match(/"selected":\["([^"]+)"/)?.[1] ?? 'Travel page';
    const date = m[2].match(/^\$D(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    out.set(m[1], { slug: m[1], title: decode(m[4]), date, category: CATEGORY[tag] ?? 'page' });
  }
  return [...out.values()];
}

function decode(s: string): string {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\\u0026/g, '&');
}

/** The advisory or notice block of a country page: after the intro, before "Entry and Exit". */
export function parseMfaPage(html: string): { heading: string; text: string } {
  const i = html.indexOf('<main');
  const j = html.indexOf('</main>');
  const main = i >= 0 ? html.slice(i, j > i ? j : undefined) : html;
  const text = decode(main.replace(/<(?:br|\/p|\/li|\/h\d|\/div|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n');
  const start = text.indexOf('plan your trip.');
  const after = start >= 0 ? text.slice(start + 'plan your trip.'.length) : text;
  const end = after.search(/\n\s*(?:Entry and Exit|Disclaimer)\b/);
  const block = (end >= 0 ? after.slice(0, end) : after).trim();
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /travel\s+(?:advisory|notice)/i.test(l) && l.length < 160) ?? '';
  // Headings and date lines have no full stop, so they would run into the first sentence.
  const DATE_LINE = /^(?:last updated on\s+)?\d{1,2}\s+[A-Z][a-z]+\s+\d{4}$/i;
  const body = lines.filter((l) => l !== heading && !DATE_LINE.test(l));
  return { heading, text: body.join(' ').replace(/\s+/g, ' ').trim() };
}

/** Download a page; country pages only as far as </main> (the list's data comes after it). */
async function fetchMfa(url: string, untilMainEnd: boolean): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new Error(`MFA HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let html = '';
  try {
    while (html.length < (untilMainEnd ? MAX_PAGE_BYTES : 4 * MAX_PAGE_BYTES)) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (untilMainEnd && html.includes('</main>')) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return html;
}

const todaySG = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export class AdvisoryStore {
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;
  private countries: { cc: string; name: string }[] = [];

  constructor(
    private db: DB,
    private root: string,
    private fetchText: (url: string, untilMainEnd: boolean) => Promise<string> = fetchMfa,
    private gapMs = PAGE_GAP_MS,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mfa_pages (
        slug TEXT PRIMARY KEY, title TEXT NOT NULL, cc TEXT, category TEXT NOT NULL, mfa_date TEXT,
        level TEXT NOT NULL, scope TEXT NOT NULL, heading TEXT NOT NULL, guidance TEXT NOT NULL, fetched_at INTEGER
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS mfa_history (
        slug TEXT NOT NULL, level TEXT NOT NULL, mfa_date TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mfa_history_slug ON mfa_history (slug, first_seen);
    `);
    try {
      this.countries = JSON.parse(readFileSync(join(root, 'public', 'capitals.json'), 'utf8'));
    } catch {
      /* titles then resolve through the alias table only */
    }
  }

  private checkedAt(): number | null {
    const row = this.db.prepare("SELECT value FROM seed_state WHERE key = 'mfa_checked_at'").get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  /** Refresh from MFA if the last check is over a day old (deduplicated). */
  ensure(force = false): Promise<void> {
    const at = this.checkedAt();
    if (!force && at && Date.now() - at < REFRESH_MS) return Promise.resolve();
    this.inflight ??= this.refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private stored(slug: string): MfaPage | null {
    return this.pages().find((p) => p.slug === slug) ?? null;
  }

  private async refresh() {
    try {
      const list = parseMfaList(await this.fetchText(MFA_BASE, false));
      if (list.length < 100) throw new Error(`MFA list page had ${list.length} countries; its layout may have changed`);
      const today = todaySG();
      for (const item of list) {
        const cc = titleToCc(item.title, this.countries);
        const prev = this.stored(item.slug);
        let page: MfaPage;
        if (item.category === 'page') {
          page = { slug: item.slug, title: item.title, cc, category: 'page', mfaDate: item.date, level: 'none', scope: 'country', heading: '', guidance: [], fetchedAt: null };
        } else if (prev && prev.mfaDate === item.date && prev.category === item.category && prev.fetchedAt) {
          page = { ...prev, title: item.title, cc };
        } else {
          if (this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
          const { heading, text } = parseMfaPage(await this.fetchText(pageUrl(item.slug), true));
          page = {
            slug: item.slug,
            title: item.title,
            cc,
            category: item.category,
            mfaDate: item.date,
            heading,
            ...classifyAdvisory(text, item.category, countryNames(item.title, cc)),
            fetchedAt: Date.now(),
          };
        }
        this.save(page, today);
      }
      // Pages no longer listed: their advice is withdrawn.
      const listed = new Set(list.map((i) => i.slug));
      for (const p of this.pages()) if (!listed.has(p.slug) && p.level !== 'none') this.save({ ...p, level: 'none', guidance: [], heading: '' }, today);
      this.db.prepare("INSERT OR REPLACE INTO seed_state (key, value) VALUES ('mfa_checked_at', ?)").run(String(Date.now()));
      this.lastError = null;
      const review = this.needsReview();
      if (review.length) console.warn(`[advisories] MFA pages without current zones (whole country flagged until reviewed): ${review.join(', ')}`);
    } catch (e) {
      // Keep serving what's stored; only the status reports the failure.
      this.lastError = (e as Error).message;
      console.warn(`[advisories] MFA check failed: ${this.lastError}`);
    }
  }

  private save(p: MfaPage, today: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO mfa_pages (slug, title, cc, category, mfa_date, level, scope, heading, guidance, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(p.slug, p.title, p.cc, p.category, p.mfaDate, p.level, p.scope, p.heading, JSON.stringify(p.guidance), p.fetchedAt);
    const last = this.db.prepare('SELECT rowid AS id, level, mfa_date FROM mfa_history WHERE slug = ? ORDER BY first_seen DESC, rowid DESC LIMIT 1').get(p.slug) as
      | { id: number; level: string; mfa_date: string | null }
      | undefined;
    if (last && last.level === p.level && last.mfa_date === p.mfaDate) {
      this.db.prepare('UPDATE mfa_history SET last_seen = ? WHERE rowid = ?').run(today, last.id);
    } else {
      this.db.prepare('INSERT INTO mfa_history (slug, level, mfa_date, first_seen, last_seen) VALUES (?,?,?,?,?)').run(p.slug, p.level, p.mfaDate, today, today);
    }
  }

  pages(): MfaPage[] {
    const rows = this.db.prepare('SELECT * FROM mfa_pages ORDER BY slug').all() as Record<string, string | number | null>[];
    return rows.map((r) => ({
      slug: r.slug as string,
      title: r.title as string,
      cc: (r.cc as string | null) ?? null,
      category: r.category as MfaPage['category'],
      mfaDate: (r.mfa_date as string | null) ?? null,
      level: r.level as PageLevel,
      scope: r.scope as MfaPage['scope'],
      heading: r.heading as string,
      guidance: JSON.parse(r.guidance as string),
      fetchedAt: (r.fetched_at as number | null) ?? null,
    }));
  }

  history(): MfaHistory[] {
    return (this.db.prepare('SELECT slug, level, mfa_date, first_seen, last_seen FROM mfa_history ORDER BY slug, first_seen').all() as Record<string, string | null>[]).map((r) => ({
      slug: r.slug!,
      level: r.level as PageLevel,
      mfaDate: r.mfa_date,
      firstSeen: r.first_seen!,
      lastSeen: r.last_seen!,
    }));
  }

  feed(): AdvisoryFeed {
    // Plain pages carry no advice; their history rows still serve as "no advisory" evidence.
    const flagged = this.pages().filter((p) => p.level !== 'none');
    const slugs = new Set(flagged.map((p) => p.slug));
    return { checkedAt: this.checkedAt(), pages: flagged, history: this.history().filter((h) => slugs.has(h.slug)), ...(this.lastError ? { error: this.lastError } : {}) };
  }

  /** Flagged pages whose curated zones are missing or written for an older MFA date. */
  needsReview(): string[] {
    let zones: Record<string, { asOf?: string }> = {};
    try {
      zones = JSON.parse(readFileSync(join(this.root, 'src', 'data', 'advisoryZones.json'), 'utf8'));
    } catch {
      /* no zones file: every flagged page needs review */
    }
    return this.pages()
      .filter((p) => p.level !== 'none' && zones[p.slug]?.asOf !== p.mfaDate)
      .map((p) => `${p.slug} (${p.mfaDate ?? 'undated'})`);
  }

  handler() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== '/api/advisories' && url.pathname !== '/api/advisories/status') return next();
      // The first request waits for the first check; later ones are served from the database.
      if (this.checkedAt() === null) await this.ensure();
      else void this.ensure();
      const body =
        url.pathname === '/api/advisories'
          ? this.feed()
          : { checkedAt: this.checkedAt(), error: this.lastError, flagged: this.pages().filter((p) => p.level !== 'none').length, needsReview: this.needsReview() };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
  }
}
