import { describe, expect, it } from 'vitest';
import { alertFields, alertsAt, matchCities, sentences, parseEmbassyFeed, parseFcdoIndex, type CityRef, type TravelAlert } from './alerts';

const CITIES: CityRef[] = [
  { name: 'Paris', cc: 'FR', lat: 48.857, lon: 2.352 },
  { name: 'Lille', cc: 'FR', lat: 50.633, lon: 3.059 },
  { name: 'Nice', cc: 'FR', lat: 43.703, lon: 7.266 },
  { name: 'Bangkok', cc: 'TH', lat: 13.754, lon: 100.501 },
  { name: 'Delhi', cc: 'IN', lat: 28.652, lon: 77.231 },
  { name: 'New Delhi', cc: 'IN', lat: 28.614, lon: 77.209 },
  { name: 'Mumbai', cc: 'IN', lat: 19.076, lon: 72.878 },
];

const item = (title: string, body: string, date = 'Mon, 19 Oct 2026 18:23:23 +0000', link = `https://x.usembassy.gov/${encodeURIComponent(title)}/`) => `
  <item>
    <title>${title}</title>
    <link>${link}</link>
    <pubDate>${date}</pubDate>
    <content:encoded><![CDATA[<p>${body}</p>]]></content:encoded>
  </item>`;

describe('alertFields', () => {
  it('reads the Location line and the Event text up to the next section', () => {
    const f = alertFields('Demonstration Alert Location : Near the U.S. Embassy, Bangkok, Thailand Event : Demonstrations are expected. Actions to Take: Avoid the area.');
    expect(f.location).toBe('Near the U.S. Embassy, Bangkok, Thailand');
    expect(f.event).toBe('Demonstrations are expected.');
  });
});

describe('matchCities', () => {
  it("ignores the embassy's own city and finds the cities the event names", () => {
    const t = 'Security Alert: U.S. Embassy Paris, France – October 19 curfews in several cities across France, including Lille.';
    expect(matchCities(t, 'FR', CITIES).map((c) => c.name)).toEqual(['Lille']);
  });
  it('treats countrywide alerts as country-level', () => {
    expect(matchCities('Thailand, countrywide', 'TH', CITIES)).toEqual([]);
  });
  it("doesn't match lower-case words or other countries' cities", () => {
    expect(matchCities('It was a nice day in Bangkok', 'FR', CITIES)).toEqual([]);
  });
  it('in event text, needs a place word before the city', () => {
    const t = 'Check your flight: Bangkok: https://example.com. Protests took place in central Bangkok.';
    expect(matchCities('Check your flight: Bangkok: https://example.com', 'TH', CITIES, true)).toEqual([]);
    expect(matchCities(t, 'TH', CITIES, true).map((c) => c.name)).toEqual(['Bangkok']);
  });
  it('keeps one name where a longer one contains it nearby', () => {
    expect(matchCities('Large crowds in Central New Delhi', 'IN', CITIES).map((c) => c.name)).toEqual(['New Delhi']);
  });
});

describe('sentences', () => {
  it("doesn't split after U.S. or a.m.", () => {
    expect(sentences('The U.S. Embassy advises caution. Marches start at 9:30 a.m. Avoid the area.')).toEqual([
      'The U.S. Embassy advises caution.',
      'Marches start at 9:30 a.m. Avoid the area.',
    ]);
  });
});

describe('parseEmbassyFeed', () => {
  const xml = `<rss><channel>
    ${item('Security Alert: U.S. Embassy Paris, France &#8211; October 19, 2026', 'Event: Following the protests that turned violent, partial curfews apply in Lille. More curfews may follow for parts of Paris. Recommendations Avoid the areas.')}
    ${item('Routine Message: Consular Outreach &#8211; Bordeaux', 'Passport services.')}
    ${item('Demonstration Alert: U.S. Embassy Paris, France &#8211; October 17, 2026', 'Event: Protests are scheduled across France. Anticipated Impacts Roads: delays.', 'Fri, 16 Oct 2026 13:21:37 +0000')}
    ${item('Security Alert: Worldwide Caution', 'Location: Worldwide Event: Heightened tensions.')}
    ${item('Security Alert: U.S. Mission France', 'Location: France, countrywide Event: Airports in Paris and Nice have delays.')}
    ${item('Demonstration Alert: Protest in Paris', 'Location: Paris, France Event(s): A march is taking place TODAY. U.S. citizens should avoid it.')}
  </channel></rss>`;
  const alerts = parseEmbassyFeed(xml, 'FR', CITIES);

  it('keeps alerts and skips routine messages and the worldwide caution', () => {
    expect(alerts.map((a) => a.kind)).toEqual(['security', 'demonstration', 'security', 'demonstration']);
  });
  it('matches the cities named in the event, and summarises it', () => {
    expect(alerts[0].places.map((p) => p.name)).toEqual(['Paris', 'Lille']);
    expect(alerts[0].summary).toMatch(/^Following the protests that turned violent/);
    expect(alerts[0].issued).toBe('2026-10-19T18:23:23.000Z');
  });
  it('leaves country-wide alerts without places', () => {
    expect(alerts[1].places).toEqual([]);
    expect(alerts[2].places).toEqual([]);
  });
  it('reads "Event(s):" and matches the Location line', () => {
    expect(alerts[3].places.map((p) => p.name)).toEqual(['Paris']);
    expect(alerts[3].summary).toBe('A march is taking place TODAY. U.S. citizens should avoid it.');
  });
});

describe('parseFcdoIndex', () => {
  const idx = {
    links: {
      children: [
        { public_updated_at: '2026-10-19T17:40:21Z', web_url: 'https://www.gov.uk/foreign-travel-advice/france', details: { change_description: 'Updated information on local curfews (‘Warnings and insurance’ page)', country: { name: 'France', slug: 'france' } } },
        { public_updated_at: '2026-10-12T09:20:34Z', details: { change_description: 'Updated information about visa requirements', country: { name: 'Thailand', slug: 'thailand' } } },
        { public_updated_at: '2026-10-07T10:56:27Z', details: { change_description: 'Reviewed for accuracy, including the India-Pakistan border area (‘Safety and security’ page).', country: { name: 'India', slug: 'india' } } },
      ],
    },
  };
  const ccOf = (n: string) => ({ France: 'FR', Thailand: 'TH', India: 'IN' })[n] ?? null;

  it('keeps only unrest or security updates', () => {
    const out = parseFcdoIndex(idx, ccOf);
    expect(out.map((a) => a.cc)).toEqual(['FR']);
    expect(out[0]).toMatchObject({ source: 'fcdo', kind: 'update', places: [] });
  });
  it('limits to wanted countries', () => {
    expect(parseFcdoIndex(idx, ccOf, new Set(['TH']))).toEqual([]);
  });
});

describe('alertsAt', () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  const base = { source: 'us-embassy', kind: 'security', title: '', summary: '', url: '' } as const;
  const alerts: TravelAlert[] = [
    { ...base, id: 'a', cc: 'FR', issued: '2026-10-19T18:00:00Z', places: [{ name: 'Paris', lat: 48.857, lon: 2.352 }] },
    { ...base, id: 'b', cc: 'FR', issued: '2026-10-16T13:00:00Z', places: [] },
    { ...base, id: 'c', cc: 'FR', issued: '2026-09-30T00:00:00Z', places: [] },
    { ...base, id: 'd', cc: 'FR', issued: '2026-10-18T00:00:00Z', places: [{ name: 'Nice', lat: 43.703, lon: 7.266 }] },
  ];

  it('matches cities within 50 km, keeps country-level ones, and drops those over 14 days old', () => {
    const versailles = { cc: 'FR', lat: 48.805, lon: 2.12 };
    const r = alertsAt(alerts, versailles, now);
    expect(r.near.map((a) => a.id)).toEqual(['a']);
    expect(r.country.map((a) => a.id)).toEqual(['b']);
  });
  it('keeps only the newest of alerts re-issued with the same text', () => {
    const again = [...alerts, { ...alerts[1], id: 'b2', issued: '2026-10-17T00:00:00Z' }];
    expect(alertsAt(again, { cc: 'FR', lat: 45.764, lon: 4.835 }, now).country.map((a) => a.id)).toEqual(['b2']);
  });
  it("doesn't show another city's alert as country-level", () => {
    expect(alertsAt(alerts, { cc: 'FR', lat: 45.764, lon: 4.835 }, now).country.map((a) => a.id)).toEqual(['b']);
  });
});
