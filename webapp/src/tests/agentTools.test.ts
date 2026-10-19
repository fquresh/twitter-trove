// Role-aware date parsing for the chat agent's date tools. The bug this guards:
// a 'to' bound returning the START of a period makes `created_at <= to` exclude
// the whole period (tweets_in_period('2024','2024') was an empty window).
import { describe, it, expect } from 'vitest';
import { parseLooseDate } from '../db/queries/agentTools';

const day = (y: number, m: number, d: number, end = false) =>
  Math.floor(Date.UTC(y, m, d, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0) / 1000);

describe('parseLooseDate - start vs end bounds', () => {
  it('year: start = Jan 1, end = Dec 31 23:59:59', () => {
    expect(parseLooseDate('2024', 'start')).toBe(day(2024, 0, 1));
    expect(parseLooseDate('2024', 'end')).toBe(day(2024, 11, 31, true));
  });

  it('a single year as both bounds spans the whole year (not an empty window)', () => {
    const from = parseLooseDate('2024', 'start')!;
    const to = parseLooseDate('2024', 'end')!;
    expect(to - from).toBeGreaterThan(364 * 24 * 3600); // ~a full year, inclusive
  });

  it('quarter: end of Q4 is Dec 31 23:59:59', () => {
    expect(parseLooseDate('2024-Q4', 'start')).toBe(day(2024, 9, 1)); // Oct 1
    expect(parseLooseDate('2024-Q4', 'end')).toBe(day(2024, 11, 31, true));
  });

  it('year-month: end of Feb 2024 is the 29th (leap year) 23:59:59', () => {
    expect(parseLooseDate('2024-02', 'start')).toBe(day(2024, 1, 1));
    expect(parseLooseDate('2024-02', 'end')).toBe(day(2024, 1, 29, true));
  });

  it('ISO date as end bound = end of that day; full datetime is exact', () => {
    expect(parseLooseDate('2024-03-15', 'end')).toBe(day(2024, 2, 15, true));
    const exact = Math.floor(Date.parse('2024-03-15T10:30:00Z') / 1000);
    expect(parseLooseDate('2024-03-15T10:30:00Z', 'end')).toBe(exact);
  });

  it('defaults to start and returns null on garbage', () => {
    expect(parseLooseDate('2024')).toBe(day(2024, 0, 1));
    expect(parseLooseDate('not a date')).toBeNull();
    expect(parseLooseDate('')).toBeNull();
  });
});
