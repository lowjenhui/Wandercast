// Singapore MFA travel advisories and insurer coverage, shared by the server (which reads MFA's
// pages) and the browser (which places a destination inside the advised areas).
//
// MFA has no numbered levels, only wording, so the level comes from the guidance sentences:
//   all           "defer all travel", "avoid all travel", "advised not to travel", "avoid travel to"
//   nonEssential  "defer (all) non-essential travel", "avoid (all) non-essential travel"
//   caution       a travel notice, or "exercise caution / vigilance", "remain vigilant"
// An advisory page whose wording matches none of these is 'unknown' ("Check MFA"); it is never
// guessed. The page's category (advisory vs notice) doesn't set the level: Thailand's border
// *notice* says "defer all travel".

import type { MultiPolygon, Polygon } from 'geojson';
import { formatDate } from './dates';

export type AdvisoryLevel = 'all' | 'nonEssential' | 'caution' | 'none';
export type PageLevel = AdvisoryLevel | 'unknown';

export const LEVEL_RANK: Record<PageLevel, number> = { none: 0, caution: 1, unknown: 2, nonEssential: 3, all: 4 };
export const LEVEL_LABEL: Record<PageLevel, string> = {
  all: 'Defer all travel',
  nonEssential: 'Defer non-essential travel',
  caution: 'Exercise caution',
  unknown: 'Check MFA',
  none: 'No advisory',
};

export const MFA_BASE = 'https://www.mfa.gov.sg/travelling-overseas/travel-advisories-notices-and-visa-information/';

/** One MFA country page as stored by the server. */
export interface MfaPage {
  slug: string;
  title: string;
  /** ISO 3166-1 alpha-2, when the title could be matched. */
  cc: string | null;
  category: 'advisory' | 'notice' | 'page';
  /** The date MFA lists for the page (its latest update), YYYY-MM-DD. */
  mfaDate: string | null;
  level: PageLevel;
  /** Whether the strongest guidance names the whole country (or MFA's whole "region"). */
  scope: 'country' | 'regional';
  heading: string;
  /** The guidance sentences behind the level, strongest first (at most 3). */
  guidance: string[];
  fetchedAt: number | null;
}

/** When a page's level was observed (rows change only when the level or MFA date changes). */
export interface MfaHistory {
  slug: string;
  level: PageLevel;
  mfaDate: string | null;
  firstSeen: string;
  lastSeen: string;
}

export interface AdvisoryFeed {
  checkedAt: number | null;
  pages: MfaPage[];
  history: MfaHistory[];
  /** Set when the last check failed; the stored pages are still served. */
  error?: string;
}

export const pageUrl = (slug: string) => `${MFA_BASE}${slug}/`;

// ------------------------------------------------------------------ wording → level

const ALL_RE = /\b(?:defer|avoid)\s+(?:all\s+)?travel\b|\bnot\s+to\s+travel\b|\bavoid\s+travel\s+to\b|\bleave\s+(?:the\s+country\s+)?(?:immediately|as\s+soon\s+as)/i;
const NON_ESSENTIAL_RE = /\b(?:defer|avoid)\s+(?:all\s+)?non-essential\s+travel\b/i;
const CAUTION_RE = /\bexercise\s+(?:a\s+high\s+degree\s+of\s+|extreme\s+)?(?:caution|vigilance)\b|\bremain\s+vigilant\b/i;
/** Words that make a target part of a country rather than all of it. */
const PART_RE = /\b(?:border|borders|areas?|regions?\s+of|parts?|provinces?|states?|territory|coast|districts?|following|zones?|island|city)\b/i;
const DISCLAIMER_RE = /exercise your own skill and care/i;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s && !DISCLAIMER_RE.test(s));
}

function sentenceLevel(s: string): AdvisoryLevel {
  if (NON_ESSENTIAL_RE.test(s)) return 'nonEssential';
  if (ALL_RE.test(s)) return 'all';
  if (CAUTION_RE.test(s)) return 'caution';
  return 'none';
}

/** Where a guidance sentence sends people: the text after "travel to" / "travel within". */
function target(s: string): string {
  const m = s.match(/\btravel\s+(?:to|within)\s+(.+)$/i);
  return m ? m[1] : '';
}

/** True when the sentence's target is the named country (or MFA's whole "region"). */
function isWholeCountry(s: string, names: string[]): boolean {
  const t = target(s);
  if (!t) return false;
  if (/^the\s+region\b/i.test(t)) return true;
  if (PART_RE.test(t)) return false;
  return names.some((n) => t.toLowerCase().includes(n.toLowerCase()));
}

export function classifyAdvisory(text: string, category: MfaPage['category'], names: string[]): Pick<MfaPage, 'level' | 'scope' | 'guidance'> {
  const scored = sentences(text)
    .map((s) => ({ s, level: sentenceLevel(s) }))
    .filter((x) => x.level !== 'none')
    // "Those already there should avoid all travel to the airport" is advice for people in the
    // country, not about going there; it only counts when nothing stronger names the country.
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  if (!scored.length) {
    if (category === 'notice') return { level: 'caution', scope: 'country', guidance: [] };
    return { level: category === 'advisory' ? 'unknown' : 'none', scope: 'country', guidance: [] };
  }
  const top = scored[0];
  // Whole country if any sentence at the top level names the country.
  const atTop = scored.filter((x) => x.level === top.level);
  const whole = atTop.some((x) => isWholeCountry(x.s, names));
  return {
    level: top.level,
    scope: whole || top.level === 'caution' ? 'country' : 'regional',
    guidance: [...new Set(scored.map((x) => (x.s.length > 300 ? `${x.s.slice(0, 297).trimEnd()}…` : x.s)))].slice(0, 3),
  };
}

// ------------------------------------------------------------------ MFA titles → ISO codes

/** MFA titles that differ from the country names in capitals.json. */
export const TITLE_ALIASES: Record<string, string> = {
  'democratic republic of congo': 'CD',
  'democratic republic of the congo': 'CD',
  'republic of congo': 'CG',
  congo: 'CG',
  'republic of guinea': 'GN',
  'federated states of micronesia': 'FM',
  kosovo: 'XK',
  'north korea': 'KP',
  'south korea': 'KR',
  'kyrgyz republic': 'KG',
  'palestinian territories': 'PS',
  venezuela: 'VE',
  'united states of america': 'US',
  'united kingdom': 'GB',
  russia: 'RU',
  iran: 'IR',
  syria: 'SY',
  laos: 'LA',
  vietnam: 'VN',
  'viet nam': 'VN',
  brunei: 'BN',
  'brunei darussalam': 'BN',
  'timor-leste': 'TL',
  'east timor': 'TL',
  "cote d'ivoire": 'CI',
  'ivory coast': 'CI',
  turkey: 'TR',
  turkiye: 'TR',
  'türkiye': 'TR',
  'czech republic': 'CZ',
  czechia: 'CZ',
  moldova: 'MD',
  tanzania: 'TZ',
  bolivia: 'BO',
  'cape verde': 'CV',
  'cabo verde': 'CV',
  eswatini: 'SZ',
  swaziland: 'SZ',
  micronesia: 'FM',
  'hong kong': 'HK',
  macau: 'MO',
  macao: 'MO',
  taiwan: 'TW',
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

export function titleToCc(title: string, countries: { cc: string; name: string }[]): string | null {
  const t = norm(title);
  if (TITLE_ALIASES[t]) return TITLE_ALIASES[t];
  return countries.find((c) => norm(c.name) === t)?.cc ?? null;
}

/** Names that count as "the country" in guidance text. */
export function countryNames(title: string, cc: string | null): string[] {
  const extra: Record<string, string[]> = {
    CD: ['DRC', 'Congo'],
    AE: ['UAE'],
    KP: ['North Korea', 'DPRK'],
    SA: ['the Kingdom'],
    US: ['USA', 'United States'],
    GB: ['UK'],
    VE: ['Venezuela'],
  };
  return [title, ...(cc ? extra[cc] ?? [] : [])];
}

// ------------------------------------------------------------------ curated zones

export type ZoneArea =
  | { kind: 'country' }
  /** Natural Earth admin-1 units, by ISO 3166-2 code and/or by their `region` name. */
  | { kind: 'admin1'; codes?: string[]; regions?: string[] }
  /** Within `km` of the border shared with another country (ISO alpha-2). */
  | { kind: 'border'; with: string; km: number }
  | { kind: 'circle'; lat: number; lon: number; km: number };

export interface Zone {
  level: AdvisoryLevel;
  label: string;
  area: ZoneArea;
  /** The area is our approximation of MFA's wording (e.g. "border regions" as 50 km). */
  approx?: boolean;
}

export interface CountryZones {
  cc: string;
  /** The MFA list date these zones were written for. A newer MFA date means review. */
  asOf: string;
  zones: Zone[];
}

/** Admin-1 shapes from public/advisory-regions.json. */
export interface RegionFeature {
  type: 'Feature';
  properties: { code: string; name: string; cc: string; region: string | null };
  geometry: Polygon | MultiPolygon;
}

/** Geometry helpers the matcher needs (d3-geo in the browser; injected so tests can stub). */
export interface Geo {
  inRegion(f: RegionFeature, lon: number, lat: number): boolean;
  /** Distance in km from a point to the border between two countries, or null if unknown. */
  borderKm(a: string, b: string, lon: number, lat: number): number | null;
}

export function regionMatches(area: Extract<ZoneArea, { kind: 'admin1' }>, f: RegionFeature, cc: string): boolean {
  return Boolean(area.codes?.includes(f.properties.code) || (area.regions && f.properties.cc === cc && f.properties.region && area.regions.includes(f.properties.region)));
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export interface ZoneHit {
  slug: string;
  page: MfaPage;
  level: PageLevel;
  label: string;
  approx: boolean;
  /** No curated zones for this MFA date: the whole country is flagged until reviewed. */
  fallback: boolean;
}

export interface PlaceAdvisory {
  /** Strongest level that applies at the place. */
  level: PageLevel;
  hits: ZoneHit[];
  /** The country's own page, when it has an advisory or notice (even if it doesn't apply here). */
  countryPage: MfaPage | null;
}

/**
 * Advisories that apply at a point. Curated zones are used when they were written for the
 * page's current MFA date; otherwise (new or updated page) the page's level applies to the
 * whole country until the zones are reviewed.
 */
export function advisoryAt(
  feed: AdvisoryFeed,
  zones: Record<string, CountryZones>,
  regions: RegionFeature[],
  geo: Geo,
  p: { cc: string; lat: number; lon: number },
): PlaceAdvisory {
  const hits: ZoneHit[] = [];
  let countryPage: MfaPage | null = null;
  for (const page of feed.pages) {
    if (page.level === 'none') continue;
    const cur = zones[page.slug];
    const cc = page.cc ?? cur?.cc ?? null;
    if (cc === p.cc) countryPage = page;
    if (!cur || cur.asOf !== page.mfaDate) {
      if (cc === p.cc) hits.push({ slug: page.slug, page, level: page.level, label: page.scope === 'country' ? page.title : `Parts of ${page.title}`, approx: false, fallback: true });
      continue;
    }
    for (const z of cur.zones) {
      const a = z.area;
      const inside =
        a.kind === 'country' ? cur.cc === p.cc
        : a.kind === 'admin1' ? regions.some((f) => regionMatches(a, f, cur.cc) && geo.inRegion(f, p.lon, p.lat))
        : a.kind === 'circle' ? distanceKm(p.lat, p.lon, a.lat, a.lon) <= a.km
        : cur.cc === p.cc && (geo.borderKm(cur.cc, a.with, p.lon, p.lat) ?? Infinity) <= a.km;
      if (inside) hits.push({ slug: page.slug, page, level: z.level, label: z.label, approx: Boolean(z.approx), fallback: false });
    }
  }
  hits.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  return { level: hits[0]?.level ?? 'none', hits, countryPage };
}

// ------------------------------------------------------------------ insurer coverage

export interface InsurerRules {
  id: string;
  name: string;
  /** When these rules were checked against the insurer's pages. */
  checked: string;
  excludedCountries: string[];
  excludedRegions: { label: string; codes: string[] }[];
  /** What each MFA level means for cover. */
  mfa: Record<'all' | 'nonEssential' | 'caution', 'excluded' | 'likely-excluded' | 'covered'>;
  /** Advisories issued after you booked are covered (unforeseen). */
  coveredIfIssuedAfterBooking: boolean;
  sources: { name: string; url: string }[];
}

export type CoverageStatus = 'covered' | 'not-covered' | 'likely-not-covered' | 'maybe-covered' | 'check';

export interface Coverage {
  status: CoverageStatus;
  /** One line for badges and tooltips. */
  short: string;
  detail: string;
}

/**
 * When the level that excludes cover started, as far as we can tell. MFA only shows a page's
 * latest date, so the start is known only when our own history saw a lower level after booking.
 */
function startedAfter(history: MfaHistory[], slug: string, level: PageLevel, bookedOn: string): boolean | null {
  const rows = history.filter((h) => h.slug === slug).sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));
  // A lower level observed on or after the booking date proves the advisory came later.
  return rows.some((h) => LEVEL_RANK[h.level] < LEVEL_RANK[level] && h.lastSeen >= bookedOn) ? true : null;
}

export function coverageFor(
  ins: InsurerRules,
  adv: PlaceAdvisory,
  p: { cc: string; lat: number; lon: number },
  regions: RegionFeature[],
  geo: Geo,
  history: MfaHistory[],
  bookedOn: string | null,
  today: string,
): Coverage {
  const n = ins.name;
  if (ins.excludedCountries.includes(p.cc)) {
    return { status: 'not-covered', short: `${n}: not covered`, detail: `${n} excludes this country from its travel insurance, whatever MFA advises.` };
  }
  const region = ins.excludedRegions.find((r) => regions.some((f) => r.codes.includes(f.properties.code) && geo.inRegion(f, p.lon, p.lat)));
  if (region) return { status: 'not-covered', short: `${n}: not covered`, detail: `${n} excludes ${region.label} from its travel insurance, whatever MFA advises.` };

  const top = adv.hits[0];
  if (!top || top.level === 'none' || top.level === 'caution') {
    return { status: 'covered', short: `${n}: covered`, detail: top ? `MFA's notice here asks for caution; it doesn't affect ${n} cover.` : `No MFA advisory applies here.` };
  }
  if (top.level === 'unknown') {
    return { status: 'check', short: `${n}: check`, detail: `MFA's page couldn't be read reliably. Check MFA's advice and ${n}'s policy wording.` };
  }
  const rule = ins.mfa[top.level];
  if (rule === 'covered') return { status: 'covered', short: `${n}: covered`, detail: '' };
  const likely = rule === 'likely-excluded';
  const reason = likely
    ? `MFA advises deferring non-essential travel here. ${n} excludes places where MFA "recommends postponing" travel, which likely includes this.`
    : `MFA advises deferring all travel here, and ${n} excludes places MFA advises against travelling to.`;
  const confirm = likely ? ` Confirm with ${n}.` : '';
  const base = reason + confirm;
  const notCovered: Coverage = { status: likely ? 'likely-not-covered' : 'not-covered', short: likely ? `${n}: likely not covered` : `${n}: not covered`, detail: base };
  if (!ins.coveredIfIssuedAfterBooking) return notCovered;
  const booked = bookedOn && bookedOn <= today ? bookedOn : null;
  if (!booked) return { ...notCovered, detail: `${base} That applies if you book today: ${n} doesn't cover advisories issued before you book.` };
  if (top.page.mfaDate && booked >= top.page.mfaDate) {
    return { ...notCovered, detail: `${reason} MFA's advice was in place on ${formatDate(top.page.mfaDate)}, before your booking on ${formatDate(booked)}.${confirm}` };
  }
  if (startedAfter(history, top.slug, top.level, booked)) {
    return { status: 'covered', short: `${n}: covered (advisory after booking)`, detail: `MFA issued this advice after you booked on ${formatDate(booked)}, so ${n} treats it as unforeseen and you're covered. Keep proof of your booking date.` };
  }
  return {
    status: 'maybe-covered',
    short: `${n}: covered only if issued after booking`,
    detail: `${reason} You booked on ${formatDate(booked)}; MFA's page is dated ${top.page.mfaDate ? formatDate(top.page.mfaDate) : 'without a date'} but may repeat earlier advice. You're covered only if MFA first issued it after you booked. Confirm with ${n}.`,
  };
}

// ------------------------------------------------------------------ one-line reasons (map popover)

const REASON_RE = /^(?:In view of|Due to|Following|Given|As)\s+(?:the\s+)?(.+?),\s/i;
const MAX_REASON = 160;

/**
 * Why MFA advises this, in one short line: the "In view of … ," / "Due to … ," clause of its
 * strongest guidance sentence, or the sentence itself (trimmed) when it has no such clause.
 */
export function mfaReason(page: Pick<MfaPage, 'guidance'>): string | null {
  const s = page.guidance[0]?.replace(/\s+/g, ' ').replace(/\s*↗\s*\(opens in new tab\)/g, '').trim();
  if (!s) return null;
  const m = s.match(REASON_RE);
  const out = m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : s;
  return out.length > MAX_REASON ? `${out.slice(0, MAX_REASON - 1).replace(/\s+\S*$/, '')}…` : out;
}

/** The insurer's part of a coverage explanation, in one line ("FWD excludes places …"). */
export function insurerReason(detail: string, insurer: string): string | null {
  const sentences = detail.match(/[^.]+\.(?:\s|$)/g)?.map((x) => x.trim()) ?? (detail ? [detail] : []);
  const s = sentences.find((x) => x.includes(insurer)) ?? sentences[0];
  if (!s) return null;
  const i = s.indexOf(`, and ${insurer}`);
  return i >= 0 ? s.slice(i + 6) : s;
}
