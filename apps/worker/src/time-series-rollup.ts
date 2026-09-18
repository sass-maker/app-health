import type { RollupDimension, TimeSeriesResolution } from '@app-health/contracts';

const RESOLUTION_MS: Record<TimeSeriesResolution, number> = {
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export function selectTimeSeriesResolution(
  from: number,
  to: number,
  maximumPoints = 240,
): TimeSeriesResolution {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    throw new Error('invalid time-series range');
  if (!Number.isInteger(maximumPoints) || maximumPoints < 1 || maximumPoints > 1000)
    throw new Error('invalid graph point budget');
  const duration = to - from;
  if (duration <= RESOLUTION_MS['5m'] * maximumPoints) return '5m';
  if (duration <= RESOLUTION_MS['1h'] * maximumPoints) return '1h';
  return '1d';
}

export function timeSeriesBucketStart(timestamp: number, resolution: TimeSeriesResolution): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('invalid event time');
  const width = RESOLUTION_MS[resolution];
  return Math.floor(timestamp / width) * width;
}

export type HistogramState = {
  schema: string;
  bins: readonly number[];
};

export function mergeHistograms(left: HistogramState, right: HistogramState): number[] {
  if (
    !left.schema ||
    left.schema !== right.schema ||
    left.bins.length !== right.bins.length ||
    left.bins.length === 0 ||
    left.bins.length > 64
  )
    throw new Error('incompatible histograms');
  return left.bins.map((value, index) => {
    const other = right.bins[index];
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(other) || other < 0)
      throw new Error('invalid histogram count');
    const merged = value + other;
    if (!Number.isSafeInteger(merged)) throw new Error('histogram count overflow');
    return merged;
  });
}

export function rollupDimensionKey(dimensions: readonly RollupDimension[]): string {
  if (dimensions.length > 2) throw new Error('rollup dimension family exceeds two axes');
  const ordered = [...dimensions].sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(ordered.map((dimension) => dimension.name)).size !== ordered.length)
    throw new Error('rollup dimension axes must be unique');
  return JSON.stringify(ordered.map(({ name, value }) => [name, value]));
}
