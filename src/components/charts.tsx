import { CURRENCY_PREFIX } from '../lib/currency';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { formatShortDate } from '../lib/dates';
import type { RainContext } from '../lib/rainContext';
import type { YearStats } from '../lib/weatherAnalysis';

const axis = { fontSize: 12, fill: 'var(--text-muted)' };
const grid = <CartesianGrid stroke="var(--grid)" vertical={false} />;
const BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

function Tip({ active, payload, label, fmt }: TooltipProps<number, string> & { fmt: (v: number, name: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="t">{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="secondary">
          {fmt(p.value as number, p.name as string)}
        </div>
      ))}
    </div>
  );
}

const cursor = { fill: 'var(--surface-2)' };

export function WetDaysChart({ years, mean }: { years: YearStats[]; mean: number | null }) {
  const data = [...years].reverse().map((y, i, arr) => ({ year: String(y.year), wet: y.wetDays, last: i === arr.length - 1 }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 10, right: 8, left: -18, bottom: 0 }} barCategoryGap={2}>
        {grid}
        <XAxis dataKey="year" tick={axis} tickLine={false} axisLine={false} />
        <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
        <Tooltip cursor={cursor} content={<Tip fmt={(v) => `${v} wet day${v === 1 ? '' : 's'}`} />} />
        {mean !== null && <ReferenceLine y={mean} stroke="var(--text-muted)" strokeDasharray="4 3" />}
        <Bar dataKey="wet" name="Wet days" radius={BAR_RADIUS} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.year} fill={d.last ? 'var(--series-1)' : 'var(--series-1-soft)'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function RainChart({ years, median }: { years: YearStats[]; median: number | null }) {
  const data = [...years].reverse().map((y, i, arr) => ({ year: String(y.year), rain: Math.round(y.totalRainMm), last: i === arr.length - 1 }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 10, right: 8, left: -12, bottom: 0 }} barCategoryGap={2}>
        {grid}
        <XAxis dataKey="year" tick={axis} tickLine={false} axisLine={false} />
        <YAxis tick={axis} tickLine={false} axisLine={false} unit=" mm" width={60} />
        <Tooltip cursor={cursor} content={<Tip fmt={(v) => `${v} mm total rain`} />} />
        {median !== null && <ReferenceLine y={median} stroke="var(--text-muted)" strokeDasharray="4 3" />}
        <Bar dataKey="rain" name="Rain" radius={BAR_RADIUS} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.year} fill={d.last ? 'var(--series-1)' : 'var(--series-1-soft)'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TemperatureChart({ years }: { years: YearStats[] }) {
  const data = [...years].reverse().map((y) => ({
    year: String(y.year),
    max: y.meanTMaxC === null ? null : Math.round(y.meanTMaxC * 10) / 10,
    min: y.meanTMinC === null ? null : Math.round(y.meanTMinC * 10) / 10,
  }));
  const vals = data.flatMap((d) => [d.max, d.min]).filter((v): v is number => v !== null);
  const lo = Math.floor((Math.min(...vals) - 1) / 5) * 5;
  const hi = Math.ceil((Math.max(...vals) + 1) / 5) * 5;
  const ticks = Array.from({ length: (hi - lo) / 5 + 1 }, (_, i) => lo + i * 5);
  return (
    <>
      <div className="legend" aria-hidden>
        <span><i className="swatch" style={{ background: 'var(--series-2)' }} /> Avg daily max</span>
        <span><i className="swatch" style={{ background: 'var(--series-1)' }} /> Avg daily min</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
          {grid}
          <XAxis dataKey="year" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} unit="°" domain={[lo, hi]} ticks={ticks} />
          <Tooltip content={<Tip fmt={(v, n) => `${n}: ${v} °C`} />} />
          <Line dataKey="max" name="Avg max" stroke="var(--series-2)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: 'var(--surface-1)' }} isAnimationActive={false} />
          <Line dataKey="min" name="Avg min" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: 'var(--surface-1)' }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

export function DailyWetChanceChart({ data }: { data: { label: string; pct: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 10, right: 8, left: -18, bottom: 0 }} barCategoryGap={2}>
        {grid}
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
        <YAxis tick={axis} tickLine={false} axisLine={false} domain={[0, 100]} unit="%" />
        <Tooltip cursor={cursor} content={<Tip fmt={(v) => `Wet in ${v}% of past years`} />} />
        <Bar dataKey="pct" name="Wet-day frequency" fill="var(--series-1)" radius={BAR_RADIUS} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FareHistogram({ prices, reference, referenceLabel, median }: { prices: number[]; reference: number | null; referenceLabel: string; median: number | null }) {
  if (prices.length < 2) return null;
  const lo = Math.min(...prices, reference ?? Infinity);
  const hi = Math.max(...prices, reference ?? -Infinity);
  const bins = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(prices.length))));
  const step = Math.max(10, Math.ceil((hi - lo) / bins / 10) * 10);
  const start = Math.floor(lo / step) * step;
  const data = Array.from({ length: Math.ceil((hi - start) / step) + 1 }, (_, i) => {
    const from = start + i * step;
    return { bin: from + step / 2, label: `${CURRENCY_PREFIX}${from}–${from + step}`, count: prices.filter((p) => p >= from && p < from + step).length };
  });
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 18, right: 12, left: -18, bottom: 0 }} barCategoryGap={2}>
        {grid}
        <XAxis dataKey="bin" type="number" domain={[start, start + data.length * step]} tick={axis} tickLine={false} axisLine={false} tickFormatter={(v) => `${CURRENCY_PREFIX}${v}`} />
        <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
        <Tooltip cursor={cursor} content={({ active, payload }) => active && payload?.length ? (
          <div className="tooltip"><div className="t">{payload[0].payload.label}</div><div className="secondary">{payload[0].value} observed fare(s)</div></div>
        ) : null} />
        <Bar dataKey="count" name="Fares" fill="var(--series-1)" radius={BAR_RADIUS} isAnimationActive={false} barSize={Math.max(6, 360 / data.length)} />
        {median !== null && <ReferenceLine x={median} stroke="var(--text-muted)" strokeDasharray="4 3" label={{ value: 'median', position: 'top', fontSize: 11, fill: 'var(--text-secondary)' }} />}
        {reference !== null && <ReferenceLine x={reference} stroke="var(--series-2)" strokeWidth={2} label={{ value: referenceLabel, position: 'insideTopLeft', fontSize: 11, fill: 'var(--text-primary)' }} />}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Daily wet-day chance or average rainfall across the ≥30-day window around the trip. */
export function RainContextChart({ ctx, metric }: { ctx: RainContext; metric: 'wet' | 'mm' }) {
  const data = ctx.days.map((d) => ({
    label: formatShortDate(d.date),
    value: metric === 'wet' ? d.wetPct : d.meanMm === null ? null : Math.round(d.meanMm * 10) / 10,
    trip: d.segment === 'trip',
    segment: d.segment,
  }));
  const alt = ctx.drierAlternative;
  return (
    <ResponsiveContainer width="100%" height={170}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={1}>
        {grid}
        {alt && (
          <ReferenceArea x1={formatShortDate(alt.start)} x2={formatShortDate(alt.end)} fill="var(--good)" fillOpacity={0.1} stroke="var(--good)" strokeOpacity={0.4} strokeDasharray="3 3" />
        )}
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
        <YAxis tick={axis} tickLine={false} axisLine={false} unit={metric === 'wet' ? '%' : ' mm'} width={metric === 'wet' ? 44 : 54} domain={metric === 'wet' ? [0, 100] : [0, 'auto']} />
        <Tooltip
          cursor={cursor}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="tooltip">
                <div className="t">{payload[0].payload.label}{payload[0].payload.trip ? ' · your trip' : ''}</div>
                <div className="secondary">
                  {payload[0].value === null || payload[0].value === undefined
                    ? 'No data'
                    : metric === 'wet'
                      ? `Wet in ${payload[0].value}% of past years`
                      : `${payload[0].value} mm average rainfall`}
                </div>
              </div>
            ) : null
          }
        />
        <Bar dataKey="value" name={metric === 'wet' ? 'Wet-day chance' : 'Average rainfall'} radius={BAR_RADIUS} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.label} fill={d.trip ? 'var(--series-1)' : 'var(--series-1-soft)'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
