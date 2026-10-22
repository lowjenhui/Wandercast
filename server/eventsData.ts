// Curated recurring events that draw large crowds and push up flight and hotel prices.
//
// Dates are produced from rules, because most events move from year to year:
//   fixed       – same calendar dates every year
//   anchor      – tied to a public holiday in the destination's own calendar (e.g. Seollal)
//   nthWeekday  – e.g. "third Sunday of January"
//   fullMoon    – lunar festivals (computed astronomically, ±1 day)
//   oktoberfest – special rule (ends on the first Sunday of October, or 3 October)
// Every expanded date carries a `timing` label so the UI can say how certain it is.

export type EventRule =
  | { kind: 'fixed'; start: string; end: string } // MM-DD; end may be in the next year
  | { kind: 'anchor'; country: string; match: string; before?: number; after?: number }
  | { kind: 'nthWeekday'; month: number; weekday: number; n: number; before?: number; after?: number } // weekday 0 = Sunday; n = -1 for last
  | { kind: 'fullMoon'; months?: number[]; before?: number; after?: number }
  | { kind: 'oktoberfest' };

export interface EventDef {
  id: string;
  name: string;
  cc: string;
  place?: string;
  lat?: number;
  lon?: number;
  impact: 'high' | 'medium';
  category: 'festival' | 'music' | 'sport' | 'religious' | 'holiday-season' | 'nature' | 'closure';
  rule: EventRule;
  /** How firm the generated dates are. */
  timing: 'fixed' | 'holiday-linked' | 'typical' | 'astronomical';
  note: string;
  source: { name: string; url: string };
}

const wiki = (title: string, name = `Wikipedia: ${title.replace(/_/g, ' ')}`) => ({ name, url: `https://en.wikipedia.org/wiki/${title}` });

export const EVENTS: EventDef[] = [
  // Taiwan
  {
    id: 'tw-spring-scream', name: 'Spring Scream music festival (Kenting)', cc: 'TW', place: 'Kenting, Pingtung', lat: 21.95, lon: 120.79,
    impact: 'high', category: 'music', timing: 'typical',
    rule: { kind: 'anchor', country: 'TW', match: "Tomb Sweeping|Children's Day", before: 0, after: 0 },
    note: 'Outdoor music festival held over the early-April Tomb Sweeping / Children’s Day long weekend, alongside other Kenting beach music events. Kenting rooms and Kaohsiung transport sell out and prices jump. Exact dates are announced by the organisers each year.',
    source: wiki('Spring_Scream'),
  },
  {
    id: 'tw-lantern', name: 'Taiwan Lantern Festival', cc: 'TW', impact: 'medium', category: 'festival', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'TW', match: '^Lantern Festival', before: 0, after: 9 },
    note: 'Lantern shows that move to a different host city each year, plus Pingxi sky lanterns; crowds peak on the first weekend.',
    source: wiki('Taiwan_Lantern_Festival'),
  },
  // Thailand
  {
    id: 'th-songkran', name: 'Songkran (Thai New Year water festival)', cc: 'TH', impact: 'high', category: 'festival', timing: 'fixed',
    rule: { kind: 'fixed', start: '04-12', end: '04-16' },
    note: 'Nationwide water festival; Bangkok, Chiang Mai and Phuket are packed and domestic travel peaks. Book transport and rooms early.',
    source: wiki('Songkran_(Thailand)'),
  },
  {
    id: 'th-loy-krathong', name: 'Loy Krathong and Yi Peng lantern festival', cc: 'TH', place: 'Chiang Mai, Sukhothai, Bangkok', lat: 18.79, lon: 98.98,
    impact: 'high', category: 'festival', timing: 'astronomical',
    rule: { kind: 'fullMoon', months: [11], before: 1, after: 1 },
    note: 'Held on the full moon of the 12th Thai lunar month (usually November). Chiang Mai’s Yi Peng sky-lantern nights draw huge crowds and hotel prices spike.',
    source: wiki('Loy_Krathong'),
  },
  {
    id: 'th-full-moon-party', name: 'Full Moon Party (Koh Phangan)', cc: 'TH', place: 'Haad Rin, Koh Phangan', lat: 9.68, lon: 100.06,
    impact: 'medium', category: 'music', timing: 'astronomical',
    rule: { kind: 'fullMoon', before: 1, after: 1 },
    note: 'Monthly beach party around the full moon; Koh Phangan and Koh Samui ferries and rooms fill up.',
    source: wiki('Full_Moon_Party'),
  },
  // Japan
  {
    id: 'jp-golden-week', name: 'Golden Week', cc: 'JP', impact: 'high', category: 'holiday-season', timing: 'fixed',
    rule: { kind: 'fixed', start: '04-29', end: '05-05' },
    note: 'A cluster of national holidays and Japan’s busiest domestic travel week. Trains, flights and hotels are at peak prices.',
    source: wiki('Golden_Week_(Japan)'),
  },
  {
    id: 'jp-obon', name: 'Obon holidays', cc: 'JP', impact: 'high', category: 'holiday-season', timing: 'fixed',
    rule: { kind: 'fixed', start: '08-13', end: '08-16' },
    note: 'Mass travel to home towns; expressways and Shinkansen are very crowded.',
    source: wiki('Bon_Festival'),
  },
  {
    id: 'jp-new-year', name: 'Year-end and New Year holidays', cc: 'JP', impact: 'high', category: 'holiday-season', timing: 'fixed',
    rule: { kind: 'fixed', start: '12-28', end: '01-03' },
    note: 'Many businesses close; transport and resort prices peak.',
    source: wiki('Japanese_New_Year'),
  },
  {
    id: 'jp-hanami', name: 'Cherry blossom peak (Tokyo, Kyoto, Osaka)', cc: 'JP', impact: 'high', category: 'nature', timing: 'typical',
    rule: { kind: 'fixed', start: '03-24', end: '04-08' },
    note: 'Peak bloom shifts by about a week each year (check the JMA bloom forecast). Kyoto and Tokyo hotels are among the most expensive of the year.',
    source: wiki('Hanami'),
  },
  {
    id: 'jp-sapporo-snow', name: 'Sapporo Snow Festival', cc: 'JP', place: 'Sapporo', lat: 43.06, lon: 141.35, impact: 'high', category: 'festival', timing: 'typical',
    rule: { kind: 'fixed', start: '02-04', end: '02-11' },
    note: 'Around two million visitors over a week in early February; Sapporo hotels fill months ahead.',
    source: wiki('Sapporo_Snow_Festival'),
  },
  {
    id: 'jp-gion', name: 'Gion Matsuri (main processions)', cc: 'JP', place: 'Kyoto', lat: 35.01, lon: 135.77, impact: 'high', category: 'festival', timing: 'fixed',
    rule: { kind: 'fixed', start: '07-14', end: '07-17' },
    note: 'Peak evenings and the 17 July float procession; central Kyoto is extremely crowded.',
    source: wiki('Gion_Matsuri'),
  },
  // South Korea
  {
    id: 'kr-seollal', name: 'Seollal (Lunar New Year)', cc: 'KR', impact: 'high', category: 'holiday-season', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'KR', match: 'Seollal', before: 1, after: 0 },
    note: 'Nationwide travel to home towns; trains and domestic flights sell out and many shops close.',
    source: wiki('Seollal'),
  },
  {
    id: 'kr-chuseok', name: 'Chuseok (harvest festival)', cc: 'KR', impact: 'high', category: 'holiday-season', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'KR', match: 'Chuseok', before: 1, after: 0 },
    note: 'Korea’s biggest travel period of the year; Jeju and outbound flights are at peak prices.',
    source: wiki('Chuseok'),
  },
  {
    id: 'kr-biff', name: 'Busan International Film Festival', cc: 'KR', place: 'Busan', lat: 35.17, lon: 129.13, impact: 'medium', category: 'festival', timing: 'typical',
    rule: { kind: 'fixed', start: '10-01', end: '10-10' },
    note: 'Usually held in early October; Haeundae hotels are busy.',
    source: wiki('Busan_International_Film_Festival'),
  },
  // Indonesia
  {
    id: 'id-nyepi', name: 'Nyepi (Bali Day of Silence)', cc: 'ID', place: 'Bali', lat: -8.65, lon: 115.22, impact: 'high', category: 'closure', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'ID', match: 'Nyepi', before: 0, after: 0 },
    note: 'Bali shuts down for 24 hours: the airport closes, no one may leave their hotel, and lights stay off. Ogoh-ogoh parades the evening before draw crowds.',
    source: wiki('Nyepi'),
  },
  {
    id: 'id-lebaran', name: 'Lebaran / Idul Fitri exodus (mudik)', cc: 'ID', impact: 'high', category: 'holiday-season', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'ID', match: 'Idul Fitri', before: 3, after: 3 },
    note: 'Tens of millions travel home; domestic flights, trains and roads are overwhelmed and prices peak.',
    source: wiki('Mudik'),
  },
  // Malaysia
  {
    id: 'my-hari-raya', name: 'Hari Raya Aidilfitri travel peak (balik kampung)', cc: 'MY', impact: 'high', category: 'holiday-season', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'MY', match: 'Hari Raya Puasa', before: 2, after: 2 },
    note: 'Highways jam and domestic and Singapore–Malaysia fares rise; many businesses close for several days.',
    source: wiki('Eid_al-Fitr'),
  },
  // Vietnam
  {
    id: 'vn-tet', name: 'Tết (Lunar New Year)', cc: 'VN', impact: 'high', category: 'holiday-season', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'VN', match: '^Tet', before: 2, after: 2 },
    note: 'Vietnam’s biggest holiday: many shops and restaurants close for a week, and domestic transport is sold out at peak prices.',
    source: wiki('T%E1%BA%BFt', 'Wikipedia: Tết'),
  },
  {
    id: 'vn-hoian-lantern', name: 'Hội An full-moon lantern night', cc: 'VN', place: 'Hội An', lat: 15.88, lon: 108.33, impact: 'medium', category: 'festival', timing: 'astronomical',
    rule: { kind: 'fullMoon', before: 0, after: 0 },
    note: 'Monthly on the 14th day of the lunar month; the Old Town is lit by lanterns and very busy.',
    source: wiki('H%E1%BB%99i_An', 'Wikipedia: Hội An'),
  },
  // Philippines
  {
    id: 'ph-sinulog', name: 'Sinulog Festival', cc: 'PH', place: 'Cebu City', lat: 10.32, lon: 123.89, impact: 'high', category: 'festival', timing: 'fixed',
    rule: { kind: 'nthWeekday', month: 1, weekday: 0, n: 3, before: 2, after: 0 },
    note: 'Held on the third Sunday of January; one of Asia’s largest street festivals, with Cebu hotels booked out.',
    source: wiki('Sinulog'),
  },
  {
    id: 'ph-ati-atihan', name: 'Ati-Atihan Festival', cc: 'PH', place: 'Kalibo, Aklan (near Boracay)', lat: 11.71, lon: 122.36, impact: 'medium', category: 'festival', timing: 'fixed',
    rule: { kind: 'nthWeekday', month: 1, weekday: 0, n: 3, before: 2, after: 0 },
    note: 'Held on the third Sunday of January in Kalibo; flights into Kalibo and Caticlan for Boracay fill up.',
    source: wiki('Ati-Atihan_Festival'),
  },
  {
    id: 'ph-holy-week', name: 'Holy Week (Semana Santa)', cc: 'PH', impact: 'high', category: 'religious', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'PH', match: 'Maundy Thursday|Good Friday', before: 1, after: 2 },
    note: 'A national holiday period with mass domestic travel; beach destinations such as Boracay and Palawan are at peak prices.',
    source: wiki('Holy_Week_in_the_Philippines'),
  },
  // India & Nepal
  {
    id: 'in-diwali', name: 'Diwali', cc: 'IN', impact: 'high', category: 'religious', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'IN', match: 'Diwali', before: 2, after: 2 },
    note: 'India’s biggest festival; trains and flights are heavily booked around it.',
    source: wiki('Diwali'),
  },
  {
    id: 'in-holi', name: 'Holi', cc: 'IN', impact: 'medium', category: 'festival', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'IN', match: '^Holi$', before: 1, after: 0 },
    note: 'Festival of colours; Mathura, Vrindavan and Jaipur are especially crowded.',
    source: wiki('Holi'),
  },
  {
    id: 'np-dashain', name: 'Dashain festival', cc: 'NP', impact: 'high', category: 'religious', timing: 'holiday-linked',
    rule: { kind: 'anchor', country: 'NP', match: 'Dashain|Ghatasthapana', before: 0, after: 1 },
    note: 'Nepal’s longest festival; buses and domestic flights sell out and many services pause.',
    source: wiki('Dashain'),
  },
  // Australia
  {
    id: 'au-open', name: 'Australian Open (tennis)', cc: 'AU', place: 'Melbourne', lat: -37.82, lon: 144.98, impact: 'high', category: 'sport', timing: 'typical',
    rule: { kind: 'fixed', start: '01-12', end: '02-01' },
    note: 'Usually the last two weeks of January; Melbourne hotel prices rise sharply.',
    source: wiki('Australian_Open'),
  },
  {
    id: 'au-melbourne-cup', name: 'Melbourne Cup carnival', cc: 'AU', place: 'Melbourne', lat: -37.79, lon: 144.91, impact: 'high', category: 'sport', timing: 'fixed',
    rule: { kind: 'nthWeekday', month: 11, weekday: 2, n: 1, before: 3, after: 0 },
    note: 'Cup day is the first Tuesday of November (a Melbourne public holiday). Hotels peak over the long weekend.',
    source: wiki('Melbourne_Cup'),
  },
  {
    id: 'au-vivid', name: 'Vivid Sydney', cc: 'AU', place: 'Sydney', lat: -33.86, lon: 151.21, impact: 'medium', category: 'festival', timing: 'typical',
    rule: { kind: 'fixed', start: '05-23', end: '06-14' },
    note: 'Light, music and ideas festival from late May to mid-June; weekends around the harbour are very busy.',
    source: wiki('Vivid_Sydney'),
  },
  {
    id: 'au-sydney-nye', name: 'Sydney New Year’s Eve fireworks', cc: 'AU', place: 'Sydney', lat: -33.86, lon: 151.21, impact: 'high', category: 'festival', timing: 'fixed',
    rule: { kind: 'fixed', start: '12-30', end: '01-01' },
    note: 'One of the world’s largest NYE events; harbour-view hotels are at their highest prices of the year.',
    source: wiki('Sydney_New_Year%27s_Eve', 'Wikipedia: Sydney New Year’s Eve'),
  },
  // UAE
  {
    id: 'ae-dsf', name: 'Dubai Shopping Festival', cc: 'AE', place: 'Dubai', lat: 25.2, lon: 55.27, impact: 'medium', category: 'festival', timing: 'typical',
    rule: { kind: 'fixed', start: '12-06', end: '01-18' },
    note: 'Runs from about mid-December to mid-January, the peak of Dubai’s winter high season.',
    source: wiki('Dubai_Shopping_Festival'),
  },
  // Europe
  {
    id: 'de-oktoberfest', name: 'Oktoberfest', cc: 'DE', place: 'Munich', lat: 48.13, lon: 11.55, impact: 'high', category: 'festival', timing: 'fixed',
    rule: { kind: 'oktoberfest' },
    note: 'About six million visitors; Munich hotel prices can triple, especially at weekends.',
    source: wiki('Oktoberfest'),
  },
  {
    id: 'gb-wimbledon', name: 'Wimbledon Championships', cc: 'GB', place: 'London', lat: 51.43, lon: -0.21, impact: 'medium', category: 'sport', timing: 'typical',
    rule: { kind: 'fixed', start: '06-29', end: '07-12' },
    note: 'Usually starts on the last Monday of June or first of July and runs for two weeks.',
    source: wiki('Wimbledon_Championships'),
  },
  {
    id: 'gb-notting-hill', name: 'Notting Hill Carnival', cc: 'GB', place: 'London', lat: 51.51, lon: -0.2, impact: 'medium', category: 'festival', timing: 'fixed',
    rule: { kind: 'nthWeekday', month: 8, weekday: 1, n: -1, before: 1, after: 0 },
    note: 'Held over the August bank holiday weekend (Sunday and Monday); west London is extremely busy.',
    source: wiki('Notting_Hill_Carnival'),
  },
  {
    id: 'gb-fringe', name: 'Edinburgh Festival Fringe', cc: 'GB', place: 'Edinburgh', lat: 55.95, lon: -3.19, impact: 'high', category: 'festival', timing: 'typical',
    rule: { kind: 'fixed', start: '08-01', end: '08-25' },
    note: 'The world’s largest arts festival, through most of August; Edinburgh accommodation prices peak.',
    source: wiki('Edinburgh_Festival_Fringe'),
  },
  {
    id: 'es-tomatina', name: 'La Tomatina', cc: 'ES', place: 'Buñol (Valencia)', lat: 39.42, lon: -0.79, impact: 'medium', category: 'festival', timing: 'fixed',
    rule: { kind: 'nthWeekday', month: 8, weekday: 3, n: -1, before: 0, after: 0 },
    note: 'Held on the last Wednesday of August; Valencia-area rooms are busy.',
    source: wiki('La_Tomatina'),
  },
  // United States
  {
    id: 'us-thanksgiving', name: 'Thanksgiving travel peak', cc: 'US', impact: 'high', category: 'holiday-season', timing: 'fixed',
    rule: { kind: 'nthWeekday', month: 11, weekday: 4, n: 4, before: 2, after: 3 },
    note: 'The busiest US travel period of the year; domestic airfares and New York hotels (Macy’s parade) peak.',
    source: wiki('Thanksgiving_(United_States)'),
  },
];
