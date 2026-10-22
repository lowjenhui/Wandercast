// Recent unrest and security alerts from other governments, shared by the server (which reads
// the feeds) and the browser (which matches them to a place). Informational only: they never
// change the MFA level, insurer cover, weather ratings or what lists leave out.
//
//   us-embassy  each US embassy's "Alerts" RSS feed (Demonstration, Security, Weather, Natural
//               disaster, Health alerts). Alert titles name the embassy, not the event, so places
//               are read from the alert's "Location:" line, else its "Event:" text.
//   fcdo        UK FCDO travel advice: the index's latest change per country, kept only when it's
//               about unrest or security (protests, curfews, terrorism…). Country-level only.
//
// An alert is shown for ALERT_DAYS after it was issued. It belongs to a place when one of the
// cities it names is within MATCH_KM; an alert naming no city (or "countrywide") is country-level.

export const ALERT_DAYS = 14;
export const MATCH_KM = 50;

export type AlertSource = 'us-embassy' | 'fcdo';
export type AlertKind = 'demonstration' | 'security' | 'weather' | 'disaster' | 'health' | 'update';

export const SOURCE_LABEL: Record<AlertSource, string> = { 'us-embassy': 'US Embassy', fcdo: 'UK FCDO' };
export const KIND_LABEL: Record<AlertKind, string> = {
  demonstration: 'Demonstration alert',
  security: 'Security alert',
  weather: 'Weather alert',
  disaster: 'Natural disaster alert',
  health: 'Health alert',
  update: 'Latest update',
};

export interface AlertPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface TravelAlert {
  /** Stable id: the feed item's link (US) or "fcdo:<slug>:<updated>". */
  id: string;
  source: AlertSource;
  cc: string;
  kind: AlertKind;
  title: string;
  /** One or two sentences from the event text. */
  summary: string;
  url: string;
  /** ISO timestamp the source gives. */
  issued: string;
  /** Cities the alert names (empty: country-level). */
  places: AlertPlace[];
}

export interface AlertFeed {
  checkedAt: number | null;
  alerts: TravelAlert[];
  error?: string;
}

/** A city the matcher may find in alert text. */
export type CityRef = AlertPlace & { cc: string };

// ------------------------------------------------------------------ US embassy RSS

const KINDS: [RegExp, AlertKind][] = [
  [/^demonstration alert/i, 'demonstration'],
  [/^(?:security|terrorism|emergency) alert/i, 'security'],
  [/^weather alert/i, 'weather'],
  [/^natural disaster alert/i, 'disaster'],
  [/^health alert/i, 'health'],
];

const decodeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const tag = (item: string, name: string) => item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';

/** Plain text of an HTML fragment, one space between words. */
export function plainText(html: string): string {
  return decodeXml(decodeXml(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The "Location:" line and "Event:" text of an alert body (either may be missing). */
export function alertFields(text: string): { location: string; event: string } {
  const END = /\s(?:Events?(?:\(s\))?|Anticipated Impacts?|Recommendations|Actions to Take|Actions|Assistance)\s?:|\s(?:Anticipated Impacts?|Recommendations|Actions to Take)\b/;
  const loc = text.match(/\bLocation\s?:\s*(.*)$/i)?.[1] ?? '';
  const location = loc ? loc.split(END)[0].trim() : '';
  const ev = text.match(/\bEvents?(?:\(s\))?\s?:\s*(.*)$/i)?.[1] ?? '';
  const event = (ev ? ev.split(END)[0] : '').trim();
  return { location, event };
}

/** Sentences, not split after abbreviations such as "U.S.", "a.m." or "St.". */
export function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/);
  const out: string[] = [];
  for (const p of parts) {
    const prev = out.at(-1);
    if (prev !== undefined && /(?:\b(?:[A-Za-z]\.){2,}|\b(?:St|Mr|Mrs|Ms|Dr|No|Ave|Mt|approx|e\.g|i\.e)\.)$/.test(prev)) out[out.length - 1] = `${prev} ${p}`;
    else out.push(p);
  }
  return out;
}

/** The first sentence or two of the event, at most ~240 characters. */
export function summarise(event: string): string {
  let out = '';
  for (const s of sentences(event.trim())) {
    if (out && (out + s).length > 240) break;
    out = out ? `${out} ${s}` : s;
    if (out.length > 120) break;
  }
  out = out.trim();
  return out.length > 260 ? `${out.slice(0, 257).replace(/\s+\S*$/, '')}…` : out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words that put a city name in place ("in Paris", "parts of Paris", "including Lille"). */
const PLACE_WORDS = `(?:${['in', 'near', 'around', 'at', 'of', 'including', 'across', 'throughout', 'outside', 'from', 'to', 'and', 'central', 'downtown'].map((w) => `[${w[0]}${w[0].toUpperCase()}]${w.slice(1)}`).join('|')})`;

/**
 * Cities of `cc` named in the text, as whole words. The embassy's own name ("U.S. Embassy
 * Paris", "Consulate General Mumbai") is removed first, as it says who wrote the alert, not
 * where. "Countrywide" / "nationwide" alerts name no city. With `placed`, a name counts only
 * after a place word, so event text listing e.g. airport links ("Abu Dhabi: https://…")
 * doesn't tie the alert to those cities; a "Location:" line is matched without it.
 */
export function matchCities(text: string, cc: string, cities: CityRef[], placed = false): AlertPlace[] {
  const t = text.replace(/(?:U\.?S\.? )?(?:Embassy|Consulates?(?: General)?|Mission)(?: (?:in|to))? (?:[A-Z][\w'’-]*\s?){1,3}/g, ' ');
  if (/\b(?:countrywide|nationwide|worldwide)\b/i.test(t) && !/\b(?:in|near|around) [A-Z]/.test(t)) return [];
  const out: AlertPlace[] = [];
  const seen = new Set<string>();
  for (const c of cities) {
    if (c.cc !== cc || c.name.length < 4 || seen.has(c.name)) continue;
    const before = placed ? `(?<=\\b${PLACE_WORDS}\\s+(?:the\\s+)?(?:city of\\s+)?)` : '';
    if (new RegExp(`${before}(?<![\\w-])${escapeRe(c.name)}(?![\\w-])`).test(t)) {
      seen.add(c.name);
      out.push({ name: c.name, lat: c.lat, lon: c.lon });
    }
  }
  // "New Delhi" also contains "Delhi": keep both points (they're close), but drop names that are
  // only part of a longer match at the same spot, so the list reads cleanly.
  return out.filter((p) => !out.some((q) => q !== p && q.name.includes(p.name) && kmBetween(p, q) < MATCH_KM));
}

/** Alerts in one embassy feed (other posts, such as routine messages, are skipped). */
export function parseEmbassyFeed(xml: string, cc: string, cities: CityRef[]): TravelAlert[] {
  const out: TravelAlert[] = [];
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const title = plainText(tag(item, 'title'));
    const kind = KINDS.find(([re]) => re.test(title))?.[1];
    if (!kind || /worldwide caution/i.test(title)) continue;
    const url = plainText(tag(item, 'link'));
    const date = new Date(plainText(tag(item, 'pubDate')));
    if (!url || Number.isNaN(date.getTime())) continue;
    const body = plainText(tag(item, 'content:encoded') || tag(item, 'description'));
    const { location, event } = alertFields(body);
    const where = location || `${title} ${event || body}`;
    // "countrywide" in the Location line: a country-level alert whatever the event text names.
    const countryWide = /\b(?:countrywide|nationwide)\b/i.test(location);
    out.push({
      id: url,
      source: 'us-embassy',
      cc,
      kind,
      title,
      summary: summarise(event || body.replace(title, '').trim()),
      url,
      issued: date.toISOString(),
      places: countryWide ? [] : matchCities(where, cc, cities, !location),
    });
  }
  return out;
}

// ------------------------------------------------------------------ UK FCDO

/** Changes worth showing: about unrest or security, not entry rules or health. */
const FCDO_UNREST = /\b(?:protest|demonstration|unrest|curfew|riot|looting|violen|terror|attack|clash|state of emergency|martial law|coup|conflict|military|armed|kidnap|explosion|shooting|strikes? (?:and|or) protests?|civil disturbance)/i;

interface FcdoChild {
  base_path?: string;
  web_url?: string;
  public_updated_at?: string;
  title?: string;
  details?: { change_description?: string; country?: { name?: string; slug?: string } };
}

/** Recent unrest-related FCDO updates from the travel-advice index (one per country). */
export function parseFcdoIndex(json: { links?: { children?: FcdoChild[] } }, ccOf: (name: string) => string | null, wanted: Set<string> | null = null): TravelAlert[] {
  const out: TravelAlert[] = [];
  for (const c of json.links?.children ?? []) {
    const name = c.details?.country?.name ?? c.title ?? '';
    const desc = (c.details?.change_description ?? '').trim();
    const updated = c.public_updated_at;
    const cc = ccOf(name);
    if (!cc || !updated || !desc || !FCDO_UNREST.test(desc)) continue;
    if (wanted && !wanted.has(cc)) continue;
    const slug = c.details?.country?.slug ?? c.base_path?.split('/').pop() ?? cc.toLowerCase();
    out.push({
      id: `fcdo:${slug}:${updated}`,
      source: 'fcdo',
      cc,
      kind: 'update',
      title: `FCDO travel advice: ${name}`,
      summary: desc,
      url: c.web_url ?? `https://www.gov.uk/foreign-travel-advice/${slug}`,
      issued: new Date(updated).toISOString(),
      places: [],
    });
  }
  return out;
}

// ------------------------------------------------------------------ matching

export function kmBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isActive(a: TravelAlert, now: number): boolean {
  const t = Date.parse(a.issued);
  return t <= now + 3600_000 && now - t <= ALERT_DAYS * 86400_000;
}

export interface PlaceAlerts {
  /** Alerts naming a city within MATCH_KM of the place (newest first). */
  near: TravelAlert[];
  /** Alerts for the country that name no nearby city (newest first). */
  country: TravelAlert[];
}

/** Active alerts for a place: city-matched ones, and the rest of its country's. */
export function alertsAt(alerts: TravelAlert[], p: { cc: string; lat: number; lon: number }, now = Date.now()): PlaceAlerts {
  const near: TravelAlert[] = [];
  const country: TravelAlert[] = [];
  for (const a of alerts) {
    if (a.cc !== p.cc || !isActive(a, now)) continue;
    if (a.places.some((q) => kmBetween(p, q) <= MATCH_KM)) near.push(a);
    else if (!a.places.length) country.push(a);
  }
  const newest = (x: TravelAlert, y: TravelAlert) => y.issued.localeCompare(x.issued);
  // Posts often re-issue the same text day after day: keep the newest of each.
  const once = (list: TravelAlert[]) => {
    const seen = new Set<string>();
    return list.sort(newest).filter((a) => {
      const k = `${a.source}|${a.summary}`;
      return !seen.has(k) && seen.add(k);
    });
  };
  return { near: once(near), country: once(country) };
}

/** "Paris, Lille: " when an alert names cities, else "". */
export function placesLabel(a: TravelAlert): string {
  return a.places.length ? `${a.places.map((p) => p.name).join(', ')}: ` : '';
}

/** "2 days ago", "today", "yesterday". */
export function agoLabel(iso: string, now = Date.now()): string {
  const d = Math.floor((now - Date.parse(iso)) / 86400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
