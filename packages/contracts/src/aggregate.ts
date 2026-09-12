// V1 endpoint aggregate and query contracts. Aggregates are derived from
// one-minute buckets; raw request events are never stored or returned.

import { z } from 'zod';
import {
  HEALTH_STATES,
  MAX_METHOD_LENGTH,
  MAX_ROUTE_LENGTH,
  WINDOWS,
  type HealthState,
  type Window,
} from './constants.js';

/** Number of histogram buckets (one per bound plus overflow). */
export const LATENCY_HISTOGRAM_BUCKETS = 16;

/** One-minute aggregate bucket stored by ingest. */
export const BucketV1 = z.object({
  app_id: z.string().min(1),
  environment_id: z.string().min(1),
  bucket_start: z.number().int().min(0),
  method: z.string().min(1).max(MAX_METHOD_LENGTH),
  route: z.string().min(1).max(MAX_ROUTE_LENGTH),
  request_count: z.number().int().min(0),
  error_count: z.number().int().min(0),
  duration_sum_ms: z.number().int().min(0),
  last_seen: z.number().int().min(0).nullable(),
  /** True when any contribution came from a potentially sampled upstream trace stream. */
  upstream_sampled: z.boolean().optional(),
  /** True when the analytics storage sampled contributing measurements. */
  sampled: z.boolean().optional(),
  /** Fixed latency histogram counts aligned with LATENCY_BUCKET_BOUNDS_MS. */
  histogram: z.array(z.number().int().min(0)).length(LATENCY_HISTOGRAM_BUCKETS),
});

export type BucketV1 = z.infer<typeof BucketV1>;

/** Endpoint aggregate returned by the query API for a selected window. */
export const EndpointAggregateV1 = z.object({
  method: z.string().min(1).max(MAX_METHOD_LENGTH),
  route: z.string().min(1).max(MAX_ROUTE_LENGTH),
  request_count: z.number().int().min(0),
  error_count: z.number().int().min(0),
  error_rate: z.number().min(0).max(1),
  p50_ms: z.number().min(0),
  p95_ms: z.number().min(0),
  last_seen: z.number().int().min(0).nullable(),
  health_state: z.enum(HEALTH_STATES) as z.ZodEnum<[HealthState, ...HealthState[]]>,
  /** False when the endpoint inventory survived but WAE sampled out its metrics. */
  metrics_available: z.boolean().optional(),
  /** True when counts and percentiles include trace-derived sampled estimates. */
  upstream_sampled: z.boolean().optional(),
  /** True when the analytics storage sampled contributing measurements. */
  sampled: z.boolean().optional(),
});

export type EndpointAggregateV1 = z.infer<typeof EndpointAggregateV1>;

export const WindowField = z.enum(WINDOWS);
export type WindowField = z.infer<typeof WindowField>;

/** Query request accepted by the endpoint query API. */
export const EndpointQueryRequestV1 = z
  .object({
    app_id: z.string().min(1),
    environment_id: z.string().min(1),
    window: WindowField,
    sort: z.enum(['health', 'requests', 'error_rate', 'p95', 'last_seen']).default('health'),
    sort_dir: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

export type EndpointQueryRequestV1 = z.infer<typeof EndpointQueryRequestV1>;

/** Query response returned by the endpoint query API. */
export const EndpointQueryResponseV1 = z.object({
  refreshed_at: z.number().int().min(0),
  window: z.enum(WINDOWS),
  endpoints: z.array(EndpointAggregateV1),
});

export type EndpointQueryResponseV1 = z.infer<typeof EndpointQueryResponseV1>;

export type WindowKey = Window;
