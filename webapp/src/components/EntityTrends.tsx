import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EntityTrendPoint } from '../db/queries/analytics';
import { makeChartTooltip } from './ChartTooltip';
import { useIsMobile } from '../lib/useIsMobile';

const EntityTooltip = makeChartTooltip();

interface Props {
  data: EntityTrendPoint[];
  onSelect: (value: string) => void;
}

const DESKTOP_PALETTE = [
  '#7c3aed',
  '#a78bfa',
  '#06b6d4',
  '#22d3ee',
  '#ec4899',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#6366f1',
];

const IOS_PALETTE = [
  '#007aff',
  '#34c759',
  '#af52de',
  '#ff9500',
  '#ff2d55',
  '#5ac8fa',
  '#ffcc00',
  '#5856d6',
];

export function EntityTrends({ data, onSelect }: Props) {
  const isMobile = useIsMobile();
  const palette = isMobile ? IOS_PALETTE : DESKTOP_PALETTE;
  const { rows, series } = useMemo(() => pivot(data), [data]);

  if (rows.length === 0 || series.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-ink-500 dark:text-ink-300">
        No entities detected for the current filters.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="h-48 w-full md:h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="bucket" stroke="var(--chart-axis)" fontSize={11} minTickGap={24} />
            <YAxis stroke="var(--chart-axis)" fontSize={11} width={40} />
            <Tooltip
              cursor={{ fill: 'var(--chart-highlight)' }}
              content={<EntityTooltip />}
            />
            {series.map((s, i) => (
              <Area
                key={s}
                type="monotone"
                dataKey={s}
                stackId="1"
                stroke={palette[i % palette.length]}
                fill={palette[i % palette.length]}
                fillOpacity={0.45}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {series.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => onSelect(s)}
            className="chip"
            style={{ borderColor: palette[i % palette.length] + '55' }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: palette[i % palette.length] }}
            />
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function pivot(points: EntityTrendPoint[]): {
  rows: Array<Record<string, number | string>>;
  series: string[];
} {
  const seriesSet = new Set<string>();
  const map = new Map<string, Record<string, number | string>>();
  for (const p of points) {
    seriesSet.add(p.value);
    let row = map.get(p.bucket);
    if (!row) {
      row = { bucket: p.bucket };
      map.set(p.bucket, row);
    }
    row[p.value] = p.count;
  }
  const series = Array.from(seriesSet).sort();
  const rows = Array.from(map.values()).sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  );
  // Make sure every series has a value at every bucket so stacks are clean.
  for (const row of rows) {
    for (const s of series) if (row[s] === undefined) row[s] = 0;
  }
  return { rows, series };
}
