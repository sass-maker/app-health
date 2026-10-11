import { DataTable, type DataColumn } from './components/ResourceTable.js';
import { EmptyState } from '@saas-maker/ui/components/empty-state';
import { useId, type ReactElement } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { BrowserReport } from '@app-health/contracts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from './components/ui/chart.js';

function ChartValues({
  series,
  time,
  metric,
  onlyMetric,
}: {
  series: BrowserReport['series'];
  time: (timestamp: number) => string;
  metric: 'pageviews' | 'events';
  onlyMetric: boolean;
}): ReactElement {
  const columns: ('pageviews' | 'events')[] = onlyMetric ? [metric] : ['pageviews', 'events'];
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2">
        view chart values
      </summary>
      <DataTable
        data={series}
        columns={[
          {
            id: 'timestamp',
            header: 'interval',
            value: (row) => row.timestamp,
            cell: (row) => time(row.timestamp),
            sortable: false,
            hideable: false,
            minWidth: '6rem',
          },
          ...columns.map((column): DataColumn<BrowserReport['series'][number]> => ({
            id: column,
            header: column === 'pageviews' ? 'page views' : 'events',
            value: (row) => row[column],
            cell: (row) => row[column],
            sortable: false,
            hideable: false,
            align: 'right',
            minWidth: '5rem',
          })),
        ]}
        getRowId={(row) => String(row.timestamp)}
        label="Chart values"
        pageSize={Math.max(1, series.length)}
        maxHeight="13rem"
        className="gap-0 [&>div:first-child]:hidden"
        empty={<EmptyState title="no activity in this period." className="py-8" />}
      />
    </details>
  );
}

export function AnalyticsChart({
  series,
  metric = 'pageviews',
  compact = false,
  onlyMetric = false,
}: {
  series: BrowserReport['series'];
  metric?: 'pageviews' | 'events';
  compact?: boolean;
  onlyMetric?: boolean;
}): ReactElement {
  const id = useId().replace(/:/g, '');
  const label = metric === 'events' ? 'events' : 'page views';
  const color = metric === 'events' ? 'var(--chart-4)' : 'var(--chart-1)';
  const multiDay =
    series.length > 1 && series[series.length - 1].timestamp - series[0].timestamp > 86_400_000;
  const time = (timestamp: number) =>
    multiDay
      ? new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div>
      <ChartContainer
        config={{ [metric]: { label, color } }}
        className={compact ? 'h-44 w-full aspect-auto' : 'h-64 w-full aspect-auto'}
      >
        <AreaChart
          accessibilityLayer
          data={series}
          margin={{ left: 0, right: 12, top: 10, bottom: 0 }}
        >
          <defs>
            <EvilAreaFill id={id} color={color} />
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          {!compact ? (
            <>
              <XAxis
                dataKey="timestamp"
                tickFormatter={time}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                minTickGap={45}
                tickMargin={12}
              />
              <YAxis
                tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={36}
                allowDecimals={false}
                tickMargin={8}
              />
            </>
          ) : null}
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => time(Number(payload[0]?.payload.timestamp))}
                indicator="line"
              />
            }
          />
          <Area
            type="monotone"
            dataKey={metric}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${id})`}
            dot={{ r: 2, fill: color, stroke: 'var(--background)', strokeWidth: 1 }}
            activeDot={{ r: 4, fill: color, stroke: 'var(--background)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
      {!compact ? (
        <ChartValues series={series} time={time} metric={metric} onlyMetric={onlyMetric} />
      ) : null}
    </div>
  );
}

// Selectively adapted from Evil Charts GradientPattern (MIT).
// Pinned source and retained license: docs/frontend-redesign-evidence.md.
function EvilAreaFill({ id, color }: { id: string; color: string }): ReactElement {
  return (
    <>
      <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="white" stopOpacity={0.24} />
        <stop offset="100%" stopColor="white" stopOpacity={0} />
      </linearGradient>
      <mask id={`${id}-mask`}>
        <rect width="100%" height="100%" fill={`url(#${id}-fade)`} />
      </mask>
      <pattern id={id} patternUnits="userSpaceOnUse" width="100%" height="100%">
        <rect width="100%" height="100%" fill={color} mask={`url(#${id}-mask)`} />
      </pattern>
    </>
  );
}
