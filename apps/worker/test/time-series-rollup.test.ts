import { describe, expect, it } from 'vitest';
import {
  mergeHistograms,
  rollupDimensionKey,
  selectTimeSeriesResolution,
  timeSeriesBucketStart,
} from '../src/time-series-rollup.js';

describe('time-series rollup primitives', () => {
  it('selects the finest resolution inside the graph point budget', () => {
    expect(selectTimeSeriesResolution(0, 12 * 60 * 60_000)).toBe('5m');
    expect(selectTimeSeriesResolution(0, 24 * 60 * 60_000)).toBe('1h');
    expect(selectTimeSeriesResolution(0, 7 * 24 * 60 * 60_000)).toBe('1h');
    expect(selectTimeSeriesResolution(0, 30 * 24 * 60 * 60_000)).toBe('1d');
    expect(selectTimeSeriesResolution(0, 365 * 24 * 60 * 60_000)).toBe('1d');
  });

  it('uses stable UTC bucket boundaries', () => {
    expect(timeSeriesBucketStart(Date.UTC(2026, 8, 13, 12, 34), '1h')).toBe(
      Date.UTC(2026, 8, 13, 12),
    );
  });

  it('merges histogram counts before percentile calculation', () => {
    expect(mergeHistograms([1, 2, 0], [3, 0, 4])).toEqual([4, 2, 4]);
    expect(() => mergeHistograms([1], [1, 2])).toThrow('incompatible');
  });

  it('canonicalizes dimension order without allowing a Cartesian cube key', () => {
    expect(
      rollupDimensionKey([
        { name: 'source', value: 'Reddit' },
        { name: 'country', value: 'IN' },
      ]),
    ).toBe('[["country","IN"],["source","Reddit"]]');
    expect(() =>
      rollupDimensionKey([
        { name: 'source', value: 'Reddit' },
        { name: 'source', value: 'X' },
      ]),
    ).toThrow('unique');
  });
});
