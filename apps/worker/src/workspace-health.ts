import {
  LATENCY_BUCKET_BOUNDS_MS,
  WINDOW_MS,
  WorkspaceHealthSummaryV1,
  approximatePercentiles,
  healthState,
  type BucketV1,
  type CapabilityState,
  type Runtime,
  type WorkspaceEndpointStateV1,
  type WorkspaceHealthEnvironmentV1,
  type WorkspaceHealthSummaryV1 as WorkspaceHealthSummary,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import { endpointReadRanges } from './endpoint-read.js';
import type { WorkspaceHealthRepository } from './repository.js';

const HISTOGRAM = Array.from(
  { length: LATENCY_BUCKET_BOUNDS_MS.length + 1 },
  (_, index) => `h${index}`,
);
const MAX_ENVIRONMENTS = 1000;
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

interface EnvironmentMetadata {
  app_id: string;
  app_name: string;
  environment_id: string;
  environment_name: string;
  runtime: Runtime | null;
  has_active_key: number;
  analytics_enabled: number | null;
  analytics_first_received_at: number | null;
  analytics_last_received_at: number | null;
  endpoints_enabled: number | null;
  endpoints_first_received_at: number | null;
  endpoints_last_received_at: number | null;
}

interface WorkspaceMetricRow extends Record<string, unknown> {
  app_id: string;
  environment_id: string;
  histogram_bounds_ms: string;
  request_count: number;
  error_count: number;
  last_seen: number;
  upstream_sampled: number;
}

export function workspaceEndpointState(
  enabled: boolean,
  firstReceivedAt: number | null,
  lastReceivedAt: number | null,
  hasActiveKey: boolean,
  now: number,
): WorkspaceEndpointStateV1 {
  if (!hasActiveKey && firstReceivedAt !== null) return 'revoked';
  if (!enabled && firstReceivedAt === null && !hasActiveKey) return 'unconfigured';
  if (lastReceivedAt === null) return 'waiting';
  return now - lastReceivedAt > STALE_THRESHOLD_MS ? 'stale' : 'connected';
}

function capability(
  enabled: number | null,
  firstReceivedAt: number | null,
  lastReceivedAt: number | null,
) {
  return {
    enabled: Boolean(enabled),
    first_received_at: firstReceivedAt,
    last_received_at: lastReceivedAt,
  };
}

function metricsFromBucket(bucket: BucketV1) {
  if (bucket.request_count === 0) return null;
  const errorRate = bucket.error_count / bucket.request_count;
  const { p95_ms } = approximatePercentiles(bucket.histogram);
  return {
    request_count: bucket.request_count,
    error_count: bucket.error_count,
    error_rate: errorRate,
    p95_ms,
    last_seen: bucket.last_seen,
    health_state: healthState({
      request_count: bucket.request_count,
      error_rate: errorRate,
      p95_ms,
    }),
    ...(bucket.upstream_sampled ? { upstream_sampled: true } : {}),
  };
}

export function buildWorkspaceHealthSummary(
  metadata: readonly EnvironmentMetadata[],
  buckets: readonly BucketV1[],
  now: number,
  windowEnd: number,
): WorkspaceHealthSummary {
  const byEnvironment = new Map<string, BucketV1>();
  for (const bucket of buckets) {
    const key = `${bucket.app_id}\u0000${bucket.environment_id}`;
    const existing = byEnvironment.get(key);
    if (!existing) {
      byEnvironment.set(key, { ...bucket, histogram: [...bucket.histogram] });
      continue;
    }
    existing.request_count += bucket.request_count;
    existing.error_count += bucket.error_count;
    existing.duration_sum_ms += bucket.duration_sum_ms;
    existing.last_seen = Math.max(existing.last_seen ?? 0, bucket.last_seen ?? 0) || null;
    existing.upstream_sampled ||= bucket.upstream_sampled;
    for (let index = 0; index < existing.histogram.length; index += 1)
      existing.histogram[index] += bucket.histogram[index];
  }
  return WorkspaceHealthSummaryV1.parse({
    refreshed_at: now,
    window_end: windowEnd,
    window: '24h',
    environments: metadata.map((row): WorkspaceHealthEnvironmentV1 => ({
      app_id: row.app_id,
      app_name: row.app_name,
      environment_id: row.environment_id,
      environment_name: row.environment_name,
      analytics: capability(
        row.analytics_enabled,
        row.analytics_first_received_at,
        row.analytics_last_received_at,
      ),
      endpoints: {
        state: workspaceEndpointState(
          Boolean(row.endpoints_enabled),
          row.endpoints_first_received_at,
          row.endpoints_last_received_at,
          Boolean(row.has_active_key),
          now,
        ),
        runtime: row.runtime,
        first_received_at: row.endpoints_first_received_at,
        last_received_at: row.endpoints_last_received_at,
        metrics: metricsFromBucket(
          byEnvironment.get(`${row.app_id}\u0000${row.environment_id}`) ?? {
            app_id: row.app_id,
            environment_id: row.environment_id,
            bucket_start: windowEnd - WINDOW_MS['24h'],
            method: 'ALL',
            route: '*',
            request_count: 0,
            error_count: 0,
            duration_sum_ms: 0,
            last_seen: null,
            histogram: new Array<number>(HISTOGRAM.length).fill(0),
          },
        ),
      },
    })),
  });
}

export class D1WorkspaceHealth implements WorkspaceHealthRepository {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly workspaceId?: string | null,
  ) {}

  async queryWorkspaceHealth(now: number): Promise<WorkspaceHealthSummary> {
    const windowEnd = Math.floor(now / 60_000) * 60_000;
    const from = windowEnd - WINDOW_MS['24h'];
    const metadata = await this.readMetadata();
    const buckets = await this.readMetrics(from, windowEnd);
    return buildWorkspaceHealthSummary(metadata, buckets, now, windowEnd);
  }

  private scope(joinAlias = 'a') {
    if (typeof this.workspaceId === 'string')
      return {
        join: `JOIN workspace_apps wa ON wa.app_id = ${joinAlias}.id`,
        predicate: 'wa.workspace_id = ?',
        values: [this.workspaceId] as unknown[],
      };
    if (this.workspaceId === null)
      return {
        join: '',
        predicate: `NOT EXISTS (SELECT 1 FROM workspace_apps wa WHERE wa.app_id = ${joinAlias}.id)`,
        values: [] as unknown[],
      };
    return { join: '', predicate: '1 = 1', values: [] as unknown[] };
  }

  private async readMetadata(): Promise<EnvironmentMetadata[]> {
    const scope = this.scope();
    const result = await this.db
      .prepare(
        `SELECT a.id AS app_id, a.name AS app_name, e.id AS environment_id,
          e.name AS environment_name, i.runtime,
          CASE WHEN EXISTS (
            SELECT 1 FROM keys k WHERE k.app_id = a.id AND k.environment_id = e.id AND k.revoked_at IS NULL
          ) OR EXISTS (
            SELECT 1 FROM product_keys pk WHERE pk.app_id = a.id AND pk.revoked_at IS NULL
          ) THEN 1 ELSE 0 END AS has_active_key,
          ac.enabled AS analytics_enabled,
          ac.first_received_at AS analytics_first_received_at,
          ac.last_received_at AS analytics_last_received_at,
          ec.enabled AS endpoints_enabled,
          ec.first_received_at AS endpoints_first_received_at,
          ec.last_received_at AS endpoints_last_received_at
        FROM apps a
        ${scope.join}
        JOIN environments e ON e.app_id = a.id
        LEFT JOIN installation_status i ON i.app_id = a.id AND i.environment_id = e.id
        LEFT JOIN environment_capabilities ac ON ac.app_id = a.id AND ac.environment_id = e.id AND ac.capability = 'analytics'
        LEFT JOIN environment_capabilities ec ON ec.app_id = a.id AND ec.environment_id = e.id AND ec.capability = 'endpoints'
        WHERE a.archived_at IS NULL AND ${scope.predicate}
        ORDER BY a.name, e.name LIMIT ${MAX_ENVIRONMENTS + 1}`,
      )
      .bind(...scope.values)
      .all<EnvironmentMetadata>();
    if (result.results.length > MAX_ENVIRONMENTS)
      throw new Error('Workspace health exceeded environment limit');
    return result.results;
  }

  private async readMetrics(from: number, to: number): Promise<BucketV1[]> {
    const scope = this.scope();
    const ranges = endpointReadRanges(from, to);
    const values: unknown[] = [];
    const rangeRows = ranges.map((range) => {
      values.push(range.resolution, range.from, range.to);
      return '(?, ?, ?)';
    });
    values.push(...scope.values);
    const result = await this.db
      .prepare(
        `WITH ranges(resolution_ms, range_from, range_to) AS (VALUES ${rangeRows.join(',')})
        SELECT r.app_id, r.environment_id, r.histogram_bounds_ms,
          SUM(r.request_count) AS request_count,
          SUM(r.error_count) AS error_count,
          MAX(r.last_seen) AS last_seen,
          MAX(r.upstream_sampled) AS upstream_sampled,
          ${HISTOGRAM.map((name) => `SUM(r.${name}) AS ${name}`).join(',')}
        FROM endpoint_rollups r
        JOIN ranges q ON q.resolution_ms = r.resolution_ms
          AND r.bucket_start >= q.range_from AND r.bucket_start < q.range_to
        JOIN apps a ON a.id = r.app_id
        ${scope.join}
        WHERE a.archived_at IS NULL AND ${scope.predicate}
        GROUP BY r.app_id, r.environment_id, r.histogram_bounds_ms
        ORDER BY r.app_id, r.environment_id LIMIT ${MAX_ENVIRONMENTS + 1}`,
      )
      .bind(...values)
      .all<WorkspaceMetricRow>();
    if (result.results.length > MAX_ENVIRONMENTS)
      throw new Error('Workspace health metrics exceeded environment limit');
    return result.results.map((row) => {
      if (row.histogram_bounds_ms !== JSON.stringify(LATENCY_BUCKET_BOUNDS_MS))
        throw new Error('Unsupported endpoint histogram schema');
      const histogram = HISTOGRAM.map((name) => Number(row[name]));
      const requestCount = Number(row.request_count);
      const errorCount = Number(row.error_count);
      const lastSeen = Number(row.last_seen);
      if (
        ![requestCount, errorCount, lastSeen, ...histogram].every(Number.isSafeInteger) ||
        requestCount < 0 ||
        errorCount < 0 ||
        errorCount > requestCount ||
        histogram.some((value) => value < 0) ||
        histogram.reduce((sum, value) => sum + value, 0) !== requestCount
      )
        throw new Error('Invalid workspace endpoint aggregate');
      return {
        app_id: row.app_id,
        environment_id: row.environment_id,
        bucket_start: from,
        method: 'ALL',
        route: '*',
        request_count: requestCount,
        error_count: errorCount,
        duration_sum_ms: 0,
        last_seen: lastSeen,
        histogram,
        ...(Number(row.upstream_sampled) > 0 ? { upstream_sampled: true } : {}),
      };
    });
  }
}

export function memoryEnvironmentMetadata(input: {
  appId: string;
  appName: string;
  environmentId: string;
  environmentName: string;
  runtime: Runtime | null;
  hasActiveKey: boolean;
  capabilities: readonly CapabilityState[];
}): EnvironmentMetadata {
  const analytics = input.capabilities.find((row) => row.id === 'analytics');
  const endpoints = input.capabilities.find((row) => row.id === 'endpoints');
  return {
    app_id: input.appId,
    app_name: input.appName,
    environment_id: input.environmentId,
    environment_name: input.environmentName,
    runtime: input.runtime,
    has_active_key: input.hasActiveKey ? 1 : 0,
    analytics_enabled: analytics?.enabled ? 1 : 0,
    analytics_first_received_at: analytics?.first_received_at ?? null,
    analytics_last_received_at: analytics?.last_received_at ?? null,
    endpoints_enabled: endpoints?.enabled ? 1 : 0,
    endpoints_first_received_at: endpoints?.first_received_at ?? null,
    endpoints_last_received_at: endpoints?.last_received_at ?? null,
  };
}
