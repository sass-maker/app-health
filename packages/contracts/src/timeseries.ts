import { z } from 'zod';
import { BrowserAttribution } from './browser.js';

const ArchiveKey = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith('/') && !value.includes('..'));
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const AnalyticsProductV1 = z.enum(['web', 'product', 'api', 'logs']);
export type AnalyticsProduct = z.infer<typeof AnalyticsProductV1>;

export const TimeSeriesResolutionV1 = z.enum(['5m', '1h', '1d']);
export type TimeSeriesResolution = z.infer<typeof TimeSeriesResolutionV1>;

export const CanonicalAnalyticsFactV1 = z
  .object({
    schema_version: z.literal(1),
    event_id: z.string().uuid(),
    batch_id: z.string().uuid(),
    event_time: z.number().int().nonnegative(),
    ingest_time: z.number().int().nonnegative(),
    workspace_id: z.string().min(1).max(100),
    app_id: z.string().min(1).max(100),
    environment_id: z.string().min(1).max(100),
    product: z.enum(['web', 'product']),
    kind: z.enum(['pageview', 'event']),
    path: z.string().startsWith('/').max(256),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_.:-]{0,63}$/)
      .optional(),
    session_hash: Sha256.optional(),
    visitor_hash: Sha256.optional(),
    visit_type: z.enum(['new', 'returning']).optional(),
    attribution: BrowserAttribution.optional(),
    channel: z.string().max(100).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    device: z.enum(['Desktop', 'Mobile', 'Tablet', 'Unknown']).optional(),
    browser: z.enum(['Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Unknown']).optional(),
  })
  .strict()
  .superRefine((fact, context) => {
    if ((fact.kind === 'event') !== (fact.name !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'named product facts and page views must remain distinct',
      });
  });
export type CanonicalAnalyticsFact = z.infer<typeof CanonicalAnalyticsFactV1>;

export const ArchiveSegmentManifestV1 = z
  .object({
    schema_version: z.literal(1),
    object_key: ArchiveKey,
    workspace_id: z.string().min(1).max(100),
    format: z.enum(['jsonl-gzip', 'parquet-iceberg']),
    content_sha256: Sha256,
    row_count: z.number().int().positive(),
    event_count: z.number().int().positive(),
    min_event_at: z.number().int().nonnegative(),
    max_event_at: z.number().int().nonnegative(),
    uncompressed_bytes: z.number().int().positive(),
    compressed_bytes: z.number().int().positive(),
    created_at: z.number().int().nonnegative(),
    state: z.enum(['active', 'replacement-written', 'superseded']),
    replacement_key: ArchiveKey.optional(),
    verified_at: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.max_event_at < manifest.min_event_at)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid event-time range' });
    if (manifest.state !== 'active' && manifest.replacement_key === undefined)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'replacement key required' });
    if (manifest.state === 'superseded' && manifest.verified_at === undefined)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'verified_at required' });
  });
export type ArchiveSegmentManifest = z.infer<typeof ArchiveSegmentManifestV1>;

export const ArchiveReplacementProofV1 = z
  .object({
    schema_version: z.literal(1),
    source_key: ArchiveKey,
    source_sha256: Sha256,
    source_rows: z.number().int().positive(),
    source_events: z.number().int().positive(),
    replacement_key: ArchiveKey,
    replacement_sha256: Sha256,
    replacement_rows: z.number().int().positive(),
    replacement_events: z.number().int().positive(),
    state: z.enum(['pending', 'written', 'verified']),
    verified_at: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((proof, context) => {
    if (proof.state === 'verified' && proof.verified_at === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verified proof needs verified_at',
      });
  });
export type ArchiveReplacementProof = z.infer<typeof ArchiveReplacementProofV1>;

export const RollupDimensionV1 = z
  .object({
    name: z.enum([
      'route',
      'path',
      'event',
      'country',
      'source',
      'channel',
      'campaign',
      'device',
      'browser',
      'release',
      'status_class',
      'log_level',
      'log_source',
    ]),
    value: z.string().min(1).max(256),
  })
  .strict();
export type RollupDimension = z.infer<typeof RollupDimensionV1>;

export const SparseDistinctSketchV1 = z
  .object({
    schema_version: z.literal(1),
    precision: z.number().int().min(10).max(16),
    encoding: z.enum(['sparse', 'dense']),
    registers: z.string().max(32_768),
  })
  .strict();
export type SparseDistinctSketch = z.infer<typeof SparseDistinctSketchV1>;

export const TimeSeriesRollupV1 = z
  .object({
    schema_version: z.literal(1),
    workspace_id: z.string().min(1).max(100),
    app_id: z.string().min(1).max(100),
    environment_id: z.string().min(1).max(100),
    product: AnalyticsProductV1,
    resolution: TimeSeriesResolutionV1,
    bucket_start: z.number().int().nonnegative(),
    metric: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/),
    dimensions: z.array(RollupDimensionV1).max(2),
    count: z.number().int().nonnegative(),
    sum: z.number().finite().nonnegative().optional(),
    histogram: z.array(z.number().int().nonnegative()).max(64).optional(),
    distinct: SparseDistinctSketchV1.optional(),
  })
  .strict()
  .superRefine((rollup, context) => {
    const names = rollup.dimensions.map((dimension) => dimension.name);
    if (new Set(names).size !== names.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'dimension names must be unique' });
  });
export type TimeSeriesRollup = z.infer<typeof TimeSeriesRollupV1>;

export const SessionSummaryV1 = z
  .object({
    schema_version: z.literal(1),
    workspace_id: z.string().min(1).max(100),
    app_id: z.string().min(1).max(100),
    environment_id: z.string().min(1).max(100),
    session_hash: Sha256,
    visitor_hash: Sha256.optional(),
    started_at: z.number().int().nonnegative(),
    ended_at: z.number().int().nonnegative(),
    pageviews: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    entry_path: z.string().startsWith('/').max(256).optional(),
    exit_path: z.string().startsWith('/').max(256).optional(),
    source: z.string().max(100).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict()
  .refine((summary) => summary.ended_at >= summary.started_at, {
    message: 'session must end at or after it starts',
  });
export type SessionSummary = z.infer<typeof SessionSummaryV1>;
