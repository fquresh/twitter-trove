import { useMemo, useRef } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import type { TimeSeriesPoint } from '../db/queries/analytics';
import type { Granularity } from '../filters/types';
import { makeChartTooltip } from './ChartTooltip';
import { formatBucket, formatWeekRange } from '../lib/format';

interface Props {
  data: TimeSeriesPoint[];
  granularity: Granularity;
  onDrillDown: (bucket: TimeSeriesPoint) => void;
  highlightedBucket?: string | null;
}

export function TimeSeriesChart({
  data,
  granularity,
  onDrillDown,
  highlightedBucket = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Tooltip needs to know the granularity to render the week range correctly,
  // so build it inline-memoized rather than at module scope.
  const TimeTooltip = useMemo(
    () =>
      makeChartTooltip({
        labelFormat: (raw) =>
          granularity === 'week' ? formatWeekRange(String(raw)) : formatBucket(String(raw)),
        seriesLabel: (k) => (k === 'count' ? 'tweets' : k),
      }),
    [granularity],
  );

  const handleChartClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || data.length === 0) return;

    const rect = containerRef.current.getBoundingClientRect();
    // Margins mirror the BarChart: left=0, right=16. The YAxis is fixed at 40px,
    // so the inner plotting area starts 40px from the SVG's left edge and ends
    // 16px from the right edge.
    const plotLeft = rect.left + 40;
    const plotRight = rect.right - 16;
    const plotWidth = Math.max(plotRight - plotLeft, 1);

    const x = e.clientX - plotLeft;
    const band = plotWidth / data.length;
    const idx = Math.min(Math.max(Math.floor(x / band), 0), data.length - 1);
    onDrillDown(data[idx]);
  };

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-canvas-300 text-sm text-ink-500 dark:border-white/10 dark:text-ink-300">
        No tweets for the current filters.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-48 w-full cursor-pointer md:h-64"
      onClick={handleChartClick}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b: string) => compactLabel(b, granularity)}
            stroke="var(--chart-axis)"
            fontSize={11}
            minTickGap={24}
          />
          <YAxis stroke="var(--chart-axis)" fontSize={11} width={40} />
          <Tooltip
            cursor={{ fill: 'var(--chart-highlight)' }}
            content={<TimeTooltip />}
          />
          <Bar dataKey="count" radius={[6, 6, 0, 0]} isAnimationActive={false} shape={BarShape}>
            {data.map((p, i) => (
              <Cell
                key={i}
                fill={
                  highlightedBucket === p.bucket ? 'var(--chart-highlight)' : 'var(--chart-accent)'
                }
                opacity={highlightedBucket && highlightedBucket !== p.bucket ? 0.35 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function compactLabel(bucket: string, g: Granularity): string {
  if (g === 'day') return bucket.slice(5);
  if (g === 'month') return bucket;
  if (g === 'week') return formatWeekRange(bucket);
  return bucket;
}

// Stable custom shape: it exists solely so Playwright tests can read the
// bucket from a bar element. Click handling is performed by the chart container
// using pointer coordinates, which avoids the overlapping hit-area problem that
// made per-bar invisible rects unreliable on narrow mobile buckets.
function BarShape(props: any) {
  const { x, y, width, height, payload, fill } = props;
  return (
    <path
      d={roundedTopRectPath(x, y, width, height, 6)}
      fill={fill}
      className="recharts-bar-rectangle"
      data-bucket={payload.bucket}
    />
  );
}

function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, Math.max(h, 0) / 2);
  if (h <= 0 || w <= 0) return '';
  if (radius <= 0) {
    return `M ${x} ${y} h ${w} v ${h} h -${w} z`;
  }
  return `M ${x} ${y + radius} A ${radius} ${radius} 0 0 1 ${x + radius} ${y} L ${x + w - radius} ${y} A ${radius} ${radius} 0 0 1 ${x + w} ${y + radius} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
}
