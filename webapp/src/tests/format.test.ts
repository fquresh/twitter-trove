import { describe, it, expect } from 'vitest';
import {
  formatNumber,
  formatDate,
  formatDateTime,
  formatBucket,
  formatWeekRange,
} from '../lib/format';

describe('formatNumber', () => {
  it('renders null / undefined as "0"', () => {
    expect(formatNumber(null)).toBe('0');
    expect(formatNumber(undefined)).toBe('0');
  });

  it('leaves values under 1,000 untouched', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(999)).toBe('999');
  });

  it('compacts thousands with a K suffix and drops a trailing .0', () => {
    expect(formatNumber(1_000)).toBe('1K');
    expect(formatNumber(1_500)).toBe('1.5K');
    expect(formatNumber(12_345)).toBe('12.3K');
    expect(formatNumber(999_999)).toBe('1000K');
  });

  it('compacts millions with an M suffix and drops a trailing .0', () => {
    expect(formatNumber(1_000_000)).toBe('1M');
    expect(formatNumber(2_500_000)).toBe('2.5M');
    expect(formatNumber(12_340_000)).toBe('12.3M');
  });
});

describe('formatDate', () => {
  it('renders null as an empty string', () => {
    expect(formatDate(null)).toBe('');
  });

  it('renders a real timestamp as a non-empty string containing the year', () => {
    // Midday UTC keeps the calendar date stable regardless of the runner's TZ.
    const sec = Math.floor(Date.UTC(2024, 5, 15, 12, 0, 0) / 1000);
    const out = formatDate(sec);
    expect(out).not.toBe('');
    expect(out).toContain('2024');
  });
});

describe('formatDateTime', () => {
  it('includes the year for a real timestamp', () => {
    const sec = Math.floor(Date.UTC(2024, 5, 15, 12, 30, 0) / 1000);
    const out = formatDateTime(sec);
    expect(out).toContain('2024');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('formatBucket', () => {
  it('passes a bare year through unchanged', () => {
    expect(formatBucket('2024')).toBe('2024');
  });

  it('rewrites an ISO-week key from "-W" to " W"', () => {
    expect(formatBucket('2024-W12')).toBe('2024 W12');
  });

  it('renders a month bucket as a localized month + year', () => {
    const out = formatBucket('2024-03');
    expect(out).toContain('2024');
    // Month name/number is locale-dependent, but the year always appears and
    // the raw "2024-03" key must not survive.
    expect(out).not.toBe('2024-03');
  });

  it('renders a day bucket as a localized date', () => {
    const out = formatBucket('2024-03-15');
    expect(out).toContain('2024');
    expect(out).not.toBe('2024-03-15');
  });

  it('returns unrecognized input verbatim', () => {
    expect(formatBucket('not-a-bucket')).toBe('not-a-bucket');
    expect(formatBucket('')).toBe('');
  });
});

describe('formatWeekRange', () => {
  it('renders a Sunday bucket as a tight Sun..Sat range', () => {
    // 2024-03-10 is a Sunday; the week spans through Saturday 2024-03-16.
    expect(formatWeekRange('2024-03-10')).toBe("3/10-3/16 '24");
  });

  it('crosses month boundaries within the 7-day window', () => {
    // 2024-03-31 is a Sunday; +6 days lands on 2024-04-06.
    expect(formatWeekRange('2024-03-31')).toBe("3/31-4/6 '24");
  });

  it('crosses a year boundary within the window', () => {
    // 2024-12-29 is a Sunday; +6 days lands on 2025-01-04.
    expect(formatWeekRange('2024-12-29')).toBe("12/29-1/4 '25");
  });

  it('returns non-matching input verbatim', () => {
    expect(formatWeekRange('2024-W01')).toBe('2024-W01');
    expect(formatWeekRange('garbage')).toBe('garbage');
  });
});
