import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { weatherCachePlugin } from './server/plugin';
import { parseCurrency } from './src/lib/currency';

// The Travelpayouts token and SerpApi key are read server-side (no VITE_ prefix) and used by the
// fare caches (server/fareCache.ts, /api/fares/* and /api/live-fares/*), so they never reach
// the browser bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const token = env.TRAVELPAYOUTS_TOKEN ?? '';
  const serpapiKey = env.SERPAPI_KEY ?? '';
  const serpapiMonthlyLimit = Number(env.SERPAPI_MONTHLY_LIMIT) > 0 ? Number(env.SERPAPI_MONTHLY_LIMIT) : undefined;
  // Currency for every fare request and price shown (src/lib/currency.ts); defaults to SGD.
  const currency = parseCurrency(env.FARE_CURRENCY);

  return {
    define: { __FARE_CURRENCY__: JSON.stringify(currency) },
    // Weather cache + seeder (SQLite in data/weather.db). Set WEATHER_SEED=0 to disable seeding.
    plugins: [react(), ...(process.env.VITEST ? [] : [weatherCachePlugin({ root: process.cwd(), seed: env.WEATHER_SEED !== '0', faresToken: token, serpapiKey, serpapiMonthlyLimit, currency })])],
  };
});
