// V0 worker service layer. Orchestrates the repository interfaces to
// implement app creation, key revocation, authenticated ingest, installation
// status, and endpoint queries. The same service works against the in-memory
// adapter today and a future D1 implementation after deploy approval.

import {
  BUCKET_MS,
  FAILURE_RETENTION_HOURS,
  BROWSER_LOGS_PER_MINUTE,
  LOG_RETENTION_DAYS,
  LogQueryResponseV1,
  defaultLogRoutes,
  routeLogs,
  WINDOW_MS,
  FailureQueryResponseV1,
  InstallationStatusV1,
  MAX_CLOCK_SKEW_MS,
  buildSeedBuckets,
  mergeBuckets,
  validateBatch,
  validateBrowserLogBatch,
  validateLogBatch,
  type CreateAppRequestV1 as CreateAppRequest,
  type CreateAppResponseV1,
  type EndpointQueryResponseV1,
  type EventBatchV1,
  type EventV1,
  type FailureQueryResponseV1 as FailureQueryResponse,
  type KeyRecordV1,
  type ListAppsResponseV1,
  type CreatePublicLogKeyRequestV1,
  type CreatePublicLogKeyResponseV1,
  type LogEventV1,
  type LogLevel,
  type LogRoutesV1,
  type LogSink,
  type LogSource,
  type PublicLogKeyV1,
  type StoredLogV1,
  type Runtime,
  type Window,
} from '@app-health/contracts';
import { SEED_APP_ID, SEED_ENV_ID } from '@app-health/contracts';
import type { AppHealthRepositories } from './repository.js';
import { isErrorStatus } from './in-memory-adapter.js';

/** Result of an ingest attempt. */
export type IngestResult =
  { ok: true; accepted: number; duplicates: number } | { ok: false; status: number; error: string };

/**
 * Result of a log ingest attempt. `sinks` groups the accepted logs by
 * destination after routing; `store` has already been persisted, the others
 * are for the caller to deliver after the response.
 */
export type LogIngestResult =
  | {
      ok: true;
      accepted: number;
      app_id: string;
      environment_id: string;
      source: LogSource;
      sinks: Partial<Record<LogSink, StoredLogV1[]>>;
      duplicates: number;
    }
  | { ok: false; status: number; error: string; details?: string[] };

const QUOTA_WINDOW_MS = 60 * 1000;

export type EndpointEvent = EventV1 & { upstream_sampled?: boolean };
export type OtlpEndpointEvent = EndpointEvent & { environment?: string };

interface ResolvedScope {
  app_id: string;
  environment_id: string;
}

type ScopeResolution =
  { ok: true; scope: ResolvedScope } | { ok: false; status: number; error: string };

/** V0 worker service. Stateless aside from the injected repositories. */
export class AppHealthService {
  constructor(private readonly repos: AppHealthRepositories) {}

  /** Create an app + environment + one-time ingest key. */
  async createApp(request: CreateAppRequest, now: number): Promise<CreateAppResponseV1> {
    if (this.repos.setup) {
      const created = await this.repos.setup.createAppEnvironmentKey(
        request.name,
        request.environment,
        now,
        request.key_scope,
      );
      return {
        app: created.app,
        environment: created.environment,
        key: {
          key: created.rawKey,
          app_id: created.record.app_id,
          environment_id: created.record.environment_id,
          created_at: created.record.created_at,
        },
      };
    }
    const app = await this.repos.apps.createApp(request.name, now);
    const env = await this.repos.environments.createEnvironment(app.id, request.environment, now);
    const { record, rawKey } =
      request.key_scope === 'environment'
        ? await this.repos.keys.createKey(app.id, env.id, now)
        : await this.repos.keys.createProductKey(app.id, now);
    return {
      app,
      environment: env,
      key: {
        key: rawKey,
        app_id: record.app_id,
        environment_id: record.environment_id,
        created_at: record.created_at,
      },
    };
  }

  async listApps(appId?: string): Promise<ListAppsResponseV1> {
    const scopedApp = appId ? await this.repos.apps.getApp(appId) : null;
    const apps = appId ? (scopedApp ? [scopedApp] : []) : await this.repos.apps.listApps();
    return {
      apps: await Promise.all(
        apps.map(async (app) => ({
          app,
          environments: await this.repos.environments.listEnvironments(app.id),
        })),
      ),
    };
  }

  /** Revoke an ingest key by id. */
  async revokeKey(keyId: string, now: number): Promise<void> {
    await this.repos.keys.revokeKey(keyId, now);
  }

  /**
   * Authenticate and process a v1 ingest batch.
   * - Verifies the environment-scoped key (non-reversible SHA-256 lookup).
   * - Validates the schema version and bounded event fields; rejects unknown
   *   unsafe fields rather than stripping them.
   * - Checks per-event clock skew against the server time.
   * - Deduplicates retried SDK batches for a bounded window.
   * - Updates one-minute aggregate buckets only; no raw event is persisted.
   */
  async ingest(rawKey: string, body: unknown, now: number): Promise<IngestResult> {
    const keyRecord = await this.verifyIngestKey(rawKey);
    if (!keyRecord) {
      return {
        ok: false,
        status: 401,
        error: rawKey ? 'invalid or revoked ingest key' : 'missing ingest key',
      };
    }
    const validation = validateBatch(body);
    if (!validation.ok) {
      return { ok: false, status: 400, error: 'invalid v1 batch' };
    }
    const batch: EventBatchV1 = validation.batch;
    this.repos.buckets.validateEvents?.(batch.events, batch.release);
    for (const event of batch.events) {
      if (Math.abs(event.timestamp - now) > MAX_CLOCK_SKEW_MS) {
        return { ok: false, status: 400, error: 'event timestamp outside clock-skew window' };
      }
    }
    const resolution = await this.resolveScope(keyRecord, batch.environment, now);
    if (!resolution.ok) return resolution;
    const scope = resolution.scope;
    const batchId = batch.batch_id ?? (await legacyBatchID(batch));
    const seen = await this.repos.dedupe.markSeen(scope.app_id, scope.environment_id, batchId, now);
    if (!seen) return { ok: true, accepted: 0, duplicates: batch.events.length };
    try {
      return await this.persistEvents(scope, batch.runtime, batch.release, batch.events, 0, now);
    } catch (error) {
      await this.repos.dedupe.forget(scope.app_id, scope.environment_id, batchId);
      throw error;
    }
  }

  /** Resolve one environment-scoped ingest key before decoding an OTLP payload. */
  async verifyIngestKey(rawKey: string): Promise<KeyRecordV1 | null> {
    if (!rawKey) return null;
    return this.repos.keys.verifyKey(rawKey);
  }

  /** Process projected OTLP endpoint events through the shared aggregate path. */
  async ingestEvents(
    keyRecord: KeyRecordV1,
    runtime: Runtime,
    release: string | undefined,
    events: readonly OtlpEndpointEvent[],
    now: number,
  ): Promise<IngestResult> {
    this.repos.buckets.validateEvents?.(events, release);
    for (const event of events) {
      if (Math.abs(event.timestamp - now) > MAX_CLOCK_SKEW_MS) {
        return { ok: false, status: 400, error: 'event timestamp outside clock-skew window' };
      }
    }

    const grouped = new Map<string | undefined, OtlpEndpointEvent[]>();
    for (const event of events) {
      const group = grouped.get(event.environment) ?? [];
      group.push(event);
      grouped.set(event.environment, group);
    }

    const resolvedGroups: { scope: ResolvedScope; events: OtlpEndpointEvent[] }[] = [];
    for (const [environment, groupEvents] of grouped) {
      const resolution = await this.resolveScope(keyRecord, environment, now);
      if (!resolution.ok) return resolution;
      resolvedGroups.push({ scope: resolution.scope, events: groupEvents });
    }

    let accepted = 0;
    let duplicates = 0;
    for (const group of resolvedGroups) {
      const acceptedEvents: EndpointEvent[] = [];
      const acceptedEventIds: string[] = [];
      for (const event of group.events) {
        const seen = await this.repos.dedupe.markSeen(
          group.scope.app_id,
          group.scope.environment_id,
          event.event_id,
          now,
        );
        if (!seen) {
          duplicates += 1;
          continue;
        }
        const { environment: _environment, ...endpointEvent } = event;
        acceptedEvents.push(endpointEvent);
        acceptedEventIds.push(event.event_id);
      }
      try {
        const result = await this.persistEvents(
          group.scope,
          runtime,
          release,
          acceptedEvents,
          duplicates,
          now,
        );
        accepted += result.ok ? result.accepted : 0;
      } catch (error) {
        await Promise.all(
          acceptedEventIds.map((eventId) =>
            this.repos.dedupe.forget(group.scope.app_id, group.scope.environment_id, eventId),
          ),
        );
        throw error;
      }
    }
    return { ok: true, accepted, duplicates };
  }

  private async resolveScope(
    keyRecord: KeyRecordV1,
    requestedEnvironment: string | undefined,
    now: number,
  ): Promise<ScopeResolution> {
    if (keyRecord.environment_id !== null) {
      const environment = await this.repos.environments.getEnvironment(keyRecord.environment_id);
      if (!environment || environment.app_id !== keyRecord.app_id) {
        return { ok: false, status: 401, error: 'invalid ingest key scope' };
      }
      if (requestedEnvironment !== undefined && requestedEnvironment !== environment.name) {
        return {
          ok: false,
          status: 400,
          error: 'environment does not match ingest key scope',
        };
      }
      return {
        ok: true,
        scope: { app_id: keyRecord.app_id, environment_id: environment.id },
      };
    }
    if (!requestedEnvironment) {
      return { ok: false, status: 400, error: 'environment is required for product key' };
    }
    const environment = await this.repos.environments.resolveEnvironment(
      keyRecord.app_id,
      requestedEnvironment,
      now,
    );
    if (!environment) {
      return { ok: false, status: 409, error: 'product environment limit reached' };
    }
    return {
      ok: true,
      scope: { app_id: keyRecord.app_id, environment_id: environment.id },
    };
  }

  private async persistEvents(
    scope: ResolvedScope,
    runtime: Runtime,
    release: string | undefined,
    acceptedEvents: readonly EndpointEvent[],
    duplicates: number,
    now: number,
  ): Promise<IngestResult> {
    await this.repos.inventory?.recordObserved(scope.app_id, scope.environment_id, acceptedEvents);
    await this.repos.failures?.recordFailures(scope.app_id, scope.environment_id, acceptedEvents);
    if (this.repos.buckets.upsertEvents) {
      await this.repos.buckets.upsertEvents(
        scope.app_id,
        scope.environment_id,
        runtime,
        release,
        acceptedEvents,
      );
    } else {
      for (const event of acceptedEvents) await this.applyEvent(scope, event);
    }
    if (acceptedEvents.length > 0) {
      await this.repos.installation.recordIngest(scope.app_id, scope.environment_id, runtime, now);
      await this.repos.capabilities?.recordCapability(
        scope.app_id,
        scope.environment_id,
        'endpoints',
        now,
      );
    }
    return { ok: true, accepted: acceptedEvents.length, duplicates };
  }

  private async applyEvent(scope: ResolvedScope, event: EndpointEvent): Promise<void> {
    const bucketStart = Math.floor(event.timestamp / BUCKET_MS) * BUCKET_MS;
    await this.repos.buckets.upsertBucket({
      app_id: scope.app_id,
      environment_id: scope.environment_id,
      bucket_start: bucketStart,
      method: event.method,
      route: event.route,
      statusIsError: isErrorStatus(event.status_code),
      durationMs: event.duration_ms,
      timestamp: event.timestamp,
      upstreamSampled: event.upstream_sampled,
    });
  }

  /** Read installation status for the setup view. */
  async installationStatus(
    appId: string,
    envId: string,
    now: number,
  ): Promise<InstallationStatusV1> {
    const status = await this.repos.installation.getStatus(appId, envId, now);
    return InstallationStatusV1.parse(status);
  }

  /** Query observed endpoints for a window, scoped to (app_id, environment_id). */
  async queryEndpoints(
    appId: string,
    envId: string,
    window: Window,
    now: number,
  ): Promise<EndpointQueryResponseV1> {
    const from = now - WINDOW_MS[window];
    const buckets = await this.repos.buckets.queryBuckets(appId, envId, from, now);
    // For the seeded demo app, include seeded buckets so the dashboard renders
    // a populated table even before any real ingest traffic.
    if (appId === SEED_APP_ID && envId === SEED_ENV_ID) {
      const seedBuckets = buildSeedBuckets(now);
      const existingKeys = new Set(buckets.map((b) => `${b.bucket_start}|${b.method}|${b.route}`));
      for (const seed of seedBuckets) {
        if (!existingKeys.has(`${seed.bucket_start}|${seed.method}|${seed.route}`)) {
          buckets.push({ ...seed, histogram: [...seed.histogram] });
        }
      }
    }
    const endpoints = mergeBuckets(buckets, window, now);
    const measured = new Set(
      endpoints.map((endpoint) => `${endpoint.method}\u0000${endpoint.route}`),
    );
    for (const observed of (await this.repos.inventory?.listObserved(appId, envId)) ?? []) {
      if (measured.has(`${observed.method}\u0000${observed.route}`)) continue;
      endpoints.push({
        method: observed.method,
        route: observed.route,
        request_count: 0,
        error_count: 0,
        error_rate: 0,
        p50_ms: 0,
        p95_ms: 0,
        last_seen: observed.last_seen,
        health_state: 'insufficient-data',
        metrics_available: false,
      });
    }
    return {
      refreshed_at: now,
      window,
      endpoints,
    };
  }

  /** Query the latest retained 4xx/5xx details for one app environment. */
  /** Server ingest of owner-authored application logs, authenticated with a product ingest key. */
  async ingestLogs(
    rawKey: string,
    body: unknown,
    now: number,
    routes: LogRoutesV1 = defaultLogRoutes(),
  ): Promise<LogIngestResult> {
    const keyRecord = await this.verifyIngestKey(rawKey);
    if (!keyRecord) return { ok: false, status: 401, error: 'invalid or revoked ingest key' };
    const validation = validateLogBatch(body);
    if (!validation.ok) {
      return { ok: false, status: 400, error: 'invalid log batch', details: validation.errors };
    }
    const timestampError = validateLogTimestamps(validation.batch.logs, now);
    if (timestampError) return timestampError;
    const resolution = await this.resolveScope(keyRecord, validation.batch.environment, now);
    if (!resolution.ok) return resolution;
    return this.commitLogs(
      resolution.scope,
      validation.batch.logs,
      'server',
      routes,
      now,
      await logBatchId('server', validation.batch.batch_id, validation.batch.logs),
    );
  }

  /**
   * Browser ingest with a public key carried in the body. The key pins one
   * environment and an origin allowlist; batches are rate limited per key.
   */
  async ingestBrowserLogs(
    body: unknown,
    origin: string | null,
    now: number,
    routes: LogRoutesV1 = defaultLogRoutes(),
  ): Promise<LogIngestResult> {
    const validation = validateBrowserLogBatch(body);
    if (!validation.ok) {
      return {
        ok: false,
        status: 400,
        error: 'invalid browser log batch',
        details: validation.errors,
      };
    }
    const timestampError = validateLogTimestamps(validation.batch.logs, now);
    if (timestampError) return timestampError;
    const key = await this.repos.publicKeys?.verifyPublicKey(validation.batch.public_key);
    if (!key) return { ok: false, status: 401, error: 'invalid or revoked public key' };
    if (!origin || !key.allowed_origins.includes(origin)) {
      return { ok: false, status: 403, error: 'origin not allowed for this key' };
    }
    const environment = await this.repos.environments.getEnvironment(key.environment_id);
    if (!environment) return { ok: false, status: 401, error: 'public key environment missing' };
    if (validation.batch.environment && validation.batch.environment !== environment.name) {
      return { ok: false, status: 400, error: 'environment does not match public key scope' };
    }
    const windowStart = Math.floor(now / QUOTA_WINDOW_MS) * QUOTA_WINDOW_MS;
    const used = await this.repos.publicKeys!.consumeBrowserQuota(
      key.id,
      windowStart,
      validation.batch.logs.length,
    );
    if (used > BROWSER_LOGS_PER_MINUTE) {
      return { ok: false, status: 429, error: 'browser log rate limit exceeded' };
    }
    const scope = { app_id: key.app_id, environment_id: environment.id };
    return this.commitLogs(
      scope,
      validation.batch.logs,
      'browser',
      routes,
      now,
      await logBatchId('browser', validation.batch.batch_id, validation.batch.logs),
    );
  }

  private async commitLogs(
    scope: ResolvedScope,
    logs: readonly LogEventV1[],
    source: LogSource,
    routes: LogRoutesV1,
    now: number,
    batchId: string,
  ): Promise<LogIngestResult> {
    const stored = logs.map((log) => ({ ...log, source }));
    const claimId = `logs:${source}:${batchId}`;
    const claimed = await this.repos.dedupe.markSeen(
      scope.app_id,
      scope.environment_id,
      claimId,
      now,
    );
    if (!claimed)
      return { ok: true, accepted: 0, duplicates: logs.length, ...scope, source, sinks: {} };
    const sinks = routeLogs(stored, routes);
    try {
      if (sinks.store)
        await this.repos.logs?.recordLogs(scope.app_id, scope.environment_id, sinks.store, source);
      if (logs.length)
        await this.repos.capabilities?.recordCapability(
          scope.app_id,
          scope.environment_id,
          'logs',
          now,
        );
      return { ok: true, accepted: logs.length, duplicates: 0, ...scope, source, sinks };
    } catch (error) {
      await this.repos.dedupe.forget(scope.app_id, scope.environment_id, claimId);
      throw error;
    }
  }

  async createPublicKey(
    request: CreatePublicLogKeyRequestV1,
    now: number,
  ): Promise<CreatePublicLogKeyResponseV1 | null> {
    const environment = await this.repos.environments.getEnvironment(request.environment_id);
    if (!environment || environment.app_id !== request.app_id || !this.repos.publicKeys)
      return null;
    const created = await this.repos.publicKeys.createPublicKey(
      request.app_id,
      request.environment_id,
      request.allowed_origins,
      now,
    );
    return { key: created.rawKey, record: created.record };
  }

  async listPublicKeys(appId: string): Promise<PublicLogKeyV1[]> {
    return (await this.repos.publicKeys?.listPublicKeys(appId)) ?? [];
  }

  async revokePublicKey(keyId: string, now: number): Promise<boolean> {
    return (await this.repos.publicKeys?.revokePublicKey(keyId, now)) ?? false;
  }

  async queryLogs(
    appId: string,
    envId: string,
    filters: { level: LogLevel; source?: LogSource; event?: string; limit: number },
    now: number,
  ): Promise<LogQueryResponseV1> {
    const { level, source, event, limit } = filters;
    const logs =
      (await this.repos.logs?.listLogs(appId, envId, {
        minLevel: level,
        source,
        event,
        limit,
        now,
      })) ?? [];
    return LogQueryResponseV1.parse({
      refreshed_at: now,
      level,
      retention_days: LOG_RETENTION_DAYS,
      limit,
      logs,
    });
  }

  async queryFailures(
    appId: string,
    envId: string,
    window: Window,
    limit: number,
    now: number,
  ): Promise<FailureQueryResponse> {
    const failures =
      (await this.repos.failures?.listFailures(appId, envId, now - WINDOW_MS[window], limit)) ?? [];
    return FailureQueryResponseV1.parse({
      refreshed_at: now,
      window,
      retention_hours: FAILURE_RETENTION_HOURS,
      limit,
      failures,
    });
  }
}

async function legacyBatchID(batch: EventBatchV1): Promise<string> {
  const input = batch.events.map((event) => event.event_id).join('\u0000');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `legacy-${hex}`;
}

function validateLogTimestamps(
  logs: readonly LogEventV1[],
  now: number,
): Extract<LogIngestResult, { ok: false }> | null {
  const oldest = now - LOG_RETENTION_DAYS * 86_400_000;
  if (logs.some((log) => log.timestamp > now + MAX_CLOCK_SKEW_MS))
    return { ok: false, status: 400, error: 'log timestamp too far in the future' };
  if (logs.some((log) => log.timestamp < oldest))
    return { ok: false, status: 400, error: 'log timestamp outside retention window' };
  return null;
}

async function logBatchId(
  source: LogSource,
  batchId: string | undefined,
  logs: readonly LogEventV1[],
): Promise<string> {
  if (batchId) return batchId;
  const input = `${source}\u0000${logs.map((log) => log.log_id).join('\u0000')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `legacy-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
