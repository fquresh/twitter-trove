import { describe, it, expect } from 'vitest';
import { bucketBounds } from '../lib/time';

// bucketBounds works in the viewer's local time. Expected bounds are derived
// from the same `new Date(y, m, d, ...)` constructor the implementation uses,
// so these assertions hold regardless of the runner's timezone.

const DAY = 86_400;

describe('bucketBounds - year', () => {
  it('spans Jan 1 00:00 through Dec 31 23:59:59', () => {
    const from = Math.floor(new Date(2024, 0, 1, 0, 0, 0, 0).getTime() / 1000);
    const to = Math.floor(new Date(2025, 0, 1, 0, 0, 0, 0).getTime() / 1000) - 1;
    expect(bucketBounds('2024', 'year')).toEqual({ from, to });
  });

  it('rejects a non-year key', () => {
    expect(bucketBounds('2024-03', 'year')).toBeNull();
    expect(bucketBounds('nope', 'year')).toBeNull();
  });
});

describe('bucketBounds - month', () => {
  it('spans the first of the month through the last second before the next', () => {
    const from = Math.floor(new Date(2024, 2, 1).getTime() / 1000);
    const to = Math.floor(new Date(2024, 3, 1).getTime() / 1000) - 1;
    expect(bucketBounds('2024-03', 'month')).toEqual({ from, to });
  });

  it('handles the December → next-January rollover', () => {
    const from = Math.floor(new Date(2024, 11, 1).getTime() / 1000);
    const to = Math.floor(new Date(2025, 0, 1).getTime() / 1000) - 1;
    expect(bucketBounds('2024-12', 'month')).toEqual({ from, to });
  });

  it('rejects malformed month keys', () => {
    expect(bucketBounds('2024', 'month')).toBeNull();
    expect(bucketBounds('2024-13-01', 'month')).toBeNull();
  });
});

describe('bucketBounds - week (Sunday-start)', () => {
  it('spans exactly seven days starting at the given Sunday', () => {
    // 2024-03-10 is a Sunday.
    const res = bucketBounds('2024-03-10', 'week');
    expect(res).not.toBeNull();
    const from = Math.floor(new Date(2024, 2, 10).setHours(0, 0, 0, 0) / 1000);
    expect(res!.from).toBe(from);
    // Inclusive window: Sun 00:00 .. Sat 23:59:59 local. Derive the end from
    // the same calendar arithmetic the implementation uses - a fixed
    // 7 * DAY - 1 span is wrong in any zone with a DST change that week, and
    // 2024-03-10 is exactly that (US spring-forward, so the week is 167 h).
    const nextSunday = Math.floor(new Date(2024, 2, 17).setHours(0, 0, 0, 0) / 1000);
    expect(res!.to).toBe(nextSunday - 1);
  });

  it('starts the window on a Sunday (local dow 0)', () => {
    const res = bucketBounds('2024-03-10', 'week');
    expect(new Date(res!.from * 1000).getDay()).toBe(0);
  });

  it('rejects a non-date week key', () => {
    expect(bucketBounds('2024-W10', 'week')).toBeNull();
  });
});

describe('bucketBounds - day', () => {
  it('spans a single calendar day', () => {
    const res = bucketBounds('2024-03-15', 'day');
    const from = Math.floor(new Date(2024, 2, 15).getTime() / 1000);
    const to = Math.floor(new Date(2024, 2, 16).getTime() / 1000) - 1;
    expect(res).toEqual({ from, to });
    expect(res!.to - res!.from).toBe(DAY - 1);
  });

  it('rejects malformed day keys', () => {
    expect(bucketBounds('2024-03', 'day')).toBeNull();
  });
});
