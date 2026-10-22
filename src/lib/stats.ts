export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Linear-interpolated quantile (q in 0..1). */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(xs: number[]): number | null {
  return quantile(xs, 0.5);
}

export function stdDev(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function notNull<T>(x: T | null | undefined): x is T {
  return x !== null && x !== undefined;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Linear map of x from [a,b] to [100,0] (or [0,100] if a > b), clamped. */
export function scoreLinear(x: number, best: number, worst: number): number {
  return clamp(((x - worst) / (best - worst)) * 100, 0, 100);
}
