import { useEffect, useState } from 'react';
import { OPEN_METEO } from '../services/http';

interface Status {
  cache: { historyDays: number; historyPlaces: number; forecastPlaces: number; liveResponses: number; todayPlaces?: number };
  budget: { today: number; seedToday: number; blockedUntil: number | null; limits: { perDay: number; seedPerDay: number } };
  seeding: { phase: string; detail: string; pausedReason: string | null; history: { done: number; total: number } };
}

/** Shows what the local weather database holds and what the background seeder is doing. */
export function CacheStatus() {
  const [s, setS] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(OPEN_METEO.status)
        .then((r) => (r.ok ? (r.json() as Promise<Status>) : Promise.reject()))
        .then((d) => alive && (setS(d), setUnavailable(false)))
        .catch(() => alive && setUnavailable(true));
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (unavailable) return <p className="small muted">Weather database: not reachable (run the app with <code>npm run dev</code> or <code>npm run preview</code>).</p>;
  if (!s) return null;
  const pct = s.seeding.history.total ? Math.round((s.seeding.history.done / s.seeding.history.total) * 100) : 0;
  return (
    <details className="small muted">
      <summary style={{ fontWeight: 400 }}>
        Weather database: history for {s.cache.historyPlaces.toLocaleString('en-SG')} places ({s.cache.historyDays.toLocaleString('en-SG')} days), forecasts for{' '}
        {s.cache.forecastPlaces.toLocaleString('en-SG')}, today's map for {(s.cache.todayPlaces ?? 0).toLocaleString('en-SG')} · seeding {pct}% {s.seeding.pausedReason ? '(paused)' : ''}
      </summary>
      <ul className="plain">
        <li>Now: {s.seeding.detail || s.seeding.phase}{s.seeding.pausedReason ? `. ${s.seeding.pausedReason}` : ''}</li>
        <li>History jobs done: {s.seeding.history.done.toLocaleString('en-SG')} of {s.seeding.history.total.toLocaleString('en-SG')} (one place-year each; popular cities, then Southeast Asia, Asia and the rest).</li>
        <li>
          Open-Meteo units used today: {s.budget.today.toLocaleString('en-SG')} of {s.budget.limits.perDay.toLocaleString('en-SG')} ({s.budget.seedToday.toLocaleString('en-SG')} by seeding, capped at{' '}
          {s.budget.limits.seedPerDay.toLocaleString('en-SG')}).
        </li>
        <li>Saved history is reused for any overlapping dates, so repeated searches don't use the API again.</li>
      </ul>
    </details>
  );
}
