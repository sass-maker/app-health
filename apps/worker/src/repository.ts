// Repository interfaces for the V0 worker. These describe the storage shape
// the Cloudflare D1 implementation will satisfy in a later, deploy-approved
// change. V0 ships an in-memory implementation (see in-memory-adapter.ts) so
// the worker and its tests run credential-free.
//
// Every operation is scoped to an app and environment. Raw request events are
// never persisted: ingest updates one-minute aggregate buckets only.

import type {
  CapabilityId,
  CapabilityState,
  AppV1,
  BucketV1,
  EnvironmentV1,
  InstallationStatusV1,
  KeyRecordV1,
  Runtime,
  EventV1,
  FailureEventV1,
  LogEventV1,
  LogLevel,
  LogSource,
  PublicLogKeyV1,
  StoredLogV1,
} from '@app-health/contracts';

/** Persisted app records. */
export interface AppRepository {
  createApp(name: string, now: number): Promise<AppV1>;
  getApp(appId: string): Promise<AppV1 | null>;
  listApps(): Promise<AppV1[]>;
}

/** Persisted environment records, scoped to an app. */
export interface EnvironmentRepository {
  createEnvironmentKey(
    appId: string,
    name: string,
    now: number,
  ): Promise<{ environment: EnvironmentV1; record: KeyRecordV1; rawKey: string } | null>;
  createEnvironment(appId: string, name: string, now: number): Promise<EnvironmentV1>;
  resolveEnvironment(appId: string, name: string, now: number): Promise<EnvironmentV1 | null>;
  getEnvironment(envId: string): Promise<EnvironmentV1 | null>;
  listEnvironments(appId: string): Promise<EnvironmentV1[]>;
}

/**
 * Persisted ingest keys. Only the non-reversible verifier is stored; the raw
 * key is returned to the caller exactly once at creation time.
 */
export interface KeyRepository {
  rotateEnvironmentKey(
    appId: string,
    envId: string,
    now: number,
  ): Promise<{ record: KeyRecordV1; rawKey: string }>;
  /** Create a product-scoped key that can route to explicit environments. */
  createProductKey(
    appId: string,
    now: number,
  ): Promise<{
    record: KeyRecordV1;
    rawKey: string;
  }>;
  /** Create a new key and return the stored record plus the raw one-time key. */
  createKey(
    appId: string,
    envId: string,
    now: number,
  ): Promise<{
    record: KeyRecordV1;
    rawKey: string;
  }>;
  /** Look up a non-revoked key by its raw key string via the verifier hash. */
  verifyKey(rawKey: string): Promise<KeyRecordV1 | null>;
  /** Mark a key revoked; future ingest using it is rejected. */
  revokeKey(keyId: string, now: number): Promise<void>;
  /** Return the active (non-revoked) key for an environment, if any. */
  getActiveKeyForEnvironment(appId: string, envId: string): Promise<KeyRecordV1 | null>;
}

/** Installation verification state per (app_id, environment_id). */
export interface InstallationRepository {
  /** Record a successful ingest; updates first_seen/last_seen/runtime. */
  recordIngest(appId: string, envId: string, runtime: Runtime, now: number): Promise<void>;
  /** Read the installation status for the setup view. */
  getStatus(appId: string, envId: string, now: number): Promise<InstallationStatusV1>;
}

/**
 * Bounded deduplication of batch IDs. Returns true when the batch_id is newly
 * seen within the window, false when it is a duplicate.
 */
export interface DedupeRepository {
  markSeen(appId: string, envId: string, batchId: string, now: number): Promise<boolean>;
  /** Release a claim when aggregate persistence fails so the SDK can retry. */
  forget(appId: string, envId: string, batchId: string): Promise<void>;
  cleanupExpired(before: number, limit: number): Promise<number>;
}

export interface FailureRepository {
  recordFailures(appId: string, envId: string, events: readonly EventV1[]): Promise<void>;
  listFailures(
    appId: string,
    envId: string,
    from: number,
    limit: number,
  ): Promise<FailureEventV1[]>;
}

/** Filters for reading retained application logs. */
export interface LogListQuery {
  /** Minimum level, inclusive. */
  minLevel: LogLevel;
  source?: LogSource;
  event?: string;
  limit: number;
  now?: number;
}

/**
 * Owner-authored application logs. Unlike endpoint telemetry these are
 * explicit events an application chose to send, retained for a bounded window.
 */
export interface LogRepository {
  recordLogs(
    appId: string,
    envId: string,
    logs: readonly LogEventV1[],
    source: LogSource,
  ): Promise<void>;
  listLogs(appId: string, envId: string, query: LogListQuery): Promise<StoredLogV1[]>;
}

/**
 * Public browser log keys. Only the verifier hash is stored; the raw key is
 * returned once at creation. Each key is pinned to one environment and an
 * origin allowlist, and rate limited per minute.
 */
export interface PublicLogKeyRepository {
  createPublicKey(
    appId: string,
    envId: string,
    allowedOrigins: readonly string[],
    now: number,
  ): Promise<{ record: PublicLogKeyV1; rawKey: string }>;
  verifyPublicKey(rawKey: string): Promise<PublicLogKeyV1 | null>;
  getPublicKey(keyId: string): Promise<PublicLogKeyV1 | null>;
  listPublicKeys(appId: string): Promise<PublicLogKeyV1[]>;
  /** Returns false when no active key matched. */
  revokePublicKey(keyId: string, now: number): Promise<boolean>;
  /** Add `amount` to the key's counter for the minute starting at `windowStart`; returns the new total. */
  consumeBrowserQuota(keyId: string, windowStart: number, amount: number): Promise<number>;
}

interface ObservedEndpoint {
  method: string;
  route: string;
  first_seen: number;
  last_seen: number;
}

/** Durable normalized endpoint identities; never raw requests or payloads. */
export interface EndpointInventoryRepository {
  recordObserved(
    appId: string,
    envId: string,
    endpoints: readonly { method: string; route: string; timestamp: number }[],
  ): Promise<void>;
  listObserved(appId: string, envId: string): Promise<ObservedEndpoint[]>;
}

/**
 * One-minute endpoint aggregate buckets. Ingest upserts; query reads a window
 * range and merges buckets in memory.
 */
export interface BucketRepository {
  /** Validate provider expansion limits before any inventory, failure or dedupe writes. */
  validateEvents?(events: readonly (EventV1 & { environment?: string })[], release?: string): void;
  /** Atomically add one event's contribution to its one-minute bucket. */
  upsertBucket(
    bucket: Omit<
      BucketV1,
      | 'request_count'
      | 'error_count'
      | 'duration_sum_ms'
      | 'last_seen'
      | 'histogram'
      | 'upstream_sampled'
    > & {
      statusIsError: boolean;
      durationMs: number;
      timestamp: number;
      upstreamSampled?: boolean;
    },
  ): Promise<void>;
  /** Return all buckets for the (app, environment) pair within [from, to]. */
  queryBuckets(appId: string, envId: string, from: number, to: number): Promise<BucketV1[]>;
  upsertEvents?(
    appId: string,
    envId: string,
    runtime: Runtime,
    release: string | undefined,
    events: readonly {
      timestamp: number;
      method: string;
      route: string;
      status_code: number;
      duration_ms: number;
      release?: string;
      upstream_sampled?: boolean;
    }[],
  ): Promise<void>;
}

export interface CapabilityRepository {
  getCapabilities(appId: string, envId: string): Promise<CapabilityState[]>;
  setCapabilities(appId: string, envId: string, enabled: readonly CapabilityId[]): Promise<void>;
  recordCapability(
    appId: string,
    envId: string,
    capability: CapabilityId,
    now: number,
  ): Promise<void>;
}

export interface SetupRepository {
  createAppEnvironmentKey(
    name: string,
    environment: string,
    now: number,
    keyScope?: 'product' | 'environment',
  ): Promise<{ app: AppV1; environment: EnvironmentV1; record: KeyRecordV1; rawKey: string }>;
}

export const MAX_ENVIRONMENTS_PER_APP = 20;

/** Aggregate of all V0 repositories. The in-memory adapter implements this. */
export interface AppHealthRepositories {
  capabilities?: CapabilityRepository;
  apps: AppRepository;
  environments: EnvironmentRepository;
  keys: KeyRepository;
  installation: InstallationRepository;
  dedupe: DedupeRepository;
  inventory?: EndpointInventoryRepository;
  failures?: FailureRepository;
  logs?: LogRepository;
  publicKeys?: PublicLogKeyRepository;
  buckets: BucketRepository;
  setup?: SetupRepository;
}
