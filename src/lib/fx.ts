// Singapore dollar exchange rates, as the page subtitles show them.

export interface FxRate {
  /** ISO 3166-1 alpha-2 country code. */
  cc: string;
  /** ISO 4217 currency code, e.g. "THB". */
  code: string;
  /** e.g. "฿"; a bare "$" or a missing symbol falls back to the code. */
  symbol: string | null;
  /** Units of this currency for S$1. */
  perSgd: number;
}

export interface FxResponse {
  /** The provider's update day (YYYY-MM-DD). */
  date: string | null;
  rates: FxRate[];
  source: { name: string; url: string };
}

const money = (n: number, digits: number) => n.toLocaleString('en-SG', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "฿", "RM", or "AUD " when the symbol is missing or shared by several currencies ("$", "kr"). */
function prefix(r: Pick<FxRate, 'code' | 'symbol'>): string {
  const s = r.symbol?.trim();
  return !s || s === '$' || s === 'kr' || s === '£' && r.code !== 'GBP' ? `${r.code} ` : s;
}

/**
 * "S$1 = ฿25.9", or, when S$1 buys more than 100 units, the other way round with a round
 * amount: "¥1,000 = S$8.80", "₫100,000 = S$5.15" (easier to use when shopping).
 */
export function fxText(r: Pick<FxRate, 'code' | 'symbol' | 'perSgd'>): string {
  const p = prefix(r);
  if (r.perSgd > 100) {
    const unit = 10 ** (Math.floor(Math.log10(r.perSgd)) + 1);
    return `${p}${money(unit, 0)} = S$${money(unit / r.perSgd, 2)}`;
  }
  return `S$1 = ${p}${money(r.perSgd, r.perSgd < 10 ? 2 : 1)}`;
}
