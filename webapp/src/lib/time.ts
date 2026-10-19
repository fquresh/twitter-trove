import type { Granularity } from '../filters/types';

// Given a bucket key like "2024-03" and the granularity it was bucketed with,
// compute the [start, end] unix-second range (inclusive) that drill-down should
// apply. Always computed in the viewer's local time.

export function bucketBounds(
  bucket: string,
  granularity: Granularity,
): { from: number; to: number } | null {
  if (granularity === 'year') {
    if (!/^\d{4}$/.test(bucket)) return null;
    const y = Number(bucket);
    const from = new Date(y, 0, 1, 0, 0, 0, 0).getTime() / 1000;
    const to = new Date(y + 1, 0, 1, 0, 0, 0, 0).getTime() / 1000 - 1;
    return { from: Math.floor(from), to: Math.floor(to) };
  }
  if (granularity === 'month') {
    const m = bucket.match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const from = new Date(y, mm, 1).getTime() / 1000;
    const to = new Date(y, mm + 1, 1).getTime() / 1000 - 1;
    return { from: Math.floor(from), to: Math.floor(to) };
  }
  if (granularity === 'week') {
    // YYYY-MM-DD of the Sunday at the start of the week (Sun-Sat).  Range is
    // the inclusive 7-day window from Sun 00:00 to Sat 23:59:59.
    const m = bucket.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const sunday = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    sunday.setHours(0, 0, 0, 0);
    const from = Math.floor(sunday.getTime() / 1000);
    const end = new Date(sunday);
    end.setDate(sunday.getDate() + 7);
    const to = Math.floor(end.getTime() / 1000) - 1;
    return { from, to };
  }
  if (granularity === 'day') {
    const m = bucket.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const [y, mm, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const from = new Date(y, mm, d).getTime() / 1000;
    const to = new Date(y, mm, d + 1).getTime() / 1000 - 1;
    return { from: Math.floor(from), to: Math.floor(to) };
  }
  return null;
}
