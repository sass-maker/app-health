import { useId } from 'react';
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
}): JSX.Element {
  const columns: ('pageviews' | 'events')[] = onlyMetric ? [metric] : ['pageviews', 'events'];
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2">
        View chart values
      </summary>
      <div className="max-h-52 overflow-auto rounded-md border">
        <table className="w-full text-left">
          <thead>
            <tr>
              <th className="p-2 font-medium">Interval</th>
              {columns.map((column) => (
                <th key={column} className="p-2 font-medium">
                  {column === 'pageviews' ? 'Page views' : 'Events'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((row) => (
              <tr key={row.timestamp} className="border-t">
                <td className="p-2">{time(row.timestamp)}</td>
                {columns.map((column) => (
                  <td key={column} className="p-2">
                    {row[column]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
}): JSX.Element {
  const id = useId().replace(/:/g, '');
  const label = metric === 'events' ? 'Events' : 'Page views';
  const time = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div>
      <ChartContainer
        config={{ [metric]: { label, color: 'var(--chart-1)' } }}
        className={compact ? 'h-44 w-full aspect-auto' : 'h-64 w-full aspect-auto'}
      >
        <AreaChart
          accessibilityLayer
          data={series}
          margin={{ left: 0, right: 12, top: 10, bottom: 0 }}
        >
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.015} />
            </linearGradient>
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
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill={`url(#${id})`}
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
