// World regions for grouping places in the weather library, with Southeast Asia split from the
// rest of Asia (the way trips from Singapore are usually thought of). By ISO 3166-1 alpha-2 code.

export type Region = 'Southeast Asia' | 'East Asia' | 'South Asia' | 'Central Asia' | 'Middle East' | 'Oceania' | 'Europe' | 'Africa' | 'Americas';

export const REGIONS: { name: Region; icon: string }[] = [
  { name: 'Southeast Asia', icon: '🌴' },
  { name: 'East Asia', icon: '🏯' },
  { name: 'South Asia', icon: '🪷' },
  { name: 'Central Asia', icon: '🐫' },
  { name: 'Middle East', icon: '🕌' },
  { name: 'Oceania', icon: '🦘' },
  { name: 'Europe', icon: '🏰' },
  { name: 'Africa', icon: '🦁' },
  { name: 'Americas', icon: '🗽' },
];

const CODES: Record<Region, string> = {
  'Southeast Asia': 'SG MY ID TH VN PH KH LA MM BN TL',
  'East Asia': 'CN JP KR KP TW HK MO MN',
  'South Asia': 'IN LK MV NP BT BD PK AF',
  'Central Asia': 'KZ UZ KG TJ TM',
  'Middle East': 'AE QA OM SA BH KW JO IL PS LB SY IQ IR YE TR GE AM AZ CY',
  Oceania: 'AU NZ FJ PG NC PF VU WS TO SB KI FM MH NR PW TV CK NU WF GU MP AS',
  Europe:
    'GB IE FR DE IT ES PT NL BE LU CH AT LI MC AD SM VA MT GR DK SE NO FI IS EE LV LT PL CZ SK HU SI HR BA RS ME MK AL XK RO BG MD UA BY RU GI FO GL',
  Africa:
    'ZA EG MA DZ TN LY SD SS ET ER DJ SO KE UG TZ RW BI MW MZ ZM ZW BW NA LS SZ AO CD CG GA CM CF TD NE NG BJ TG GH CI LR SL GN GW SN GM ML MR BF CV ST GQ MG MU SC KM RE YT',
  Americas:
    'US CA MX GT BZ SV HN NI CR PA CU JM HT DO PR BS BB TT AG DM LC VC GD KN AW CW BQ SX KY TC VG VI BM CO VE GY SR GF EC PE BO BR PY UY AR CL FK',
};

const BY_CC = new Map<string, Region>(Object.entries(CODES).flatMap(([r, codes]) => codes.split(' ').map((cc) => [cc, r as Region] as const)));

/** The region for a country code, or null for unknown codes (places named by coordinates). */
export const regionOf = (cc: string): Region | null => BY_CC.get(cc.toUpperCase()) ?? null;

/** The flag emoji for a country code ("" when the code isn't two letters). */
export function flagOf(cc: string): string {
  return /^[A-Za-z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
}
