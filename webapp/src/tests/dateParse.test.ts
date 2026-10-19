// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  parseDateInput,
  formatDateInputValue,
  presetRange,
} from '../lib/dateParse';

// Helper: convert a unix-second timestamp into a local-time ISO-ish string
// so the assertions stay readable across machines.
function ymdhms(sec: number | null): string | null {
  if (sec === null) return null;
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

describe('parseDateInput', () => {
  it('parses YYYY-MM-DD anchored at start- vs end-of-day', () => {
    expect(ymdhms(parseDateInput('2024-01-15', 'from'))).toBe('2024-01-15 00:00:00');
    expect(ymdhms(parseDateInput('2024-01-15', 'to'))).toBe('2024-01-15 23:59:59');
  });

  it('accepts YYYY-M-D (single-digit) too', () => {
    expect(ymdhms(parseDateInput('2024-1-5', 'from'))).toBe('2024-01-05 00:00:00');
  });

  it('parses US slash format', () => {
    expect(ymdhms(parseDateInput('1/15/2024', 'from'))).toBe('2024-01-15 00:00:00');
    expect(ymdhms(parseDateInput('01/15/24', 'from'))).toBe('2024-01-15 00:00:00');
  });

  it('parses spelled-out dates', () => {
    expect(ymdhms(parseDateInput('Jan 15 2024', 'from'))).toBe('2024-01-15 00:00:00');
    expect(ymdhms(parseDateInput('January 15, 2024', 'from'))).toBe('2024-01-15 00:00:00');
    expect(ymdhms(parseDateInput('15 Jan 2024', 'from'))).toBe('2024-01-15 00:00:00');
  });

  it('parses year-only as full-year window', () => {
    expect(ymdhms(parseDateInput('2024', 'from'))).toBe('2024-01-01 00:00:00');
    expect(ymdhms(parseDateInput('2024', 'to'))).toBe('2024-12-31 23:59:59');
  });

  it('parses month-only inputs as the whole month', () => {
    expect(ymdhms(parseDateInput('2024-03', 'from'))).toBe('2024-03-01 00:00:00');
    expect(ymdhms(parseDateInput('2024-03', 'to'))).toBe('2024-03-31 23:59:59');
    expect(ymdhms(parseDateInput('Feb 2024', 'from'))).toBe('2024-02-01 00:00:00');
    expect(ymdhms(parseDateInput('Feb 2024', 'to'))).toBe('2024-02-29 23:59:59'); // leap
  });

  it('parses year-quarter in either word order', () => {
    expect(ymdhms(parseDateInput('2024 Q1', 'from'))).toBe('2024-01-01 00:00:00');
    expect(ymdhms(parseDateInput('Q1 2024', 'to'))).toBe('2024-03-31 23:59:59');
    expect(ymdhms(parseDateInput('2024-Q4', 'to'))).toBe('2024-12-31 23:59:59');
  });

  it('parses relative keywords', () => {
    const today = parseDateInput('today', 'from');
    const yest = parseDateInput('yesterday', 'from');
    expect(today).not.toBeNull();
    expect(yest).not.toBeNull();
    expect(today! - yest!).toBe(86400);
  });

  it('returns null on garbage', () => {
    expect(parseDateInput('not a date', 'from')).toBeNull();
    expect(parseDateInput('13/45/2024', 'from')).toBeNull();
    expect(parseDateInput('', 'from')).toBeNull();
  });

  it('formats and round-trips through YYYY-MM-DD', () => {
    const from = parseDateInput('2024-01-15', 'from')!;
    const to = parseDateInput('2024-01-15', 'to')!;
    expect(formatDateInputValue(from)).toBe('2024-01-15');
    expect(formatDateInputValue(to)).toBe('2024-01-15');
  });
});

describe('presetRange', () => {
  it('today spans one full local day', () => {
    const r = presetRange('today');
    expect(r.from).not.toBeNull();
    expect(r.to).not.toBeNull();
    // ~86399 seconds in a day at end-of-day vs start-of-day (modulo DST).
    const diff = r.to! - r.from!;
    expect(diff).toBeGreaterThanOrEqual(86399 - 3600);
    expect(diff).toBeLessThanOrEqual(86399 + 3600);
  });

  it('"all" returns nulls so the URL ends up empty', () => {
    expect(presetRange('all')).toEqual({ from: null, to: null });
  });

  it('last7 covers seven days inclusive of today', () => {
    const r = presetRange('last7');
    const days = (r.to! - r.from!) / 86400;
    // Span is 7 days minus 1 second, ± a possible DST hour.
    expect(days).toBeGreaterThanOrEqual(6.9);
    expect(days).toBeLessThanOrEqual(7.1);
  });
});
