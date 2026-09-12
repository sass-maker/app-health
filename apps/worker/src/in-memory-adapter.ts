// Credential-free in-memory implementation of the V0 repository interfaces.
// Used by local development and tests. No D1, no credentials, no production
// resources. The same repository interface is satisfied by a future D1
// implementation in a deploy-approved change.
//
// The seeded app/environment/key/buckets are preloaded so the dashboard has a
// stable demo surface without any ingest traffic. The seed key is clearly
// marked as non-production.

import {
  BUCKET_MS,
  LATENCY_BUCKET_BOUNDS_MS,
  LATENCY_HISTOGRAM_BUCKETS,
  SEED_APP_ID,
  SEED_APP_NAME,
  SEED_ENV_ID,
  SEED_ENV_NAME,
  SEED_KEY,
  SEED_PUBLIC_KEY,
  SEED_PUBLIC_KEY_ORIGINS,
  PUBLIC_LOG_KEY_PREFIX,
  LOG_RETENTION_DAYS,
  buildSeedBuckets,
  type AppV1,
  type BucketV1,
  type EnvironmentV1,
  type EventV1,
  type FailureEventV1,
  type InstallationStatusV1,
  type KeyRecordV1,
  type LogEventV1,
  type LogSource,
  type PublicLogKeyV1,
  type Runtime,
  type StoredLogV1,
  logLevelAtLeast,
} from '@app-health/contracts';
import { MemoryCapabilities } from './capability-store.js';
import { generateRawKey, hashKey } from './crypto.js';
import type {
  AppHealthRepositories,
  AppRepository,
  BucketRepository,
  DedupeRepository,
  EndpointInventoryRepository,
  EnvironmentRepository,
  InstallationRepository,
  KeyRepository,
  LogListQuery,
  LogRepository,
  PublicLogKeyRepository,
} from './repository.js';
import { MAX_ENVIRONMENTS_PER_APP } from './repository.js';

/** Bounded deduplication window for event IDs. */
export const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
/** An environment is stale when no ingest has been seen for this long. */
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

/** A status >= 500 counts as an error in aggregate buckets. */
function isErrorStatus(status: number): boolean {
  return status >= 500;
}

/** Fixed-latency histogram bucket index for a duration in ms. */
export function histogramIndex(durationMs: number): number {
  let idx = 0;
  while (idx < LATENCY_BUCKET_BOUNDS_MS.length && durationMs > LATENCY_BUCKET_BOUNDS_MS[idx]) {
    idx += 1;
  }
  return idx;
}

function emptyHistogram(): number[] {
  return new Array<number>(LATENCY_HISTOGRAM_BUCKETS).fill(0);
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return `${prefix}-${hex}`;
}

interface InstallationRow {
  app_id: string;
  environment_id: string;
  runtime: Runtime | null;
  first_seen: number | null;
  last_seen: number | null;
}

/**
 * In-memory implementation of all V0 repositories. Construct with
 * `InMemoryAdapter.create()` to preload the seeded demo data and compute the
 * seed key verifier asynchronously.
 */
export class InMemoryAdapter
  implements
    AppRepository,
    EnvironmentRepository,
    KeyRepository,
    InstallationRepository,
    DedupeRepository,
    EndpointInventoryRepository,
    LogRepository,
    PublicLogKeyRepository,
    BucketRepository
{
  private readonly capabilities = new MemoryCapabilities();
  private readonly apps = new Map<string, AppV1>();
  private readonly environments = new Map<string, EnvironmentV1>();
  private readonly keysById = new Map<string, KeyRecordV1>();
  private readonly keysByVerifier = new Map<string, KeyRecordV1>();
  private readonly installation = new Map<string, InstallationRow>();
  private readonly seenBatches = new Map<string, number>();
  private readonly failureEvents = new Map<string, EventV1>();
  private readonly logEvents = new Map<string, StoredLogV1>();
  private readonly publicKeysById = new Map<string, PublicLogKeyV1>();
  private readonly publicKeysByVerifier = new Map<string, PublicLogKeyV1>();
  private readonly browserQuota = new Map<string, number>();
  private readonly observedEndpoints = new Map<
    string,
    { method: string; route: string; first_seen: number; last_seen: number }
  >();
  private readonly buckets = new Map<string, BucketV1>();

  private constructor() {}

  static async create(): Promise<InMemoryAdapter> {
    const adapter = new InMemoryAdapter();
    await adapter.seed();
    await adapter.capabilities.recordCapability(SEED_APP_ID, SEED_ENV_ID, 'endpoints', Date.now());
    return adapter;
  }

  /** Return this adapter as the aggregate repository shape the service expects. */
  asRepositories(): AppHealthRepositories {
    return {
      capabilities: this.capabilities,
      apps: this,
      environments: this,
      keys: this,
      installation: this,
      dedupe: this,
      inventory: this,
      failures: this,
      logs: this,
      publicKeys: this,
      buckets: this,
    };
  }

  private async seed(): Promise<void> {
    // Use the wall clock for app/env/key/installation timestamps so the
    // dashboard sees recent activity. Bucket timestamps are rebuilt at query
    // time via buildSeedBuckets(now), so the stored seed buckets use the
    // deterministic fixture timestamp only for direct repository access.
    const seedNow = Date.now();
    this.apps.set(SEED_APP_ID, {
      id: SEED_APP_ID,
      name: SEED_APP_NAME,
      created_at: seedNow,
    });
    this.environments.set(SEED_ENV_ID, {
      id: SEED_ENV_ID,
      app_id: SEED_APP_ID,
      name: SEED_ENV_NAME,
      created_at: seedNow,
    });
    const seedPublic: PublicLogKeyV1 = {
      id: 'pubkey-seed-0001',
      app_id: SEED_APP_ID,
      environment_id: SEED_ENV_ID,
      allowed_origins: [...SEED_PUBLIC_KEY_ORIGINS],
      created_at: seedNow,
      revoked_at: null,
    };
    this.publicKeysById.set(seedPublic.id, seedPublic);
    this.publicKeysByVerifier.set(await hashKey(SEED_PUBLIC_KEY), seedPublic);
    const seedVerifier = await hashKey(SEED_KEY);
    const seedKey: KeyRecordV1 = {
      id: 'key-seed-0001',
      app_id: SEED_APP_ID,
      environment_id: SEED_ENV_ID,
      verifier_hash: seedVerifier,
      created_at: seedNow,
      revoked_at: null,
    };
    this.keysById.set(seedKey.id, seedKey);
    this.keysByVerifier.set(seedVerifier, seedKey);
    // Seed installation status as connected with recent activity.
    this.installation.set(`${SEED_APP_ID}|${SEED_ENV_ID}`, {
      app_id: SEED_APP_ID,
      environment_id: SEED_ENV_ID,
      runtime: 'node',
      first_seen: seedNow - 10 * 60_000,
      last_seen: seedNow - 60_000,
    });
    // Seed one-minute buckets at the deterministic fixture timestamp so the
    // repository has stable data; queryEndpoints rebuilds them at query time.
    for (const bucket of buildSeedBuckets(1_725_000_000_000)) {
      const key = bucketKey(
        bucket.app_id,
        bucket.environment_id,
        bucket.bucket_start,
        bucket.method,
        bucket.route,
      );
      this.buckets.set(key, { ...bucket, histogram: [...bucket.histogram] });
    }
  }

  // --- AppRepository ---

  async createApp(name: string, now: number): Promise<AppV1> {
    const app: AppV1 = { id: newId('app'), name, created_at: now };
    this.apps.set(app.id, app);
    return app;
  }

  async getApp(appId: string): Promise<AppV1 | null> {
    return this.apps.get(appId) ?? null;
  }

  async listApps(): Promise<AppV1[]> {
    return [...this.apps.values()].map((app) => ({ ...app }));
  }

  // --- EnvironmentRepository ---

  async createEnvironment(appId: string, name: string, now: number): Promise<EnvironmentV1> {
    const env: EnvironmentV1 = { id: newId('env'), app_id: appId, name, created_at: now };
    this.environments.set(env.id, env);
    return env;
  }

  async resolveEnvironment(
    appId: string,
    name: string,
    now: number,
  ): Promise<EnvironmentV1 | null> {
    const environments = await this.listEnvironments(appId);
    const existing = environments.find((environment) => environment.name === name);
    if (existing) return existing;
    if (environments.length >= MAX_ENVIRONMENTS_PER_APP) return null;
    return this.createEnvironment(appId, name, now);
  }

  async getEnvironment(envId: string): Promise<EnvironmentV1 | null> {
    return this.environments.get(envId) ?? null;
  }

  async listEnvironments(appId: string): Promise<EnvironmentV1[]> {
    return [...this.environments.values()]
      .filter((environment) => environment.app_id === appId)
      .map((environment) => ({ ...environment }));
  }

  // --- KeyRepository ---

  async createEnvironmentKey(appId: string, name: string, now: number) {
    const envs = [...this.environments.values()].filter((env) => env.app_id === appId);
    if (envs.length >= MAX_ENVIRONMENTS_PER_APP || envs.some((env) => env.name === name))
      return null;
    const environment = await this.createEnvironment(appId, name, now);
    const created = await this.createKey(appId, environment.id, now);
    return { environment, ...created };
  }

  async createProductKey(
    appId: string,
    now: number,
  ): Promise<{
    record: KeyRecordV1;
    rawKey: string;
  }> {
    const rawKey = generateRawKey();
    const verifier = await hashKey(rawKey);
    const record: KeyRecordV1 = {
      id: newId('key'),
      app_id: appId,
      environment_id: null,
      verifier_hash: verifier,
      created_at: now,
      revoked_at: null,
    };
    this.keysById.set(record.id, record);
    this.keysByVerifier.set(verifier, record);
    return { record: { ...record }, rawKey };
  }

  async createKey(
    appId: string,
    envId: string,
    now: number,
  ): Promise<{
    record: KeyRecordV1;
    rawKey: string;
  }> {
    const rawKey = generateRawKey();
    const verifier = await hashKey(rawKey);
    const record: KeyRecordV1 = {
      id: newId('key'),
      app_id: appId,
      environment_id: envId,
      verifier_hash: verifier,
      created_at: now,
      revoked_at: null,
    };
    this.keysById.set(record.id, record);
    this.keysByVerifier.set(verifier, record);
    return { record: { ...record }, rawKey };
  }

  async rotateEnvironmentKey(appId: string, envId: string, now: number) {
    const created = await this.createKey(appId, envId, now);
    for (const key of this.keysById.values()) {
      if (
        key.app_id === appId &&
        key.environment_id === envId &&
        key.id !== created.record.id &&
        key.revoked_at === null
      )
        key.revoked_at = now;
    }
    return created;
  }

  async verifyKey(rawKey: string): Promise<KeyRecordV1 | null> {
    const verifier = await hashKey(rawKey);
    const found = this.keysByVerifier.get(verifier);
    if (!found || found.revoked_at !== null) return null;
    return { ...found };
  }

  async revokeKey(keyId: string, now: number): Promise<void> {
    const found = this.keysById.get(keyId);
    if (!found) return;
    found.revoked_at = now;
  }

  async getActiveKeyForEnvironment(appId: string, envId: string): Promise<KeyRecordV1 | null> {
    let productKey: KeyRecordV1 | null = null;
    for (const key of this.keysById.values()) {
      if (key.app_id === appId && key.environment_id === envId && key.revoked_at === null) {
        return { ...key };
      }
      if (key.app_id === appId && key.environment_id === null && key.revoked_at === null) {
        productKey = { ...key };
      }
    }
    return productKey;
  }

  // --- InstallationRepository ---

  async recordIngest(appId: string, envId: string, runtime: Runtime, now: number): Promise<void> {
    const key = `${appId}|${envId}`;
    const row = this.installation.get(key);
    if (!row) {
      this.installation.set(key, {
        app_id: appId,
        environment_id: envId,
        runtime,
        first_seen: now,
        last_seen: now,
      });
      return;
    }
    row.runtime = runtime;
    row.last_seen = now;
    if (row.first_seen === null) row.first_seen = now;
  }

  async getStatus(appId: string, envId: string, now: number): Promise<InstallationStatusV1> {
    const key = `${appId}|${envId}`;
    // Revoked key takes precedence so the operator sees the real blocker.
    const envKey = await this.getActiveKeyForEnvironment(appId, envId);
    let revoked = false;
    if (!envKey) {
      // If a key exists but is revoked, report revoked.
      for (const k of this.keysById.values()) {
        if (
          k.app_id === appId &&
          (k.environment_id === envId || k.environment_id === null) &&
          k.revoked_at !== null
        ) {
          revoked = true;
          break;
        }
      }
    }
    if (revoked) {
      return {
        state: 'revoked',
        runtime: undefined,
        first_seen: null,
        last_seen: null,
        next_action: 'Generate a new ingest key and update your SDK configuration.',
      };
    }
    const row = this.installation.get(key);
    if (!row || row.last_seen === null) {
      return {
        state: 'waiting',
        first_seen: null,
        last_seen: null,
        next_action: 'Install the SDK with this environment\u2019s ingest key.',
      };
    }
    const isStale = now - row.last_seen > STALE_THRESHOLD_MS;
    if (isStale) {
      return {
        state: 'stale',
        runtime: row.runtime ?? undefined,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        next_action: 'No recent traffic received. Send requests to instrumented endpoints.',
      };
    }
    return {
      state: 'connected',
      runtime: row.runtime ?? undefined,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      next_action: 'Send traffic to your instrumented endpoints to populate the dashboard.',
    };
  }

  // --- DedupeRepository ---

  async markSeen(appId: string, envId: string, batchId: string, now: number): Promise<boolean> {
    this.pruneDedupe(now);
    const key = `${appId}|${envId}|${batchId}`;
    if (this.seenBatches.has(key)) return false;
    this.seenBatches.set(key, now);
    return true;
  }

  async forget(appId: string, envId: string, batchId: string): Promise<void> {
    this.seenBatches.delete(`${appId}|${envId}|${batchId}`);
  }

  async cleanupExpired(before: number, limit: number): Promise<number> {
    let removed = 0;
    for (const [key, seenAt] of this.seenBatches) {
      if (removed >= limit) break;
      if (seenAt < before) {
        this.seenBatches.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async recordFailures(appId: string, envId: string, events: readonly EventV1[]): Promise<void> {
    for (const event of events) {
      if (event.status_code >= 400) {
        this.failureEvents.set(`${appId}|${envId}|${event.event_id}`, event);
      }
    }
  }

  async recordLogs(
    appId: string,
    envId: string,
    logs: readonly LogEventV1[],
    source: LogSource,
  ): Promise<void> {
    for (const log of logs) {
      const key = `${appId}|${envId}|${log.log_id}`;
      if (!this.logEvents.has(key)) this.logEvents.set(key, { ...log, source });
    }
  }
  async listLogs(appId: string, envId: string, query: LogListQuery): Promise<StoredLogV1[]> {
    const prefix = `${appId}|${envId}|`;
    const reference = query.now ?? Date.now();
    const cutoff = reference - LOG_RETENTION_DAYS * 86_400_000;
    return [...this.logEvents.entries()]
      .filter(
        ([key, log]) =>
          key.startsWith(prefix) &&
          log.timestamp >= cutoff &&
          log.timestamp <= reference + 5 * 60 * 1000 &&
          logLevelAtLeast(log.level, query.minLevel) &&
          (query.source === undefined || log.source === query.source) &&
          (query.event === undefined || log.event === query.event),
      )
      .map(([, log]) => log)
      .sort((left, right) =>
        right.timestamp === left.timestamp
          ? right.log_id.localeCompare(left.log_id)
          : right.timestamp - left.timestamp,
      )
      .slice(0, query.limit);
  }
  async createPublicKey(
    appId: string,
    envId: string,
    allowedOrigins: readonly string[],
    now: number,
  ): Promise<{ record: PublicLogKeyV1; rawKey: string }> {
    const rawKey = generateRawKey(PUBLIC_LOG_KEY_PREFIX);
    const record: PublicLogKeyV1 = {
      id: newId('pubkey'),
      app_id: appId,
      environment_id: envId,
      allowed_origins: [...allowedOrigins],
      created_at: now,
      revoked_at: null,
    };
    this.publicKeysById.set(record.id, record);
    this.publicKeysByVerifier.set(await hashKey(rawKey), record);
    return { record: { ...record }, rawKey };
  }
  async verifyPublicKey(rawKey: string): Promise<PublicLogKeyV1 | null> {
    const found = this.publicKeysByVerifier.get(await hashKey(rawKey));
    return found && found.revoked_at === null ? { ...found } : null;
  }
  async getPublicKey(keyId: string): Promise<PublicLogKeyV1 | null> {
    return this.publicKeysById.get(keyId) ?? null;
  }
  async listPublicKeys(appId: string): Promise<PublicLogKeyV1[]> {
    return [...this.publicKeysById.values()]
      .filter((key) => key.app_id === appId)
      .sort((left, right) => right.created_at - left.created_at)
      .map((key) => ({ ...key }));
  }
  async revokePublicKey(keyId: string, now: number): Promise<boolean> {
    const found = this.publicKeysById.get(keyId);
    if (!found || found.revoked_at !== null) return false;
    found.revoked_at = now;
    return true;
  }
  async consumeBrowserQuota(keyId: string, windowStart: number, amount: number): Promise<number> {
    const bucket = `${keyId}|${windowStart}`;
    const total = (this.browserQuota.get(bucket) ?? 0) + amount;
    this.browserQuota.set(bucket, total);
    return total;
  }
  async listFailures(
    appId: string,
    envId: string,
    from: number,
    limit: number,
  ): Promise<FailureEventV1[]> {
    const prefix = `${appId}|${envId}|`;
    return [...this.failureEvents.entries()]
      .filter(([key, event]) => key.startsWith(prefix) && event.timestamp >= from)
      .sort(([, left], [, right]) =>
        right.timestamp === left.timestamp
          ? right.event_id.localeCompare(left.event_id)
          : right.timestamp - left.timestamp,
      )
      .slice(0, limit)
      .map(([, event]) => ({
        failure_id: event.event_id,
        method: event.method,
        route: event.route,
        status_code: event.status_code,
        duration_ms: event.duration_ms,
        occurred_at: event.timestamp,
        release: event.release ?? null,
      }));
  }

  async recordObserved(
    appId: string,
    envId: string,
    endpoints: readonly { method: string; route: string; timestamp: number }[],
  ): Promise<void> {
    for (const endpoint of endpoints) {
      const key = `${appId}|${envId}|${endpoint.method}|${endpoint.route}`;
      const existing = this.observedEndpoints.get(key);
      if (existing) {
        existing.first_seen = Math.min(existing.first_seen, endpoint.timestamp);
        existing.last_seen = Math.max(existing.last_seen, endpoint.timestamp);
      } else {
        this.observedEndpoints.set(key, {
          method: endpoint.method,
          route: endpoint.route,
          first_seen: endpoint.timestamp,
          last_seen: endpoint.timestamp,
        });
      }
    }
  }

  async listObserved(appId: string, envId: string) {
    const prefix = `${appId}|${envId}|`;
    return [...this.observedEndpoints.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, endpoint]) => ({ ...endpoint }));
  }

  async upsertEvents(
    appId: string,
    envId: string,
    _runtime: Runtime,
    _release: string | undefined,
    events: readonly {
      timestamp: number;
      method: string;
      route: string;
      status_code: number;
      duration_ms: number;
      upstream_sampled?: boolean;
    }[],
  ): Promise<void> {
    for (const event of events) {
      await this.upsertBucket({
        app_id: appId,
        environment_id: envId,
        bucket_start: Math.floor(event.timestamp / BUCKET_MS) * BUCKET_MS,
        method: event.method,
        route: event.route,
        statusIsError: isErrorStatus(event.status_code),
        durationMs: event.duration_ms,
        timestamp: event.timestamp,
        upstreamSampled: event.upstream_sampled,
      });
    }
  }

  private pruneDedupe(now: number): void {
    const cutoff = now - DEDUPE_WINDOW_MS;
    for (const [id, seenAt] of this.seenBatches) {
      if (seenAt < cutoff) this.seenBatches.delete(id);
    }
  }

  // --- BucketRepository ---

  async upsertBucket(input: {
    app_id: string;
    environment_id: string;
    bucket_start: number;
    method: string;
    route: string;
    statusIsError: boolean;
    durationMs: number;
    timestamp: number;
    upstreamSampled?: boolean;
  }): Promise<void> {
    const key = bucketKey(
      input.app_id,
      input.environment_id,
      input.bucket_start,
      input.method,
      input.route,
    );
    const existing = this.buckets.get(key);
    if (existing) {
      existing.request_count += 1;
      if (input.statusIsError) existing.error_count += 1;
      existing.duration_sum_ms += input.durationMs;
      if (existing.last_seen === null || input.timestamp > existing.last_seen) {
        existing.last_seen = input.timestamp;
      }
      existing.histogram[histogramIndex(input.durationMs)] += 1;
      if (input.upstreamSampled) existing.upstream_sampled = true;
      return;
    }
    const histogram = emptyHistogram();
    histogram[histogramIndex(input.durationMs)] = 1;
    this.buckets.set(key, {
      app_id: input.app_id,
      environment_id: input.environment_id,
      bucket_start: input.bucket_start,
      method: input.method,
      route: input.route,
      request_count: 1,
      error_count: input.statusIsError ? 1 : 0,
      duration_sum_ms: input.durationMs,
      last_seen: input.timestamp,
      ...(input.upstreamSampled ? { upstream_sampled: true } : {}),
      histogram,
    });
  }

  async queryBuckets(appId: string, envId: string, from: number, to: number): Promise<BucketV1[]> {
    const out: BucketV1[] = [];
    for (const bucket of this.buckets.values()) {
      if (
        bucket.app_id === appId &&
        bucket.environment_id === envId &&
        bucket.bucket_start >= from &&
        bucket.bucket_start <= to
      ) {
        out.push({ ...bucket, histogram: [...bucket.histogram] });
      }
    }
    return out;
  }
}

function bucketKey(
  appId: string,
  envId: string,
  bucketStart: number,
  method: string,
  route: string,
): string {
  return `${appId}|${envId}|${bucketStart}|${method}|${route}`;
}

export { isErrorStatus };
