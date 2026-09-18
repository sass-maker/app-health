import { describe, expect, it } from 'vitest';
import {
  ArchiveSegmentManifestV1,
  ArchiveReplacementProofV1,
  CanonicalAnalyticsFactV1,
  SessionSummaryV1,
  TimeSeriesRollupV1,
} from '../src/timeseries.js';

describe('time-series storage contracts', () => {
  it('keeps canonical page views separate from named product events', () => {
    const base = {
      schema_version: 1,
      event_id: 'df6d2fa1-c91d-4c10-b65f-38c63b05c122',
      batch_id: '97dedbdd-dbf7-48a1-a620-81f0deccbc07',
      event_time: 10,
      ingest_time: 11,
      workspace_id: 'workspace',
      app_id: 'app',
      environment_id: 'production',
      path: '/pricing',
    };
    expect(
      CanonicalAnalyticsFactV1.safeParse({ ...base, product: 'web', kind: 'pageview' }).success,
    ).toBe(true);
    expect(
      CanonicalAnalyticsFactV1.safeParse({
        ...base,
        product: 'product',
        kind: 'event',
        name: 'signup.completed',
      }).success,
    ).toBe(true);
    expect(
      CanonicalAnalyticsFactV1.safeParse({ ...base, product: 'web', kind: 'pageview', name: 'x' })
        .success,
    ).toBe(false);
  });

  it('requires archive manifests to describe ordered facts and replacement lineage', () => {
    const base = {
      schema_version: 1,
      object_key: 'browser-v2/2026/09/13/source.jsonl.gz',
      workspace_id: 'workspace',
      format: 'jsonl-gzip',
      content_sha256: 'a'.repeat(64),
      row_count: 2,
      event_count: 3,
      min_event_at: 10,
      max_event_at: 20,
      uncompressed_bytes: 100,
      compressed_bytes: 60,
      created_at: 30,
      state: 'active',
    };
    expect(ArchiveSegmentManifestV1.safeParse(base).success).toBe(true);
    expect(ArchiveSegmentManifestV1.safeParse({ ...base, min_event_at: 21 }).success).toBe(false);
    expect(ArchiveSegmentManifestV1.safeParse({ ...base, state: 'superseded' }).success).toBe(
      false,
    );
  });

  it('requires verified replacements to carry verification evidence', () => {
    const base = {
      schema_version: 1,
      source_key: 'browser-v2/2026/09/13/source.jsonl.gz',
      source_sha256: 'a'.repeat(64),
      source_rows: 2,
      source_events: 3,
      replacement_key: 'analytics/v1/day=2026-09-13/part.parquet',
      replacement_sha256: 'b'.repeat(64),
      replacement_rows: 2,
      replacement_events: 3,
      state: 'verified',
    };
    expect(ArchiveReplacementProofV1.safeParse(base).success).toBe(false);
    expect(ArchiveReplacementProofV1.safeParse({ ...base, verified_at: Date.now() }).success).toBe(
      true,
    );
  });

  it('bounds rollup dimensions and rejects duplicate dimension axes', () => {
    const base = {
      schema_version: 1,
      workspace_id: 'workspace',
      app_id: 'app',
      environment_id: 'production',
      product: 'web',
      resolution: '1h',
      bucket_start: 0,
      metric: 'pageviews',
      count: 12,
    };
    expect(
      TimeSeriesRollupV1.safeParse({
        ...base,
        dimensions: [
          { name: 'country', value: 'IN' },
          { name: 'source', value: 'Reddit' },
        ],
      }).success,
    ).toBe(true);
    expect(
      TimeSeriesRollupV1.safeParse({
        ...base,
        dimensions: [
          { name: 'source', value: 'Reddit' },
          { name: 'source', value: 'X' },
        ],
      }).success,
    ).toBe(false);
  });

  it('retains session facts needed for duration, bounce and exit metrics', () => {
    expect(
      SessionSummaryV1.safeParse({
        schema_version: 1,
        workspace_id: 'workspace',
        app_id: 'app',
        environment_id: 'production',
        session_hash: 'a'.repeat(64),
        started_at: 20,
        ended_at: 10,
        pageviews: 1,
        events: 0,
        entry_path: '/pricing',
        exit_path: '/pricing',
      }).success,
    ).toBe(false);
  });
});
