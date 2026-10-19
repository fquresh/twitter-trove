import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DayPicker, type DateRange, type CaptionLabelProps } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import {
  PRESETS,
  formatDateInputValue,
  parseDateInput,
  presetRange,
  type PresetKey,
  startOfDayUnix,
  endOfDayUnix,
} from '../lib/dateParse';
import type { FilterSet } from '../filters/types';
import { FILTER_PARAM_KEYS, paramsFromFilters } from '../filters/urlSync';
import { formatDate, formatNumber } from '../lib/format';
import { useIsMobile } from '../lib/useIsMobile';
import { useDbStatus } from '../lib/dbContext';
import { earliestTweetTime, latestTweetTime, tweetCountByYear } from '../db/queries/tweets';

interface Props {
  filters: FilterSet;
}

// The archive's real temporal extent, plus per-year volume for annotating the
// year drill-down. Fetched once by DateRangePopover and threaded into the
// panel so the pure panel component stays free of DB context.
interface ArchiveRange {
  earliest: number;
  latest: number;
  countsByYear: Map<number, number>;
}

function summarize(filters: FilterSet): string {
  const { from, to } = filters;
  if (from === null && to === null) return 'Any date';
  const f = from !== null ? formatDate(from) : '…';
  const t = to !== null ? formatDate(to) : '…';
  if (from !== null && to === null) return `From ${f}`;
  if (from === null && to !== null) return `Through ${t}`;
  return `${f} → ${t}`;
}

export function DateRangePopover({ filters }: Props) {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { handle } = useDbStatus();

  // Pull the archive's real span + per-year counts once, so the calendar's
  // year drill-down can bound itself to years that actually contain tweets.
  const archiveRange = useQuery({
    queryKey: ['archive-range'],
    enabled: !!handle,
    queryFn: () => {
      if (!handle) return null;
      const earliest = earliestTweetTime(handle.db);
      const latest = latestTweetTime(handle.db);
      if (earliest === null || latest === null) return null;
      return { earliest, latest, countsByYear: tweetCountByYear(handle.db) } satisfies ArchiveRange;
    },
  }).data ?? null;

  useEffect(() => {
    if (!open || isMobile) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, isMobile]);

  const writeRange = (from: number | null, to: number | null) => {
    const next: FilterSet = { ...filters, from, to };
    const sp = paramsFromFilters(next);
    // Preserve params we don't own (session id, etc.).
    for (const [k, v] of params.entries()) {
      if (!FILTER_PARAM_KEYS.includes(k)) sp.append(k, v);
    }
    setParams(sp);
  };

  const isActive = filters.from !== null || filters.to !== null;

  const panel = (
    <DateRangePanel
      filters={filters}
      archiveRange={archiveRange}
      onApply={(from, to) => {
        writeRange(from, to);
        setOpen(false);
      }}
      onClear={() => {
        writeRange(null, null);
        setOpen(false);
      }}
      onCancel={() => setOpen(false)}
    />
  );

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="date-range-trigger"
        className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors md:min-h-0 md:text-xs ${
          isActive
            ? 'border-accent-300 bg-accent-50 text-accent-800 hover:border-accent-400 hover:bg-accent-100 dark:border-accent-500/40 dark:bg-accent-500/10 dark:text-accent-200 dark:hover:bg-accent-500/20'
            : 'border-canvas-300 bg-white text-ink-700 hover:border-accent-300 hover:bg-accent-50 dark:border-white/10 dark:bg-white/5 dark:text-ink-200 dark:hover:bg-white/10'
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
          <path d="M5 1.5v3M11 1.5v3M2.5 6.5h11" />
        </svg>
        <span>{summarize(filters)}</span>
        <span className="text-ink-400">{open ? '▴' : '▾'}</span>
      </button>

      {open && isMobile && (
        <MobileDateSheet onClose={() => setOpen(false)}>{panel}</MobileDateSheet>
      )}

      {open && !isMobile && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Date range"
          className="absolute left-0 top-full z-30 mt-2 w-[min(42rem,calc(100vw-2rem))] rounded-2xl border border-canvas-200 bg-white p-4 shadow-2xl dark:border-white/10 dark:bg-ink-900"
        >
          {panel}
        </div>
      )}
    </div>
  );
}

function MobileDateSheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-ink-900/30 backdrop-blur-sm md:hidden"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
      aria-label="Date range"
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-full rounded-t-[24px] border-t border-white/20 bg-white/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-8px_32px_rgba(0,0,0,0.12)] backdrop-blur-xl dark:border-white/10 dark:bg-ink-900/95"
      >
        {children}
      </div>
    </div>
  );
}

interface PanelProps {
  filters: FilterSet;
  archiveRange: ArchiveRange | null;
  onApply: (from: number | null, to: number | null) => void;
  onClear: () => void;
  onCancel?: () => void;
}

function DateRangePanel({ filters, archiveRange, onApply, onClear, onCancel }: PanelProps) {
  const isMobile = useIsMobile();
  const [month, setMonth] = useState<Date>(() =>
    filters.from !== null ? startOfDayDate(new Date(filters.from * 1000)) : new Date(),
  );

  const [startDraft, setStartDraft] = useState(formatDateInputValue(filters.from));
  const [endDraft, setEndDraft] = useState(formatDateInputValue(filters.to));
  const [startErr, setStartErr] = useState<string | null>(null);
  const [endErr, setEndErr] = useState<string | null>(null);

  // Caption drill-down: 'day' shows the normal calendar; 'month' shows the 12
  // months of drillYear; 'year' shows every year in the archive. Tapping the
  // caption cycles day -> month -> year so a far-off month is 2 taps away
  // instead of 40+ swipes.
  const [captionMode, setCaptionMode] = useState<'day' | 'month' | 'year'>('day');
  const [drillYear, setDrillYear] = useState<number>(() => month.getFullYear());

  // Single-day mode: one calendar tap sets from == to for that day, so a
  // one-day filter is an explicit, discoverable affordance instead of the
  // hidden "tap the same day twice" trick.
  const [singleDay, setSingleDay] = useState(false);

  const selectedRange: DateRange | undefined = useMemo(() => {
    const from = filters.from ? new Date(filters.from * 1000) : undefined;
    const to = filters.to ? new Date(filters.to * 1000) : undefined;
    if (!from && !to) return undefined;
    return { from, to };
  }, [filters.from, filters.to]);

  const [draftRange, setDraftRange] = useState<DateRange | undefined>(selectedRange);

  useEffect(() => {
    setStartDraft(formatDateInputValue(filters.from));
    setEndDraft(formatDateInputValue(filters.to));
    setStartErr(null);
    setEndErr(null);
    setDraftRange(selectedRange);
    setCaptionMode('day');
    if (filters.from !== null) setMonth(startOfDayDate(new Date(filters.from * 1000)));
  }, [filters.from, filters.to, selectedRange]);

  // Archive bounds for the year grid. Fall back to a decade window when the
  // db isn't loaded yet so the drill-down still works.
  const now = useMemo(() => new Date(), []);
  const earliestYear = archiveRange
    ? new Date(archiveRange.earliest * 1000).getFullYear()
    : now.getFullYear() - 10;
  const latestYear = archiveRange
    ? new Date(archiveRange.latest * 1000).getFullYear()
    : now.getFullYear();
  const countsByYear = archiveRange?.countsByYear ?? EMPTY_YEAR_COUNTS;

  const applyInputs = () => {
    let from: number | null = null;
    let to: number | null = null;
    let ok = true;

    if (startDraft.trim()) {
      const v = parseDateInput(startDraft, 'from');
      if (v === null) {
        setStartErr("Couldn't read that date");
        ok = false;
      } else {
        from = v;
        setStartErr(null);
      }
    } else {
      setStartErr(null);
    }
    if (endDraft.trim()) {
      const v = parseDateInput(endDraft, 'to');
      if (v === null) {
        setEndErr("Couldn't read that date");
        ok = false;
      } else {
        to = v;
        setEndErr(null);
      }
    } else {
      setEndErr(null);
    }

    if (ok && from !== null && to !== null && from > to) {
      setEndErr('End is before start');
      ok = false;
    }

    if (ok) {
      onApply(from, to);
    }
  };

  const handleApply = () => {
    const startTyped = startDraft.trim();
    const endTyped = endDraft.trim();

    if (!startTyped && !endTyped && draftRange?.from && draftRange?.to) {
      onApply(
        startOfDayUnix(
          draftRange.from.getFullYear(),
          draftRange.from.getMonth(),
          draftRange.from.getDate(),
        ),
        endOfDayUnix(
          draftRange.to.getFullYear(),
          draftRange.to.getMonth(),
          draftRange.to.getDate(),
        ),
      );
      return;
    }

    applyInputs();
  };

  const applyPreset = (k: PresetKey) => {
    const r = presetRange(k);
    if (r.from !== null && r.to !== null) {
      onApply(r.from, r.to);
    } else {
      onClear();
    }
  };

  const activePreset = useMemo<PresetKey | null>(() => {
    if (filters.from === null && filters.to === null) return 'all';
    for (const p of PRESETS) {
      if (p.key === 'all') continue;
      const r = presetRange(p.key);
      if (r.from === filters.from && r.to === filters.to) return p.key;
    }
    return null;
  }, [filters.from, filters.to]);

  const onSelectRange = (range: DateRange | undefined) => {
    // Single-day mode: any tap pins from == to to that day and commits
    // immediately, so a one-day filter is a single tap (no Apply needed).
    if (singleDay && range?.from) {
      const d = startOfDayDate(range.from);
      setDraftRange({ from: d, to: d });
      setStartDraft(formatDateInputValue(Math.floor(d.getTime() / 1000)));
      setEndDraft(formatDateInputValue(Math.floor(d.getTime() / 1000)));
      setStartErr(null);
      setEndErr(null);
      onApply(
        startOfDayUnix(d.getFullYear(), d.getMonth(), d.getDate()),
        endOfDayUnix(d.getFullYear(), d.getMonth(), d.getDate()),
      );
      return;
    }
    setDraftRange(range);
    if (range?.from) {
      setStartDraft(formatDateInputValue(Math.floor(range.from.getTime() / 1000)));
    } else {
      setStartDraft('');
    }
    if (range?.to) {
      setEndDraft(formatDateInputValue(Math.floor(range.to.getTime() / 1000)));
    } else {
      setEndDraft('');
    }
    setStartErr(null);
    setEndErr(null);
  };

  const swipeStartX = useRef<number | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    swipeStartX.current = e.changedTouches[0].clientX;
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (swipeStartX.current === null) return;
    const diff = e.changedTouches[0].clientX - swipeStartX.current;
    if (Math.abs(diff) > 40 && captionMode === 'day') {
      setMonth((m) => addMonths(m, diff > 0 ? -1 : 1));
    }
    swipeStartX.current = null;
  };

  // Tappable caption label for the day calendar. Memoized so react-day-picker
  // doesn't remount it every render (which would drop the button's focus ring).
  const enterMonthMode = useCallback((displayMonth: Date) => {
    setDrillYear(displayMonth.getFullYear());
    setCaptionMode('month');
  }, []);
  const TapCaption = useMemo(
    () =>
      function TapCaptionLabel({ displayMonth }: CaptionLabelProps) {
        return (
          <button
            type="button"
            onClick={() => enterMonthMode(displayMonth)}
            className="rounded text-sm font-semibold text-ink-900 transition-colors hover:text-accent-600 dark:text-white dark:hover:text-accent-400"
            data-testid="date-caption"
            aria-label={`Jump to month, ${displayMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}
          >
            {displayMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </button>
        );
      },
    [enterMonthMode],
  );

  const pickMonth = (m: number) => {
    setMonth(new Date(drillYear, m, 1));
    setCaptionMode('day');
  };
  const pickYear = (y: number) => {
    setDrillYear(y);
    setCaptionMode('month');
  };

  const archiveSpan =
    archiveRange !== null
      ? `${formatMonthYear(archiveRange.earliest)} - ${formatMonthYear(archiveRange.latest)}`
      : null;

  const dateInputMin = archiveRange ? formatDateInputValue(archiveRange.earliest) : undefined;
  const dateInputMax = archiveRange ? formatDateInputValue(archiveRange.latest) : undefined;

  return (
    <div className="flex max-h-[70vh] flex-col gap-4 md:max-h-none md:grid md:grid-cols-[12rem_1fr] md:grid-rows-[1fr_auto]">
      {/* Presets */}
      <div className="shrink-0 md:col-start-1 md:row-start-1 md:row-end-3">
        <div className="label mb-2">Presets</div>
        <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-col md:items-stretch md:overflow-visible">
          {PRESETS.map((p) => {
            const active = activePreset === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key)}
                className={`chip justify-start whitespace-nowrap ${
                  active
                    ? 'border-accent-400 bg-accent-100 text-accent-800 dark:border-accent-400/60 dark:bg-accent-500/20 dark:text-accent-100'
                    : ''
                }`}
                data-testid={`date-preset-${p.key}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scrollable content on mobile */}
      <div className="min-w-0 flex-1 overflow-y-auto md:col-start-2 md:row-start-1 md:overflow-visible">
        <div className="label mb-2">Calendar</div>
        {archiveSpan && (
          <div className="mb-2 text-xs text-ink-400" data-testid="date-archive-span">
            Your archive: {archiveSpan}
          </div>
        )}
        <div
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className="mx-auto w-fit md:mx-0"
        >
          {captionMode === 'day' ? (
            <div data-testid="date-calendar">
              <DayPicker
                mode="range"
                selected={draftRange}
                onSelect={onSelectRange}
                month={month}
                onMonthChange={setMonth}
                numberOfMonths={1}
                showOutsideDays
                classNames={dayPickerClassNames}
                components={{ CaptionLabel: TapCaption }}
              />
            </div>
          ) : captionMode === 'month' ? (
            <DrillGrid
              caption={String(drillYear)}
              onCaption={() => setCaptionMode('year')}
              onBack={() => setCaptionMode('day')}
              captionLabel="Jump to year"
              backLabel="Back to calendar"
              testid="date-month-grid"
            >
              {Array.from({ length: 12 }, (_, m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => pickMonth(m)}
                  className="inline-flex h-11 min-w-[4.5rem] flex-1 items-center justify-center rounded-full text-sm text-ink-700 transition-colors hover:bg-canvas-100 hover:text-accent-700 dark:text-ink-200 dark:hover:bg-white/10"
                >
                  {new Date(drillYear, m, 1).toLocaleDateString(undefined, { month: 'short' })}
                </button>
              ))}
            </DrillGrid>
          ) : (
            <DrillGrid
              caption={`${earliestYear} - ${latestYear}`}
              onCaption={undefined}
              onBack={() => setCaptionMode('month')}
              captionLabel=""
              backLabel="Back to months"
              testid="date-year-grid"
            >
              {yearsList(earliestYear, latestYear).map((y) => {
                const count = countsByYear.get(y) ?? 0;
                return (
                  <button
                    key={y}
                    type="button"
                    onClick={() => pickYear(y)}
                    className="inline-flex h-14 min-w-[4.5rem] flex-1 flex-col items-center justify-center rounded-lg text-sm text-ink-700 transition-colors hover:bg-canvas-100 hover:text-accent-700 dark:text-ink-200 dark:hover:bg-white/10"
                  >
                    <span className="font-semibold">{y}</span>
                    <span className="text-[10px] text-ink-400">{formatNumber(count)}</span>
                  </button>
                );
              })}
            </DrillGrid>
          )}
        </div>

        {/* Single-day toggle */}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSingleDay((v) => !v)}
            aria-pressed={singleDay}
            data-testid="date-single-day-toggle"
            className={`chip whitespace-nowrap ${
              singleDay
                ? 'border-accent-400 bg-accent-100 text-accent-800 dark:border-accent-400/60 dark:bg-accent-500/20 dark:text-accent-100'
                : ''
            }`}
          >
            Single day
          </button>
          <span className="text-xs text-ink-400">
            {singleDay ? 'Tap a day to filter one day' : 'Or tap a day twice for one day'}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div>
            <label className="label">Start</label>
            {isMobile ? (
              <input
                type="date"
                className="input mt-1"
                placeholder="2024-01-15"
                value={startDraft}
                min={dateInputMin}
                max={dateInputMax}
                onChange={(e) => {
                  setStartDraft(e.target.value);
                  if (startErr) setStartErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApply();
                }}
                data-testid="date-start-input"
              />
            ) : (
              <input
                type="text"
                className="input mt-1"
                placeholder="2024-01-15"
                value={startDraft}
                onChange={(e) => {
                  setStartDraft(e.target.value);
                  if (startErr) setStartErr(null);
                }}
                onBlur={() => {
                  if (startDraft.trim() && parseDateInput(startDraft, 'from') === null) {
                    setStartErr("Couldn't read that date");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApply();
                }}
                data-testid="date-start-input"
              />
            )}
            {startErr && <div className="mt-1 text-xs text-red-500">{startErr}</div>}
          </div>
          <div>
            <label className="label">End</label>
            {isMobile ? (
              <input
                type="date"
                className="input mt-1"
                placeholder="2024-02-28"
                value={endDraft}
                min={dateInputMin}
                max={dateInputMax}
                onChange={(e) => {
                  setEndDraft(e.target.value);
                  if (endErr) setEndErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApply();
                }}
                data-testid="date-end-input"
              />
            ) : (
              <input
                type="text"
                className="input mt-1"
                placeholder="2024-02-28"
                value={endDraft}
                onChange={(e) => {
                  setEndDraft(e.target.value);
                  if (endErr) setEndErr(null);
                }}
                onBlur={() => {
                  if (endDraft.trim() && parseDateInput(endDraft, 'to') === null) {
                    setEndErr("Couldn't read that date");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleApply();
                }}
                data-testid="date-end-input"
              />
            )}
            {endErr && <div className="mt-1 text-xs text-red-500">{endErr}</div>}
          </div>
        </div>

        {!isMobile && (
          <div className="mt-2 text-xs text-ink-400">
            Try: <span className="font-mono">2024-01-15</span>,{' '}
            <span className="font-mono">1/15/2024</span>,{' '}
            <span className="font-mono">Jan 15 2024</span>,{' '}
            <span className="font-mono">2024</span>,{' '}
            <span className="font-mono">yesterday</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-canvas-200 pt-3 dark:border-white/10 md:col-span-2 md:col-start-1 md:row-start-2">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={onClear} className="btn-destructive text-xs" data-testid="date-clear">
            Clear
          </button>
          <div className="flex gap-2">
            {onCancel && (
              <button type="button" onClick={onCancel} className="btn-outline text-xs">
                Cancel
              </button>
            )}
            <button type="button" onClick={handleApply} className="btn-primary text-xs" data-testid="date-apply">
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const dayPickerClassNames = {
  root: 'rdp',
  months: 'flex flex-col',
  month: 'space-y-3',
  caption: 'flex items-center justify-center relative px-8',
  caption_label: 'text-sm font-semibold text-ink-900 dark:text-white',
  nav: 'flex items-center justify-between absolute inset-x-0 top-1/2 -translate-y-1/2 px-1',
  nav_button:
    'inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-700 transition-colors hover:bg-canvas-100 dark:text-ink-200 dark:hover:bg-white/10 disabled:opacity-40',
  nav_button_previous: '',
  nav_button_next: '',
  table: 'w-full border-collapse',
  head_row: 'flex',
  head_cell:
    'flex h-8 w-11 items-center justify-center text-[11px] font-medium uppercase text-ink-400',
  row: 'flex w-full mt-2',
  cell: 'h-11 w-11 p-0 text-center text-sm',
  day: 'inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-700 transition-colors hover:bg-canvas-100 dark:text-ink-200 dark:hover:bg-white/10',
  day_today: 'text-accent-600 font-bold dark:text-accent-400',
  day_selected: 'bg-accent-600 text-white hover:bg-accent-700 hover:text-white',
  day_outside: 'text-ink-300 dark:text-ink-500',
  day_disabled: 'opacity-40',
  day_range_middle:
    'rounded-none bg-accent-100 text-accent-800 dark:bg-accent-500/20 dark:text-accent-200',
  day_range_start: 'rounded-r-none bg-accent-600 text-white',
  day_range_end: 'rounded-l-none bg-accent-600 text-white',
  day_hidden: 'invisible',
};

function startOfDayDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addMonths(d: Date, n: number): Date {
  const next = new Date(d);
  next.setMonth(next.getMonth() + n);
  return next;
}

const EMPTY_YEAR_COUNTS = new Map<number, number>();

// Inclusive year list from earliest to latest (clamped to at least one row).
function yearsList(earliest: number, latest: number): number[] {
  const lo = Math.min(earliest, latest);
  const hi = Math.max(earliest, latest);
  const out: number[] = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

// "Nov 2019" style formatting for the archive-span line.
function formatMonthYear(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Shared chrome for the month/year drill-down grids: a caption row (tappable
// to go one level deeper, with a back arrow to return) above a 3-column grid.
function DrillGrid({
  caption,
  onCaption,
  onBack,
  captionLabel,
  backLabel,
  testid,
  children,
}: {
  caption: string;
  onCaption: (() => void) | undefined;
  onBack: () => void;
  captionLabel: string;
  backLabel: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <div className="w-[18rem]" data-testid={testid}>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-canvas-100 dark:text-ink-200 dark:hover:bg-white/10"
          aria-label={backLabel}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13L5 8l5-5" />
          </svg>
        </button>
        {onCaption ? (
          <button
            type="button"
            onClick={onCaption}
            className="rounded text-sm font-semibold text-ink-900 transition-colors hover:text-accent-600 dark:text-white dark:hover:text-accent-400"
            aria-label={captionLabel}
          >
            {caption}
          </button>
        ) : (
          <span className="text-sm font-semibold text-ink-900 dark:text-white">{caption}</span>
        )}
        <span className="h-8 w-8" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-3 gap-1.5">{children}</div>
    </div>
  );
}
