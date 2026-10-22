import { describe, expect, it } from 'vitest';
import {
  advisoryAt,
  classifyAdvisory,
  countryNames,
  coverageFor,
  titleToCc,
  type AdvisoryFeed,
  type CountryZones,
  type Geo,
  type InsurerRules,
  type MfaPage,
  type RegionFeature,
} from './advisory';
import { distanceToLinesKm } from '../services/advisories';

// Sentences as MFA wrote them (pages checked 21 Oct 2026).
const SAUDI =
  'Given the heightened security risks, Singaporeans are advised to defer all travel to Saudi Arabia. Singaporeans already in Saudi Arabia should avoid all travel to KKIA and other high-risk areas until further notice and avoid non-essential travel within the Kingdom.';
const INDIA =
  'The security situation in the Union Territory of Jammu and Kashmir remains volatile. Singaporeans are advised to defer non-essential travel to the Union Territory of Jammu and Kashmir, especially the border regions between India and Pakistan, and to Manipur. Singaporeans in India should remain vigilant, avoid large gatherings, monitor local news closely.';
const RUSSIA = 'In view of the ongoing conflict, Singaporeans should continue to defer all non-essential travel to Russia. Singaporeans travelling to Russia should exercise personal responsibility.';
const MIDDLE_EAST = 'Due to the escalating security situation in the Middle East, Singaporeans are advised to defer all travel to the region.';
const THAILAND = "In view of ongoing tensions along the Thailand-Cambodian border, Singaporeans are advised to defer all travel to the conflict areas in the Thai-Cambodian border regions. Singaporeans in Cambodia and Thailand are advised to monitor news.";
const MOLDOVA = 'In view of the uncertain security situation, travellers are advised to avoid travel to the Transnistria region.';
const AZERBAIJAN = 'Singaporeans are advised not to travel to the Nagorno-Karabakh region.';
const COLOMBIA = 'On 10 August 2026, a 7.4 magnitude earthquake struck western Colombia. Singaporeans travelling to Colombia are strongly encouraged to eRegister.';
const DISCLAIMER = 'The MFA recommends that you exercise your own skill and care with respect to your use of this information.';

describe('MFA wording → level', () => {
  it('reads country-wide and regional advice', () => {
    expect(classifyAdvisory(SAUDI, 'advisory', countryNames('Saudi Arabia', 'SA'))).toMatchObject({ level: 'all', scope: 'country' });
    expect(classifyAdvisory(INDIA, 'advisory', countryNames('India', 'IN'))).toMatchObject({ level: 'nonEssential', scope: 'regional' });
    expect(classifyAdvisory(RUSSIA, 'advisory', countryNames('Russia', 'RU'))).toMatchObject({ level: 'nonEssential', scope: 'country' });
    expect(classifyAdvisory(MIDDLE_EAST, 'advisory', countryNames('Qatar', 'QA'))).toMatchObject({ level: 'all', scope: 'country' });
  });

  it('takes the level from the wording, not the page category', () => {
    expect(classifyAdvisory(THAILAND, 'notice', countryNames('Thailand', 'TH'))).toMatchObject({ level: 'all', scope: 'regional' });
    expect(classifyAdvisory(MOLDOVA, 'notice', countryNames('Moldova', 'MD'))).toMatchObject({ level: 'all', scope: 'regional' });
    expect(classifyAdvisory(AZERBAIJAN, 'advisory', countryNames('Azerbaijan', 'AZ'))).toMatchObject({ level: 'all', scope: 'regional' });
  });

  it('never guesses: an unreadable advisory is unknown, a plain notice is caution', () => {
    expect(classifyAdvisory(COLOMBIA, 'notice', ['Colombia']).level).toBe('caution');
    expect(classifyAdvisory(COLOMBIA, 'advisory', ['Colombia']).level).toBe('unknown');
    expect(classifyAdvisory(DISCLAIMER, 'page', ['Japan']).level).toBe('none');
  });

  it('keeps the guidance sentences, strongest first', () => {
    const c = classifyAdvisory(SAUDI, 'advisory', ['Saudi Arabia']);
    expect(c.guidance[0]).toMatch(/defer all travel to Saudi Arabia/);
  });

  it('matches MFA titles to country codes', () => {
    const caps = [{ cc: 'SA', name: 'Saudi Arabia' }, { cc: 'CI', name: "Côte d'Ivoire" }];
    expect(titleToCc('Saudi Arabia', caps)).toBe('SA');
    expect(titleToCc('Democratic Republic of Congo', caps)).toBe('CD');
    expect(titleToCc('Kosovo ', caps)).toBe('XK');
    expect(titleToCc("Cote d'Ivoire", caps)).toBe('CI');
    expect(titleToCc('Atlantis', caps)).toBeNull();
  });
});

// ------------------------------------------------------------------ places and cover

const page = (slug: string, cc: string, level: MfaPage['level'], mfaDate: string, scope: MfaPage['scope'] = 'country'): MfaPage => ({
  slug,
  title: slug,
  cc,
  category: 'advisory',
  mfaDate,
  level,
  scope,
  heading: '',
  guidance: [],
  fetchedAt: 1,
});

const JK: RegionFeature = {
  type: 'Feature',
  properties: { code: 'IN-JK', name: 'Jammu and Kashmir', cc: 'IN', region: 'North' },
  geometry: { type: 'Polygon', coordinates: [[[73, 32], [77, 32], [77, 36], [73, 36], [73, 32]]] },
};
const CRIMEA: RegionFeature = {
  type: 'Feature',
  properties: { code: 'UA-43', name: 'Crimea', cc: 'RU', region: null },
  geometry: { type: 'Polygon', coordinates: [[[32.5, 44.3], [36.6, 44.3], [36.6, 46.2], [32.5, 46.2], [32.5, 44.3]]] },
};
const regions = [JK, CRIMEA];
const inBox = (f: RegionFeature, lon: number, lat: number) => {
  const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return lon >= Math.min(...xs) && lon <= Math.max(...xs) && lat >= Math.min(...ys) && lat <= Math.max(...ys);
};
// A straight Thai-Cambodian "border" along longitude 103.
const geo: Geo = { inRegion: inBox, borderKm: (a, b, lon, lat) => (a === 'TH' && b === 'KH' ? distanceToLinesKm({ type: 'MultiLineString', coordinates: [[[103, 13], [103, 15]]] }, lon, lat) : null) };

const zones: Record<string, CountryZones> = {
  india: { cc: 'IN', asOf: '2026-06-22', zones: [{ level: 'nonEssential', label: 'Jammu and Kashmir', area: { kind: 'admin1', codes: ['IN-JK'] } }] },
  thailand: { cc: 'TH', asOf: '2025-12-09', zones: [{ level: 'all', label: 'Thai-Cambodian border', area: { kind: 'border', with: 'KH', km: 50 }, approx: true }] },
  'saudi-arabia': { cc: 'SA', asOf: '2026-10-13', zones: [{ level: 'all', label: 'Saudi Arabia', area: { kind: 'country' } }] },
  indonesia: { cc: 'ID', asOf: '2026-07-20', zones: [{ level: 'caution', label: 'Mount Merapi', area: { kind: 'circle', lat: -7.541, lon: 110.446, km: 7 } }] },
};
const feed: AdvisoryFeed = {
  checkedAt: 1,
  pages: [
    page('india', 'IN', 'nonEssential', '2026-06-22', 'regional'),
    page('thailand', 'TH', 'all', '2025-12-09', 'regional'),
    page('saudi-arabia', 'SA', 'all', '2026-10-13'),
    page('indonesia', 'ID', 'caution', '2026-07-20'),
    // Updated by MFA after the zones were written: whole country until reviewed.
    page('pakistan', 'PK', 'nonEssential', '2026-11-01', 'regional'),
  ],
  history: [],
};

describe('advisoryAt', () => {
  it('places a destination inside or outside regional advice', () => {
    expect(advisoryAt(feed, zones, regions, geo, { cc: 'IN', lat: 34.08, lon: 74.8 }).level).toBe('nonEssential'); // Srinagar
    const delhi = advisoryAt(feed, zones, regions, geo, { cc: 'IN', lat: 28.61, lon: 77.21 });
    expect(delhi.level).toBe('none');
    expect(delhi.countryPage?.slug).toBe('india');
  });

  it('measures border bands and circles', () => {
    expect(advisoryAt(feed, zones, regions, geo, { cc: 'TH', lat: 14, lon: 103.3 }).level).toBe('all'); // ~32 km from the line
    expect(advisoryAt(feed, zones, regions, geo, { cc: 'TH', lat: 13.75, lon: 100.5 }).level).toBe('none'); // Bangkok
    expect(advisoryAt(feed, zones, regions, geo, { cc: 'ID', lat: -7.6, lon: 110.45 }).level).toBe('caution'); // ~6.6 km from Merapi
    expect(advisoryAt(feed, zones, regions, geo, { cc: 'ID', lat: -8.65, lon: 115.2 }).level).toBe('none'); // Bali
  });

  it('flags the whole country when the zones are older than the MFA page', () => {
    const a = advisoryAt(feed, zones, regions, geo, { cc: 'PK', lat: 24.86, lon: 67.0 }); // Karachi
    expect(a.level).toBe('nonEssential');
    expect(a.hits[0]).toMatchObject({ fallback: true, label: 'Parts of pakistan' });
  });

  it('measures distance to a line in km', () => {
    expect(distanceToLinesKm({ type: 'MultiLineString', coordinates: [[[103, 13], [103, 15]]] }, 103.5, 14)).toBeCloseTo(54, 0);
  });
});

const FWD: InsurerRules = {
  id: 'fwd',
  name: 'FWD',
  checked: '2026-10-21',
  excludedCountries: ['AF', 'IR'],
  excludedRegions: [{ label: 'Crimea and Sevastopol', codes: ['UA-43', 'UA-40'] }],
  mfa: { all: 'excluded', nonEssential: 'likely-excluded', caution: 'covered' },
  coveredIfIssuedAfterBooking: true,
  sources: [{ name: 'FWD', url: 'https://example.invalid' }],
};
const TODAY = '2026-10-21';
const cover = (p: { cc: string; lat: number; lon: number }, bookedOn: string | null = null, history = feed.history) =>
  coverageFor(FWD, advisoryAt(feed, zones, regions, geo, p), p, regions, geo, history, bookedOn, TODAY);
const RIYADH = { cc: 'SA', lat: 24.71, lon: 46.68 };
const SRINAGAR = { cc: 'IN', lat: 34.08, lon: 74.8 };

describe('FWD coverage', () => {
  it('excludes listed countries and regions whatever MFA says', () => {
    expect(cover({ cc: 'AF', lat: 34.5, lon: 69.2 }).status).toBe('not-covered');
    // Crimea is filed under Russia in Natural Earth; matching is by shape.
    expect(cover({ cc: 'RU', lat: 44.95, lon: 34.1 })).toMatchObject({ status: 'not-covered', detail: expect.stringContaining('Crimea') });
  });

  it('defer all travel: not covered; defer non-essential: likely not covered', () => {
    expect(cover(RIYADH)).toMatchObject({ status: 'not-covered', detail: expect.stringContaining('if you book today') });
    expect(cover(SRINAGAR)).toMatchObject({ status: 'likely-not-covered', detail: expect.stringContaining('Confirm with FWD') });
    expect(cover({ cc: 'ID', lat: -7.6, lon: 110.45 }).status).toBe('covered'); // caution only
    expect(cover({ cc: 'JP', lat: 35.68, lon: 139.69 }).status).toBe('covered');
  });

  it('applies the booking-date rule', () => {
    // Booked after MFA's page date: the advice was already in place.
    expect(cover(RIYADH, '2026-10-15').status).toBe('not-covered');
    // Booked before the page date, with no history: we can't tell when the advice started.
    expect(cover(RIYADH, '2026-09-01').status).toBe('maybe-covered');
    // Our own history saw no advisory after the booking date: it came later, so it's covered.
    const history = [
      { slug: 'saudi-arabia', level: 'none' as const, mfaDate: null, firstSeen: '2026-08-01', lastSeen: '2026-10-12' },
      { slug: 'saudi-arabia', level: 'all' as const, mfaDate: '2026-10-13', firstSeen: '2026-10-13', lastSeen: TODAY },
    ];
    expect(cover(RIYADH, '2026-09-01', history).status).toBe('covered');
    // A future booking date is treated as booking today.
    expect(cover(RIYADH, '2027-01-01').detail).toMatch(/if you book today/);
  });
});

describe('one-line reasons for the map popover', () => {
  it('takes the reason clause from MFA guidance, or the trimmed sentence', async () => {
    const { mfaReason, insurerReason } = await import('./advisory');
    expect(mfaReason({ guidance: ['In view of the continuing uncertain security situation in Myanmar, Singaporeans are strongly advised to defer all travel to Myanmar.'] })).toBe(
      'Continuing uncertain security situation in Myanmar',
    );
    expect(mfaReason({ guidance: ['Due to the ongoing Ebola disease outbreak in the Democratic Republic of the Congo (DRC), Singaporeans are advised to defer all non-essential travel to the DRC.'] })).toBe(
      'Ongoing Ebola disease outbreak in the Democratic Republic of the Congo (DRC)',
    );
    expect(mfaReason({ guidance: ['Singaporeans should defer non-essential travel to Haiti.'] })).toBe('Singaporeans should defer non-essential travel to Haiti.');
    expect(mfaReason({ guidance: [`${'Very long guidance '.repeat(20)}end.`] })!.length).toBeLessThanOrEqual(160);
    expect(mfaReason({ guidance: [] })).toBeNull();
    expect(insurerReason('MFA advises deferring all travel here, and FWD excludes places MFA advises against travelling to. That applies if you book today.', 'FWD')).toBe(
      'FWD excludes places MFA advises against travelling to.',
    );
    expect(insurerReason('MFA advises deferring non-essential travel here. FWD excludes places where MFA "recommends postponing" travel, which likely includes this. Confirm with FWD.', 'FWD')).toBe(
      'FWD excludes places where MFA "recommends postponing" travel, which likely includes this.',
    );
  });
});
