import {
  LATENCY_HISTOGRAM_BUCKETS,
  LATENCY_BUCKET_BOUNDS_MS,
  type EventV1,
  type Runtime,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import { histogramIndex } from './in-memory-adapter.js';

type EndpointMeasurement = EventV1 & { upstream_sampled?: boolean };

export interface DurableEndpointWriter {
  accept(
    appId: string,
    envId: string,
    runtime: Runtime,
    release: string | undefined,
    events: readonly EndpointMeasurement[],
    options: { now: number; batchId?: string },
  ): Promise<readonly EndpointMeasurement[]>;
}

const RESOLUTIONS = [60_000, 3_600_000, 86_400_000];
const HISTOGRAM = Array.from({ length: LATENCY_HISTOGRAM_BUCKETS }, (_, i) => `h${i}`);
// The JSON input exists only for the transaction. Only aggregates and bounded
// dedupe receipts are stored. Each SELECT sees the receipts from before this
// transaction; receipt insertion is last so all resolutions see the same facts.
const UNSEEN = `WITH input AS (
  SELECT value AS event FROM json_each(?1)
), unseen AS (
  SELECT event FROM input WHERE NOT EXISTS (
    SELECT 1 FROM endpoint_receipts
    WHERE app_id = ?2 AND environment_id = ?3
      AND receipt_id = json_extract(event, '$.id')
  )
)`;

function rollupSql(resolution: number): string {
  const histograms = HISTOGRAM.map((_, i) => `SUM(json_extract(event, '$.histogram') = ${i})`);
  const updates = ['request_count', 'error_count', 'duration_sum_ms', ...HISTOGRAM].map(
    (name) => `${name} = endpoint_rollups.${name} + excluded.${name}`,
  );
  return `${UNSEEN}
    INSERT INTO endpoint_rollups (
      app_id, environment_id, resolution_ms, bucket_start, method, route, runtime, release, histogram_bounds_ms,
      request_count, error_count, duration_sum_ms, last_seen, upstream_sampled, ${HISTOGRAM.join(',')}
    ) SELECT ?2, ?3, ${resolution},
      CAST(json_extract(event, '$.timestamp') / ${resolution} AS INTEGER) * ${resolution},
      json_extract(event, '$.method'), json_extract(event, '$.route'),
      json_extract(event, '$.runtime'), json_extract(event, '$.release'), '${JSON.stringify(LATENCY_BUCKET_BOUNDS_MS)}',
      COUNT(*), SUM(json_extract(event, '$.error')), SUM(json_extract(event, '$.duration')),
      MAX(json_extract(event, '$.timestamp')), MAX(json_extract(event, '$.sampled')),
      ${histograms.join(',')}
    FROM unseen WHERE 1 GROUP BY 4, 5, 6, 7, 8
    ON CONFLICT (app_id, environment_id, resolution_ms, bucket_start, method, route, runtime, release, histogram_bounds_ms)
    DO UPDATE SET ${updates.join(',')},
      last_seen = MAX(endpoint_rollups.last_seen, excluded.last_seen),
      upstream_sampled = MAX(endpoint_rollups.upstream_sampled, excluded.upstream_sampled)`;
}
const ROLLUP_SQL = RESOLUTIONS.map(rollupSql);

/** D1 batch() is one transaction: receipt and every aggregate commit or roll back together. */
export class D1EndpointWriter implements DurableEndpointWriter {
  constructor(private readonly db: D1DatabaseLike) {}

  async accept(
    appId: string,
    envId: string,
    runtime: Runtime,
    release: string | undefined,
    events: readonly EndpointMeasurement[],
    options: { now: number; batchId?: string },
  ): Promise<readonly EndpointMeasurement[]> {
    const { now, batchId } = options;
    if (!events.length) return [];
    const unique =
      batchId === undefined
        ? [...new Map(events.map((event) => [event.event_id, event])).values()]
        : events;
    const receipt = (event: EndpointMeasurement) =>
      batchId === undefined ? `otel:${event.event_id}` : `sdk:${batchId}`;
    const payload = JSON.stringify(
      unique.map((event) => ({
        id: receipt(event),
        timestamp: event.timestamp,
        method: event.method,
        route: event.route,
        runtime,
        release: event.release ?? release ?? '',
        error: Number(event.status_code >= 500),
        duration: event.duration_ms,
        histogram: histogramIndex(event.duration_ms),
        sampled: Number(event.upstream_sampled === true),
      })),
    );
    const bind = (sql: string) => this.db.prepare(sql).bind(payload, appId, envId);
    const results = await this.db.batch([
      bind(`${UNSEEN} SELECT DISTINCT json_extract(event, '$.id') AS id FROM unseen`),
      ...ROLLUP_SQL.map(bind),
      this.db
        .prepare(
          `${UNSEEN} INSERT INTO endpoint_receipts (app_id, environment_id, receipt_id, seen_at)
        SELECT DISTINCT ?2, ?3, json_extract(event, '$.id'), ?4 FROM unseen WHERE 1
        ON CONFLICT DO NOTHING`,
        )
        .bind(payload, appId, envId, now),
    ]);
    if (results.some((result) => !result.success) || !results[0]?.results)
      throw new Error('Endpoint aggregate transaction did not return durable receipts');
    const accepted = new Set(results[0].results.map((row) => row.id));
    return unique.filter((event) => accepted.has(receipt(event)));
  }

  async cleanupReceipts(now: number): Promise<void> {
    // Ingest rejects events outside five minutes, so a 24-hour receipt is safely
    // older than any valid retry. Aggregate history has no age-based deletion.
    await this.db
      .prepare(
        `DELETE FROM endpoint_receipts WHERE rowid IN (
      SELECT rowid FROM endpoint_receipts WHERE seen_at < ? ORDER BY seen_at LIMIT 10000
    )`,
      )
      .bind(now - 86_400_000)
      .run();
  }
}
