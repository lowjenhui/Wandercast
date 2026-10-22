import { describe, expect, it } from 'vitest';
import { baggageFor, CHECKED_KG } from '../data/airlineBaggage';
import type { FareObservation, LiveLeg } from '../types';
import {
  cheapestLiveTotal,
  DEFAULT_FLIGHT_RULES as R,
  flexSuggestions,
  hoursAtDestination,
  isRedEye,
  isWorkday,
  normaliseRules,
  rankLegs,
} from './flightRules';

/** A leg from "YYYY-MM-DD HH:MM" times; layovers as [airport, minutes] between segments. */
function leg(
  price: number,
  segs: [from: string, to: string, dep: string, arr: string, minutes: number, flight: string][],
  layovers: [airport: string, minutes: number, overnight?: boolean, country?: string][] = [],
  googleBest = false,
): LiveLeg {
  return {
    priceSgd: price,
    airlines: ['Test'],
    stops: segs.length - 1,
    totalMinutes: segs.reduce((a, s) => a + s[4], 0) + layovers.reduce((a, l) => a + l[1], 0),
    departTime: segs[0][2],
    arriveTime: segs[segs.length - 1][3],
    flightNumbers: segs.map((s) => s[5]),
    route: [segs[0][0], ...segs.map((s) => s[1])],
    segments: segs.map(([from, to, departTime, arriveTime, minutes, flightNumber]) => ({ from, to, departTime, arriveTime, minutes, flightNumber })),
    layovers: layovers.map(([airport, minutes, overnight, country]) => ({ airport, minutes, overnight: Boolean(overnight), country })),
    googleBest,
  };
}
const ctx = (date: string, workday: boolean, tripDays = 5, japan = false, longHaul = false, priceRef?: LiveLeg[]) => ({ date, workday, tripDays, japan, longHaul, priceRef });

describe('flight rules', () => {
  it('knows workdays, skipping weekends and Singapore public holidays', () => {
    expect(isWorkday('2026-12-04', new Set())).toBe(true); // Friday
    expect(isWorkday('2026-12-05', new Set())).toBe(false); // Saturday
    expect(isWorkday('2026-12-25', new Set(['2026-12-25']))).toBe(false); // Christmas, a Friday
  });

  it('prefers after-work departures on a workday, then early arrivals, then daytime', () => {
    const evening = leg(300, [['SIN', 'BKK', '2026-12-04 19:40', '2026-12-04 21:15', 155, 'TR 620']]);
    const early = leg(250, [['SIN', 'BKK', '2026-12-04 06:00', '2026-12-04 07:25', 145, 'FD 352']]);
    const midday = leg(200, [['SIN', 'BKK', '2026-12-04 12:20', '2026-12-04 13:55', 155, 'SL 101']]);
    const ranked = rankLegs([midday, early, evening], 'outbound', ctx('2026-12-04', true), R);
    expect(ranked.map((r) => r.label)).toEqual(['After work', 'Early arrival · needs leave', 'Daytime · needs leave']);
  });

  it('lets price decide between flights landing within about 2 hours of each other', () => {
    const thai = leg(407, [['SIN', 'BKK', '2026-12-04 19:15', '2026-12-04 20:35', 140, 'TG 408']]);
    const scoot = leg(226, [['SIN', 'BKK', '2026-12-04 19:40', '2026-12-04 21:15', 155, 'TR 620']]);
    const late = leg(150, [['SIN', 'BKK', '2026-12-04 21:40', '2026-12-04 23:15', 155, 'SL 105']]);
    expect(rankLegs([thai, late, scoot], 'outbound', ctx('2026-12-04', true), R).map((r) => r.leg.priceSgd)).toEqual([226, 407, 150]);
  });

  it('ranks by earlier arrival on a weekend, early arrivals first', () => {
    const early = leg(280, [['SIN', 'BKK', '2026-12-05 06:00', '2026-12-05 07:25', 145, 'FD 352']]);
    const late = leg(150, [['SIN', 'BKK', '2026-12-05 17:00', '2026-12-05 18:30', 150, 'TR 636']]);
    const ranked = rankLegs([late, early], 'outbound', ctx('2026-12-05', false), R);
    expect(ranked[0]).toMatchObject({ label: 'Early arrival', tier: 0 });
    expect(ranked[1].label).toBe('Lands 18:30');
  });

  it('keeps only returns that land on the end date, and on a workday they must land by 06:00', () => {
    const redEye = leg(200, [['BKK', 'SIN', '2026-12-07 23:50', '2026-12-08 03:15', 145, 'TR 615']]);
    const morning = leg(150, [['BKK', 'SIN', '2026-12-08 08:00', '2026-12-08 11:25', 145, 'SL 102']]);
    const dayBefore = leg(100, [['BKK', 'SIN', '2026-12-07 10:00', '2026-12-07 13:25', 145, 'FD 351']]);
    const ranked = rankLegs([morning, dayBefore, redEye], 'return', ctx('2026-12-08', true), R);
    expect(ranked.map((r) => r.label)).toEqual(['Back before work', 'Lands 11:25 · needs leave']);
  });

  it('prefers after-dinner returns when landing on a non-workday', () => {
    const late = leg(200, [['BKK', 'SIN', '2026-12-05 22:30', '2026-12-06 01:55', 145, 'TR 617']]);
    const day = leg(150, [['BKK', 'SIN', '2026-12-06 13:00', '2026-12-06 16:25', 145, 'TR 611']]);
    expect(rankLegs([day, late], 'return', ctx('2026-12-06', false), R).map((r) => r.label)).toEqual(['After dinner', 'Leaves 13:00']);
  });

  it('flags red-eyes by time in the air 01:00–05:00, departure-city time', () => {
    expect(isRedEye(leg(1, [['NRT', 'SIN', '2026-12-07 23:55', '2026-12-08 05:50', 415, 'NH 801']]))).toBe(true);
    expect(isRedEye(leg(1, [['BKK', 'SIN', '2026-12-07 22:30', '2026-12-08 01:50', 140, 'TR 617']]))).toBe(false);
  });

  it('hides long layovers, and connections on short trips unless 20% cheaper than non-stop', () => {
    const nonstop = leg(300, [['SIN', 'BKK', '2026-12-04 19:00', '2026-12-04 20:30', 150, 'TR 1']]);
    const longLayover = leg(150, [['SIN', 'KUL', '2026-12-04 18:30', '2026-12-04 19:30', 60, 'AK 1'], ['KUL', 'BKK', '2026-12-04 23:30', '2026-12-05 00:40', 130, 'AK 2']], [['KUL', 240]]);
    const pricey = leg(280, [['SIN', 'KUL', '2026-12-04 18:30', '2026-12-04 19:30', 60, 'AK 3'], ['KUL', 'BKK', '2026-12-04 21:00', '2026-12-04 22:10', 130, 'AK 4']], [['KUL', 90]]);
    const cheap = leg(200, [['SIN', 'KUL', '2026-12-04 18:30', '2026-12-04 19:30', 60, 'AK 5'], ['KUL', 'BKK', '2026-12-04 21:00', '2026-12-04 22:10', 130, 'AK 6']], [['KUL', 90]]);
    const ranked = rankLegs([longLayover, pricey, cheap, nonstop], 'outbound', ctx('2026-12-04', true, 3), R);
    expect(ranked.filter((r) => !r.hidden).map((r) => r.leg.priceSgd)).toEqual([300, 200]);
    expect(ranked.find((r) => r.leg === cheap)?.deprioritised).toMatch(/after non-stop/);
    expect(ranked.find((r) => r.leg === longLayover)?.hidden).toMatch(/4 h layover in KUL is too long/);
    expect(ranked.find((r) => r.leg === pricey)?.hidden).toMatch(/Non-stop preferred/);
  });

  it('ranks a short, well-priced connection to Japan with non-stop', () => {
    const nonstop = leg(700, [['SIN', 'NRT', '2026-12-04 22:00', '2026-12-05 06:00', 420, 'SQ 12']]);
    const viaTaipei = leg(520, [['SIN', 'TPE', '2026-12-04 19:00', '2026-12-04 23:35', 275, 'CI 754'], ['TPE', 'NRT', '2026-12-05 01:00', '2026-12-05 05:10', 190, 'CI 100']], [['TPE', 85]]);
    const ranked = rankLegs([nonstop, viaTaipei], 'outbound', ctx('2026-12-04', true, 3, true), R);
    expect(ranked.every((r) => !r.hidden && !r.deprioritised)).toBe(true);
  });

  it('measures hours at the destination and the cheapest total landing on the end date', () => {
    const out = leg(300, [['SIN', 'BKK', '2026-12-04 19:40', '2026-12-04 21:15', 155, 'TR 620']]);
    const back = leg(200, [['BKK', 'SIN', '2026-12-07 23:50', '2026-12-08 03:15', 145, 'TR 615']]);
    const dayBefore = leg(50, [['BKK', 'SIN', '2026-12-07 10:00', '2026-12-07 13:25', 145, 'FD 351']]);
    expect(hoursAtDestination(out, back)).toBeCloseTo(74.58, 1);
    expect(cheapestLiveTotal([out], [back, dayBefore], '2026-12-04', '2026-12-08')).toBe(500);
  });

  it('suggests ±1 day dates only when significantly cheaper', () => {
    const o = (departDate: string, returnDate: string, priceSgd: number): FareObservation => ({ priceSgd, departDate, returnDate, origin: 'SIN', destination: 'BKK' });
    const obs = [o('2026-12-03', '2026-12-08', 300), o('2026-12-05', '2026-12-09', 380), o('2026-12-02', '2026-12-08', 100), o('2026-12-04', '2026-12-08', 200)];
    expect(flexSuggestions(obs, '2026-12-04', '2026-12-08', 400, R)).toEqual([{ departDate: '2026-12-03', returnDate: '2026-12-08', priceSgd: 300, savings: 100, source: 'cached' }]);
    expect(flexSuggestions(obs, '2026-12-04', '2026-12-08', null, R)).toEqual([]);
  });

  it('leaves out connections through the Middle East unless switched off', () => {
    const viaDubai = leg(900, [['SIN', 'DXB', '2026-12-04 19:00', '2026-12-04 22:30', 450, 'EK 405'], ['DXB', 'LHR', '2026-12-05 00:30', '2026-12-05 04:40', 490, 'EK 1']], [['DXB', 120, false, 'AE']]);
    const viaIstanbul = leg(850, [['SIN', 'IST', '2026-12-04 21:00', '2026-12-05 04:00', 660, 'TK 55'], ['IST', 'LHR', '2026-12-05 06:00', '2026-12-05 08:00', 240, 'TK 1']], [['IST', 120, false, 'TR']]);
    const ranked = rankLegs([viaDubai, viaIstanbul], 'outbound', ctx('2026-12-04', true), R);
    expect(ranked.find((r) => r.leg === viaDubai)?.hidden).toBe('Connects in DXB (Middle East)');
    expect(ranked.find((r) => r.leg === viaIstanbul)?.hidden).toBeUndefined(); // Turkey isn't counted
    expect(rankLegs([viaDubai], 'outbound', ctx('2026-12-04', true), { ...R, avoidMiddleEast: false })[0].hidden).toBeUndefined();
  });

  it('on long-haul keeps non-stop first unless very expensive, then ranks it after connections', () => {
    const nonstop = leg(1500, [['SIN', 'LHR', '2026-12-04 23:00', '2026-12-05 06:00', 840, 'SQ 322']]);
    const viaHkg = leg(900, [['SIN', 'HKG', '2026-12-04 19:00', '2026-12-04 23:00', 240, 'CX 1'], ['HKG', 'LHR', '2026-12-05 00:30', '2026-12-05 06:30', 690, 'CX 2']], [['HKG', 90]]);
    const lh = ctx('2026-12-04', true, 8, false, true);
    const pricey = rankLegs([nonstop, viaHkg], 'outbound', lh, R);
    expect(pricey.map((r) => r.leg)).toEqual([viaHkg, nonstop]);
    expect(pricey[1].deprioritised).toMatch(/Non-stop costs about S\$600 more/);
    const fair = rankLegs([{ ...nonstop, priceSgd: 1000 }, viaHkg], 'outbound', lh, R);
    expect(fair[0].leg.stops).toBe(0);
    expect(fair[1].deprioritised).toMatch(/non-stop preferred on long-haul/);
  });

  it('judges the long-haul non-stop with return-ticket prices when there are any', () => {
    const nonstop = leg(1500, [['SIN', 'LHR', '2026-12-04 23:00', '2026-12-05 06:00', 840, 'SQ 322']]);
    const viaHkg = leg(900, [['SIN', 'HKG', '2026-12-04 19:00', '2026-12-04 23:00', 240, 'CX 1'], ['HKG', 'LHR', '2026-12-05 00:30', '2026-12-05 06:30', 690, 'CX 2']], [['HKG', 90]]);
    const rt = [{ ...nonstop, priceSgd: 1300 }, { ...viaHkg, priceSgd: 1150 }]; // return tickets: non-stop only 150 more
    expect(rankLegs([nonstop, viaHkg], 'outbound', ctx('2026-12-04', true, 8, false, true, rt), R)[0].leg).toBe(nonstop);
  });

  it("keeps Google's top long-haul connections whatever their layovers", () => {
    const fast = leg(1400, [['SIN', 'LHR', '2026-12-04 23:00', '2026-12-05 06:00', 840, 'SQ 322']]);
    const longStop = leg(1100, [['SIN', 'HKG', '2026-12-04 18:30', '2026-12-04 22:30', 240, 'CX 1'], ['HKG', 'LHR', '2026-12-05 02:00', '2026-12-05 07:00', 780, 'CX 2']], [['HKG', 210]], true);
    const r = rankLegs([fast, longStop], 'outbound', ctx('2026-12-04', true, 8, false, true), R).find((x) => x.leg === longStop)!;
    expect(r.hidden).toBeUndefined();
    expect(r.note).toBe('Google pick');
  });

  it('ranks long-haul returns landing on a workday by the latest departure', () => {
    const early = leg(800, [['LHR', 'SIN', '2026-12-06 11:00', '2026-12-07 07:30', 810, 'SQ 317']]);
    const late = leg(800, [['LHR', 'SIN', '2026-12-06 21:00', '2026-12-07 17:30', 810, 'SQ 319']]);
    const ranked = rankLegs([early, late], 'return', ctx('2026-12-07', true, 4, false, true), R);
    expect(ranked.map((r) => r.label)).toEqual(['Lands 17:30 · plan a leave day', 'Lands 07:30 · plan a leave day']);
  });

  it('falls back to the default for invalid settings', () => {
    expect(normaliseRules({ eveningDepartFrom: '25:00', shortTripDays: 3, layoverMaxMinutes: -5 })).toMatchObject({ eveningDepartFrom: '18:00', shortTripDays: 3, layoverMaxMinutes: 150 });
    expect(normaliseRules({ avoidMiddleEast: false }).avoidMiddleEast).toBe(false);
    expect(normaliseRules({ avoidMiddleEast: 'no' as unknown as boolean }).avoidMiddleEast).toBe(true);
  });
});

describe('baggage labels', () => {
  it('labels low-cost fees, included allowances and unknown airlines', () => {
    expect(baggageFor(['TR 620'], ['Scoot'], 155)).toEqual([expect.objectContaining({ airline: 'Scoot', carryOn: 'Carry-on 10 kg', checked: `Checked ${CHECKED_KG} kg ≈ S$35 each way` })]);
    expect(baggageFor(['SQ 12'], ['Singapore Airlines'], 420)[0].checked).toBe('Checked 25 kg included');
    expect(baggageFor(['XX 1'], ['Mystery Air'], 400)[0]).toMatchObject({ known: false, carryOn: 'Carry-on ~7 kg (typical)' });
    expect(baggageFor(['CI 754', 'CI 100'], ['China Airlines'], 550)).toHaveLength(1);
  });
});
