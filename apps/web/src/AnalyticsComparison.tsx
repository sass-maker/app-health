import type { ReactElement } from 'react';

export function AnalyticsComparison({
  current,
  previous,
  label,
  sampled = false,
  unique = false,
}: {
  current: number;
  previous?: number;
  label: string;
  sampled?: boolean;
  unique?: boolean;
}): ReactElement | null {
  if (previous === undefined) return null;
  if (sampled && unique)
    return (
      <p
        aria-label={`${label} comparison`}
        className="mt-2 text-xs leading-5 text-muted-foreground"
      >
        comparison unavailable for sampled unique counts
      </p>
    );
  const change = previous ? ((current - previous) / previous) * 100 : null;
  const text =
    previous === 0
      ? current === 0
        ? 'no change vs previous period'
        : 'no activity in the previous period'
      : change === 0
        ? 'no change vs previous period'
        : Number.isFinite(change)
          ? `${change! > 0 ? '+' : ''}${change!.toLocaleString('en', { maximumFractionDigits: 1 })}% vs previous period`
          : 'change exceeds display range';
  return (
    <p aria-label={`${label} comparison`} className="mt-2 text-xs leading-5 text-muted-foreground">
      {sampled ? 'estimated · ' : ''}
      {text}
    </p>
  );
}
