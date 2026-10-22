// The currency fares are requested and shown in, set by FARE_CURRENCY in .env.local (default SGD).
// vite.config.ts injects it into the browser bundle as __FARE_CURRENCY__; the server's fare
// prefetch is handed the same value, so both build identical request paths (fareRequests.ts).

declare const __FARE_CURRENCY__: string | undefined;

export const DEFAULT_CURRENCY = 'SGD';

/** Upper-case ISO 4217 code, or SGD when the value isn't one. */
export function parseCurrency(value: string | undefined): string {
  const c = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : DEFAULT_CURRENCY;
}

export const FARE_CURRENCY = parseCurrency(typeof __FARE_CURRENCY__ === 'string' ? __FARE_CURRENCY__ : undefined);

const SYMBOLS: Record<string, string> = { SGD: 'S$', USD: 'US$', AUD: 'A$', EUR: '€', GBP: '£', JPY: '¥' };
const symbol = SYMBOLS[FARE_CURRENCY];

/** Prefix for prices, e.g. "S$" (or "MYR " for a currency without a short symbol). */
export const CURRENCY_PREFIX = symbol ?? `${FARE_CURRENCY} `;

/** Shown on the Flights section, e.g. "Prices in SGD (S$)". */
export const CURRENCY_LABEL = symbol ? `Prices in ${FARE_CURRENCY} (${symbol})` : `Prices in ${FARE_CURRENCY}`;

export const formatPrice = (n: number) => `${CURRENCY_PREFIX}${Math.round(n).toLocaleString('en-SG')}`;
