import { describe, expect, it } from 'vitest';
import { addDays, ERA5_SETTLED_DAYS } from './dates';
import { tripFetchPlan } from './tripFetchPlan';

describe('trip fetch plan', () => {
  it('stops at settled ERA5 days, so the analysis is served from the database alone', () => {
    // A trip whose latest same-date year is this year: the main range would reach close to today.
    const today = '2026-10-21';
    const settled = addDays(today, -ERA5_SETTLED_DAYS);
    const plan = tripFetchPlan('2027-03-26', '2027-03-28', today);
    expect(plan.main!.end).toBe(settled);
    expect(plan.older.every((w) => w.end <= settled)).toBe(true);
    expect(plan.windows.every((w) => w.end <= settled)).toBe(true);
    expect(plan.windows).toHaveLength(10);
  });
});
