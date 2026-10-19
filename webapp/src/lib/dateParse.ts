// Lenient date input parser for the date-range picker. Accepts the formats
// users actually type - ISO, US slash, spelled-out, year-only, quarter,
// month, and relative ("today", "yesterday"). Returns unix seconds at the
// start or end of the matched day/period depending on `role`.
//
// Edge anchoring matters: `from` snaps to 00:00:00 of the chosen day, `to`
// snaps to 23:59:59 so the user-typed end date is *inclusive*. (This is the
// opposite of the original `urlSync.parseUnixSeconds`, which always used
// midnight and silently clipped the end day off any saved range.)

export type ParseRole = 'from' | 'to';

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export function startOfDayUnix(y: number, m: number, d: number): number {
  return Math.floor(new Date(y, m, d, 0, 0, 0, 0).getTime() / 1000);
}
export function endOfDayUnix(y: number, m: number, d: number): number {
  return Math.floor(new Date(y, m, d, 23, 59, 59, 999).getTime() / 1000);
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

export function parseDateInput(raw: string, role: ParseRole): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  const today = new Date();
  const ty = today.getFullYear();
  const tm = today.getMonth();
  const td = today.getDate();
  const atDay = role === 'from' ? startOfDayUnix : endOfDayUnix;
  const atPeriodStart = startOfDayUnix;
  const atPeriodEnd = endOfDayUnix;

  // Relative single-day inputs.
  if (s === 'today' || s === 'now') return atDay(ty, tm, td);
  if (s === 'yesterday') return atDay(ty, tm, td - 1);
  if (s === 'tomorrow') return atDay(ty, tm, td + 1);

  let m: RegExpMatchArray | null;

  // Year-quarter: "2024 q1" / "q1 2024" / "2024-q1" / "2024q1"
  if ((m = s.match(/^(?:(\d{4})\s*[-\s]?\s*q([1-4])|q([1-4])\s+(\d{4}))$/))) {
    const y = Number(m[1] ?? m[4]);
    const q = Number(m[2] ?? m[3]);
    const startMonth = (q - 1) * 3;
    const endMonth = startMonth + 2;
    return role === 'from'
      ? atPeriodStart(y, startMonth, 1)
      : atPeriodEnd(y, endMonth, lastDayOfMonth(y, endMonth));
  }

  // YYYY-MM-DD or YYYY-M-D (ISO-ish).
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const y = Number(m[1]);
    const mn = Number(m[2]) - 1;
    const d = Number(m[3]);
    if (mn < 0 || mn > 11 || d < 1 || d > 31) return null;
    return atDay(y, mn, d);
  }

  // YYYY-MM (whole month).
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) {
    const y = Number(m[1]);
    const mn = Number(m[2]) - 1;
    if (mn < 0 || mn > 11) return null;
    return role === 'from'
      ? atPeriodStart(y, mn, 1)
      : atPeriodEnd(y, mn, lastDayOfMonth(y, mn));
  }

  // Year only: "2024".
  if ((m = s.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return role === 'from' ? atPeriodStart(y, 0, 1) : atPeriodEnd(y, 11, 31);
  }

  // M/D/YYYY or M/D/YY (US slash).
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    const mn = Number(m[1]) - 1;
    const d = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += y >= 50 ? 1900 : 2000;
    if (mn < 0 || mn > 11 || d < 1 || d > 31) return null;
    return atDay(y, mn, d);
  }

  // "Jan 15, 2024" / "Jan 15 2024" / "January 15 2024"
  if ((m = s.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mn = MONTHS[m[1]];
    if (mn === undefined) return null;
    const d = Number(m[2]);
    if (d < 1 || d > 31) return null;
    return atDay(Number(m[3]), mn, d);
  }

  // "15 Jan 2024"
  if ((m = s.match(/^(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})$/))) {
    const mn = MONTHS[m[2]];
    if (mn === undefined) return null;
    const d = Number(m[1]);
    if (d < 1 || d > 31) return null;
    return atDay(Number(m[3]), mn, d);
  }

  // "Jan 2024" / "January 2024" - whole month.
  if ((m = s.match(/^([a-z]+)\.?\s+(\d{4})$/))) {
    const mn = MONTHS[m[1]];
    if (mn === undefined) return null;
    const y = Number(m[2]);
    return role === 'from'
      ? atPeriodStart(y, mn, 1)
      : atPeriodEnd(y, mn, lastDayOfMonth(y, mn));
  }

  // Last resort - try the native parser. Anchors to the parsed day's edge.
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) {
    const dt = new Date(t);
    return atDay(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }

  return null;
}

/** Render a unix-seconds timestamp back as `YYYY-MM-DD` (locale-independent,
 * so what the user typed round-trips through the URL). */
export function formatDateInputValue(sec: number | null): string {
  if (sec === null) return '';
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Presets ────────────────────────────────────────────────────────────────
export type PresetKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'last90'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | 'lastYear'
  | 'all';

export interface Preset {
  key: PresetKey;
  label: string;
}

export const PRESETS: Preset[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 90 days' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'thisYear', label: 'This year' },
  { key: 'lastYear', label: 'Last year' },
  { key: 'all', label: 'All time' },
];

export function presetRange(key: PresetKey): { from: number | null; to: number | null } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  switch (key) {
    case 'today':
      return { from: startOfDayUnix(y, m, d), to: endOfDayUnix(y, m, d) };
    case 'yesterday':
      return { from: startOfDayUnix(y, m, d - 1), to: endOfDayUnix(y, m, d - 1) };
    case 'last7':
      return { from: startOfDayUnix(y, m, d - 6), to: endOfDayUnix(y, m, d) };
    case 'last30':
      return { from: startOfDayUnix(y, m, d - 29), to: endOfDayUnix(y, m, d) };
    case 'last90':
      return { from: startOfDayUnix(y, m, d - 89), to: endOfDayUnix(y, m, d) };
    case 'thisMonth':
      return {
        from: startOfDayUnix(y, m, 1),
        to: endOfDayUnix(y, m, lastDayOfMonth(y, m)),
      };
    case 'lastMonth': {
      const lm = m === 0 ? 11 : m - 1;
      const ly = m === 0 ? y - 1 : y;
      return {
        from: startOfDayUnix(ly, lm, 1),
        to: endOfDayUnix(ly, lm, lastDayOfMonth(ly, lm)),
      };
    }
    case 'thisYear':
      return { from: startOfDayUnix(y, 0, 1), to: endOfDayUnix(y, 11, 31) };
    case 'lastYear':
      return { from: startOfDayUnix(y - 1, 0, 1), to: endOfDayUnix(y - 1, 11, 31) };
    case 'all':
      return { from: null, to: null };
  }
}
