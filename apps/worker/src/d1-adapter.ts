import type {
  AppV1,
  EnvironmentV1,
  InstallationStatusV1,
  KeyRecordV1,
  Runtime,
  EventV1,
  FailureEventV1,
  LogEventV1,
  LogSource,
  PublicLogKeyV1,
  StoredLogV1,
} from '@app-health/contracts';
import { LOG_LEVELS, LOG_RETENTION_DAYS, PUBLIC_LOG_KEY_PREFIX } from '@app-health/contracts';
import { D1Capabilities } from './capability-store.js';
import { generateRawKey, hashKey } from './crypto.js';
import type {
  AppHealthRepositories,
  AppRepository,
  BucketRepository,
  DedupeRepository,
  EndpointInventoryRepository,
  FailureRepository,
  LogListQuery,
  LogRepository,
  PublicLogKeyRepository,
  EnvironmentRepository,
  InstallationRepository,
  KeyRepository,
  SetupRepository,
} from './repository.js';
import { MAX_ENVIRONMENTS_PER_APP } from './repository.js';

export interface D1RunResult {
  success: boolean;
  meta: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResult>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]>;
}

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function prepareScopedKey(appId: string, envId: string, now: number) {
  const rawKey = generateRawKey();
  const record: KeyRecordV1 = {
    id: id('key'),
    app_id: appId,
    environment_id: envId,
    verifier_hash: await hashKey(rawKey),
    created_at: now,
    revoked_at: null,
  };
  return { record, rawKey };
}

export class D1ControlPlane
  implements
    AppRepository,
    EnvironmentRepository,
    KeyRepository,
    InstallationRepository,
    DedupeRepository,
    EndpointInventoryRepository,
    FailureRepository,
    LogRepository,
    PublicLogKeyRepository,
    SetupRepository
{
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly workspaceId?: string | null,
  ) {}

  asRepositories(buckets: BucketRepository): AppHealthRepositories {
    return {
      capabilities: new D1Capabilities(this.db),
      apps: this,
      environments: this,
      keys: this,
      installation: this,
      dedupe: this,
      inventory: this,
      failures: this,
      logs: this,
      publicKeys: this,
      buckets,
      setup: this,
    };
  }

  async createAppEnvironmentKey(
    name: string,
    environmentName: string,
    now: number,
    keyScope: 'product' | 'environment' = 'product',
  ) {
    const app: AppV1 = { id: id('app'), name, created_at: now };
    const environment: EnvironmentV1 = {
      id: id('env'),
      app_id: app.id,
      name: environmentName,
      created_at: now,
    };
    const rawKey = generateRawKey();
    const record: KeyRecordV1 = {
      id: id('key'),
      app_id: app.id,
      environment_id: keyScope === 'environment' ? environment.id : null,
      verifier_hash: await hashKey(rawKey),
      created_at: now,
      revoked_at: null,
    };
    const statements = [
      this.db
        .prepare('INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)')
        .bind(app.id, app.name, now),
      this.db
        .prepare('INSERT INTO environments (id, app_id, name, created_at) VALUES (?, ?, ?, ?)')
        .bind(environment.id, app.id, environment.name, now),
      record.environment_id
        ? this.db
            .prepare(
              'INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
            )
            .bind(record.id, app.id, environment.id, record.verifier_hash, now)
        : this.db
            .prepare(
              'INSERT INTO product_keys (id, app_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
            )
            .bind(record.id, app.id, record.verifier_hash, now),
      this.db
        .prepare(
          'INSERT INTO installation_status (app_id, environment_id, runtime, first_seen, last_seen) VALUES (?, ?, NULL, NULL, NULL)',
        )
        .bind(app.id, environment.id),
    ];
    if (this.workspaceId)
      statements.push(
        this.db
          .prepare('INSERT INTO workspace_apps (app_id, workspace_id) VALUES (?, ?)')
          .bind(app.id, this.workspaceId),
      );
    const results = await this.db.batch(statements);
    if (results.some((result) => !result.success)) throw new Error('D1 setup transaction failed');
    return { app, environment, record, rawKey };
  }

  async createApp(name: string, now: number): Promise<AppV1> {
    const app = { id: id('app'), name, created_at: now };
    await this.db
      .prepare('INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)')
      .bind(app.id, name, now)
      .run();
    return app;
  }

  getApp(appId: string): Promise<AppV1 | null> {
    return this.db
      .prepare('SELECT id, name, created_at FROM apps WHERE id = ?')
      .bind(appId)
      .first<AppV1>();
  }

  async listApps(): Promise<AppV1[]> {
    if (this.workspaceId)
      return (
        await this.db
          .prepare(
            'SELECT a.id, a.name, a.created_at FROM apps a JOIN workspace_apps w ON w.app_id = a.id WHERE w.workspace_id = ? ORDER BY a.created_at DESC',
          )
          .bind(this.workspaceId)
          .all<AppV1>()
      ).results;
    return (
      await this.db
        .prepare(
          this.workspaceId === null
            ? 'SELECT id, name, created_at FROM apps WHERE NOT EXISTS (SELECT 1 FROM workspace_apps w WHERE w.app_id = apps.id) ORDER BY created_at DESC'
            : 'SELECT id, name, created_at FROM apps ORDER BY created_at DESC',
        )
        .all<AppV1>()
    ).results;
  }

  async createEnvironment(appId: string, name: string, now: number): Promise<EnvironmentV1> {
    const environment = { id: id('env'), app_id: appId, name, created_at: now };
    await this.db
      .prepare('INSERT INTO environments (id, app_id, name, created_at) VALUES (?, ?, ?, ?)')
      .bind(environment.id, appId, name, now)
      .run();
    return environment;
  }

  async resolveEnvironment(
    appId: string,
    name: string,
    now: number,
  ): Promise<EnvironmentV1 | null> {
    const environment: EnvironmentV1 = { id: id('env'), app_id: appId, name, created_at: now };
    await this.db
      .prepare(
        'INSERT INTO environments (id, app_id, name, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM environments WHERE app_id = ? AND name = ?) AND (SELECT COUNT(*) FROM environments WHERE app_id = ?) < ?',
      )
      .bind(environment.id, appId, name, now, appId, name, appId, MAX_ENVIRONMENTS_PER_APP)
      .run();
    return (
      (await this.db
        .prepare(
          'SELECT id, app_id, name, created_at FROM environments WHERE app_id = ? AND name = ?',
        )
        .bind(appId, name)
        .first<EnvironmentV1>()) ?? null
    );
  }

  getEnvironment(envId: string): Promise<EnvironmentV1 | null> {
    return this.db
      .prepare('SELECT id, app_id, name, created_at FROM environments WHERE id = ?')
      .bind(envId)
      .first<EnvironmentV1>();
  }

  async listEnvironments(appId: string): Promise<EnvironmentV1[]> {
    return (
      await this.db
        .prepare(
          'SELECT id, app_id, name, created_at FROM environments WHERE app_id = ? ORDER BY created_at',
        )
        .bind(appId)
        .all<EnvironmentV1>()
    ).results;
  }

  async createEnvironmentKey(appId: string, name: string, now: number) {
    const environment: EnvironmentV1 = { id: id('env'), app_id: appId, name, created_at: now };
    const { record, rawKey } = await prepareScopedKey(appId, environment.id, now);
    const results = await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO environments (id, app_id, name, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM environments WHERE app_id = ? AND name = ?) AND (SELECT COUNT(*) FROM environments WHERE app_id = ?) < ?',
        )
        .bind(environment.id, appId, name, now, appId, name, appId, MAX_ENVIRONMENTS_PER_APP),
      this.db
        .prepare(
          'INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at, revoked_at) SELECT ?, ?, ?, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM environments WHERE id = ?)',
        )
        .bind(record.id, appId, environment.id, record.verifier_hash, now, environment.id),
      this.db
        .prepare(
          'INSERT INTO installation_status (app_id, environment_id, runtime, first_seen, last_seen) SELECT ?, ?, NULL, NULL, NULL WHERE EXISTS (SELECT 1 FROM environments WHERE id = ?)',
        )
        .bind(appId, environment.id, environment.id),
    ]);
    if (results.some((result) => !result.success)) throw new Error('Environment creation failed');
    return results[0].meta.changes ? { environment, record, rawKey } : null;
  }

  async createKey(appId: string, envId: string, now: number) {
    const { record, rawKey } = await prepareScopedKey(appId, envId, now);
    await this.db
      .prepare(
        'INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      )
      .bind(record.id, appId, envId, record.verifier_hash, now)
      .run();
    return { record, rawKey };
  }

  async createProductKey(appId: string, now: number) {
    const rawKey = generateRawKey();
    const record: KeyRecordV1 = {
      id: id('key'),
      app_id: appId,
      environment_id: null,
      verifier_hash: await hashKey(rawKey),
      created_at: now,
      revoked_at: null,
    };
    await this.db
      .prepare(
        'INSERT INTO product_keys (id, app_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .bind(record.id, appId, record.verifier_hash, now)
      .run();
    return { record, rawKey };
  }

  async rotateEnvironmentKey(appId: string, envId: string, now: number) {
    const { record, rawKey } = await prepareScopedKey(appId, envId, now);
    const results = await this.db.batch([
      this.db
        .prepare(
          'UPDATE keys SET revoked_at = ? WHERE app_id = ? AND environment_id = ? AND revoked_at IS NULL',
        )
        .bind(now, appId, envId),
      this.db
        .prepare(
          'INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
        )
        .bind(record.id, appId, envId, record.verifier_hash, now),
    ]);
    if (results.some((result) => !result.success))
      throw new Error('Private key could not be replaced');
    return { record, rawKey };
  }

  async verifyKey(rawKey: string): Promise<KeyRecordV1 | null> {
    const verifier = await hashKey(rawKey);
    return this.db
      .prepare(
        'SELECT id, app_id, environment_id, verifier_hash, created_at, revoked_at FROM keys WHERE verifier_hash = ? AND revoked_at IS NULL UNION ALL SELECT id, app_id, NULL AS environment_id, verifier_hash, created_at, revoked_at FROM product_keys WHERE verifier_hash = ? AND revoked_at IS NULL LIMIT 1',
      )
      .bind(verifier, verifier)
      .first<KeyRecordV1>();
  }

  async revokeKey(keyId: string, now: number): Promise<void> {
    await this.db
      .prepare('UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(now, keyId)
      .run();
    await this.db
      .prepare('UPDATE product_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(now, keyId)
      .run();
  }

  getActiveKeyForEnvironment(appId: string, envId: string): Promise<KeyRecordV1 | null> {
    return this.db
      .prepare(
        'SELECT id, app_id, environment_id, verifier_hash, created_at, revoked_at FROM keys WHERE app_id = ? AND environment_id = ? AND revoked_at IS NULL UNION ALL SELECT id, app_id, NULL AS environment_id, verifier_hash, created_at, revoked_at FROM product_keys WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .bind(appId, envId, appId)
      .first<KeyRecordV1>();
  }

  async recordIngest(appId: string, envId: string, runtime: Runtime, now: number): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO installation_status (app_id, environment_id, runtime, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, environment_id) DO UPDATE SET runtime = excluded.runtime, first_seen = COALESCE(installation_status.first_seen, excluded.first_seen), last_seen = excluded.last_seen',
      )
      .bind(appId, envId, runtime, now, now)
      .run();
  }

  async getStatus(appId: string, envId: string, now: number): Promise<InstallationStatusV1> {
    const row = await this.db
      .prepare(
        'SELECT i.runtime, i.first_seen, i.last_seen, (EXISTS(SELECT 1 FROM keys k WHERE k.app_id = i.app_id AND k.environment_id = i.environment_id AND k.revoked_at IS NULL) OR EXISTS(SELECT 1 FROM product_keys p WHERE p.app_id = i.app_id AND p.revoked_at IS NULL)) AS has_active_key FROM installation_status i WHERE i.app_id = ? AND i.environment_id = ?',
      )
      .bind(appId, envId)
      .first<{
        runtime: Runtime | null;
        first_seen: number | null;
        last_seen: number | null;
        has_active_key: number;
      }>();
    if (!row)
      return {
        state: 'waiting',
        first_seen: null,
        last_seen: null,
        next_action: 'Issue an ingest key and send one request.',
      };
    if (!row.has_active_key)
      return {
        state: 'revoked',
        runtime: row.runtime ?? undefined,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        next_action: 'Create a new ingest key.',
      };
    if (row.last_seen === null)
      return {
        state: 'waiting',
        runtime: row.runtime ?? undefined,
        first_seen: row.first_seen,
        last_seen: null,
        next_action: 'Start the service and send one request.',
      };
    if (now - row.last_seen > STALE_THRESHOLD_MS)
      return {
        state: 'stale',
        runtime: row.runtime ?? undefined,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
        next_action: 'Check that the service is running.',
      };
    return {
      state: 'connected',
      runtime: row.runtime ?? undefined,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      next_action: 'Endpoint summaries are arriving.',
    };
  }

  async markSeen(appId: string, envId: string, batchId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        'INSERT OR IGNORE INTO seen_batches (batch_id, app_id, environment_id, seen_at) VALUES (?, ?, ?, ?)',
      )
      .bind(batchId, appId, envId, now)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async forget(appId: string, envId: string, batchId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM seen_batches WHERE app_id = ? AND environment_id = ? AND batch_id = ?')
      .bind(appId, envId, batchId)
      .run();
  }

  async cleanupExpired(before: number, limit: number): Promise<number> {
    const result = await this.db
      .prepare(
        'DELETE FROM seen_batches WHERE rowid IN (SELECT rowid FROM seen_batches WHERE seen_at < ? ORDER BY seen_at LIMIT ?)',
      )
      .bind(before, limit)
      .run();
    return result.meta.changes ?? 0;
  }

  async recordFailures(appId: string, envId: string, events: readonly EventV1[]): Promise<void> {
    const failures = events.filter((event) => event.status_code >= 400);
    if (failures.length === 0) return;
    const results = await this.db.batch(
      failures.map((event) =>
        this.db
          .prepare(
            'INSERT OR IGNORE INTO failure_events (failure_id, app_id, environment_id, method, route, status_code, duration_ms, occurred_at, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            event.event_id,
            appId,
            envId,
            event.method,
            event.route,
            event.status_code,
            event.duration_ms,
            event.timestamp,
            event.release ?? null,
          ),
      ),
    );
    if (results.some((result) => !result.success)) throw new Error('D1 failure insert failed');
  }

  async listFailures(
    appId: string,
    envId: string,
    from: number,
    limit: number,
  ): Promise<FailureEventV1[]> {
    return (
      await this.db
        .prepare(
          'SELECT failure_id, method, route, status_code, duration_ms, occurred_at, release FROM failure_events WHERE app_id = ? AND environment_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC, failure_id DESC LIMIT ?',
        )
        .bind(appId, envId, from, limit)
        .all<FailureEventV1>()
    ).results;
  }

  async recordLogs(
    appId: string,
    envId: string,
    logs: readonly LogEventV1[],
    source: LogSource,
  ): Promise<void> {
    if (logs.length === 0) return;
    const results = await this.db.batch(
      logs.map((log) =>
        this.db
          .prepare(
            'INSERT OR IGNORE INTO log_events (log_id, app_id, environment_id, timestamp, event, level, title, description, icon, props, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            log.log_id,
            appId,
            envId,
            log.timestamp,
            log.event,
            log.level,
            log.title ?? null,
            log.description ?? null,
            log.icon ?? null,
            JSON.stringify(log.props),
            source,
          ),
      ),
    );
    if (results.some((result) => !result.success)) throw new Error('D1 log insert failed');
  }
  async listLogs(appId: string, envId: string, query: LogListQuery): Promise<StoredLogV1[]> {
    const levels = LOG_LEVELS.slice(LOG_LEVELS.indexOf(query.minLevel));
    const binds: unknown[] = [
      appId,
      envId,
      (query.now ?? Date.now()) - LOG_RETENTION_DAYS * 86_400_000,
      ...levels,
    ];
    let where = `app_id = ? AND environment_id = ? AND timestamp >= ? AND timestamp <= ? AND level IN (${levels.map(() => '?').join(', ')})`;
    binds.splice(3, 0, (query.now ?? Date.now()) + 5 * 60 * 1000);
    if (query.source !== undefined) {
      where += ' AND source = ?';
      binds.push(query.source);
    }
    if (query.event !== undefined) {
      where += ' AND event = ?';
      binds.push(query.event);
    }
    binds.push(query.limit);
    const rows = (
      await this.db
        .prepare(
          `SELECT log_id, timestamp, event, level, title, description, icon, props, source FROM log_events WHERE ${where} ORDER BY timestamp DESC, log_id DESC LIMIT ?`,
        )
        .bind(...binds)
        .all<LogRow>()
    ).results;
    return rows.map(logFromRow);
  }
  async createPublicKey(
    appId: string,
    envId: string,
    allowedOrigins: readonly string[],
    now: number,
  ): Promise<{ record: PublicLogKeyV1; rawKey: string }> {
    const rawKey = generateRawKey(PUBLIC_LOG_KEY_PREFIX);
    const record: PublicLogKeyV1 = {
      id: id('pubkey'),
      app_id: appId,
      environment_id: envId,
      allowed_origins: [...allowedOrigins],
      created_at: now,
      revoked_at: null,
    };
    await this.db
      .prepare(
        'INSERT INTO public_log_keys (id, app_id, environment_id, verifier_hash, allowed_origins, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      )
      .bind(
        record.id,
        appId,
        envId,
        await hashKey(rawKey),
        JSON.stringify(record.allowed_origins),
        now,
      )
      .run();
    return { record, rawKey };
  }
  async verifyPublicKey(rawKey: string): Promise<PublicLogKeyV1 | null> {
    const row = await this.db
      .prepare(
        'SELECT id, app_id, environment_id, allowed_origins, created_at, revoked_at FROM public_log_keys WHERE verifier_hash = ? AND revoked_at IS NULL LIMIT 1',
      )
      .bind(await hashKey(rawKey))
      .first<PublicKeyRow>();
    return row ? publicKeyFromRow(row) : null;
  }
  async getPublicKey(keyId: string): Promise<PublicLogKeyV1 | null> {
    const row = await this.db
      .prepare(
        'SELECT id, app_id, environment_id, allowed_origins, created_at, revoked_at FROM public_log_keys WHERE id = ?',
      )
      .bind(keyId)
      .first<PublicKeyRow>();
    return row ? publicKeyFromRow(row) : null;
  }
  async listPublicKeys(appId: string): Promise<PublicLogKeyV1[]> {
    const { results } = await this.db
      .prepare(
        'SELECT id, app_id, environment_id, allowed_origins, created_at, revoked_at FROM public_log_keys WHERE app_id = ? ORDER BY created_at DESC',
      )
      .bind(appId)
      .all<PublicKeyRow>();
    return results.map(publicKeyFromRow);
  }
  async revokePublicKey(keyId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE public_log_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(now, keyId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
  async consumeBrowserQuota(keyId: string, windowStart: number, amount: number): Promise<number> {
    const row = await this.db
      .prepare(
        'INSERT INTO browser_log_quota (key_id, window_start, count) VALUES (?, ?, ?) ON CONFLICT (key_id, window_start) DO UPDATE SET count = count + excluded.count RETURNING count',
      )
      .bind(keyId, windowStart, amount)
      .first<{ count: number }>();
    return row?.count ?? amount;
  }
  async cleanupBrowserQuotaExpired(before: number): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM browser_log_quota WHERE window_start < ?')
      .bind(before)
      .run();
    return result.meta.changes ?? 0;
  }
  async cleanupLogsExpired(before: number, limit: number): Promise<number> {
    const result = await this.db
      .prepare(
        'DELETE FROM log_events WHERE rowid IN (SELECT rowid FROM log_events WHERE timestamp < ? ORDER BY timestamp LIMIT ?)',
      )
      .bind(before, limit)
      .run();
    return result.meta.changes ?? 0;
  }
  async cleanupFailuresExpired(before: number, limit: number): Promise<number> {
    const result = await this.db
      .prepare(
        'DELETE FROM failure_events WHERE rowid IN (SELECT rowid FROM failure_events WHERE occurred_at < ? ORDER BY occurred_at LIMIT ?)',
      )
      .bind(before, limit)
      .run();
    return result.meta.changes ?? 0;
  }

  async recordObserved(
    appId: string,
    envId: string,
    endpoints: readonly { method: string; route: string; timestamp: number }[],
  ): Promise<void> {
    const unique = new Map<
      string,
      { method: string; route: string; first: number; last: number }
    >();
    for (const endpoint of endpoints) {
      const key = `${endpoint.method}\u0000${endpoint.route}`;
      const current = unique.get(key);
      if (current) {
        current.first = Math.min(current.first, endpoint.timestamp);
        current.last = Math.max(current.last, endpoint.timestamp);
      } else {
        unique.set(key, {
          method: endpoint.method,
          route: endpoint.route,
          first: endpoint.timestamp,
          last: endpoint.timestamp,
        });
      }
    }
    if (unique.size === 0) return;
    const results = await this.db.batch(
      [...unique.values()].map((endpoint) =>
        this.db
          .prepare(
            'INSERT INTO observed_endpoints (app_id, environment_id, method, route, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app_id, environment_id, method, route) DO UPDATE SET first_seen = MIN(observed_endpoints.first_seen, excluded.first_seen), last_seen = MAX(observed_endpoints.last_seen, excluded.last_seen)',
          )
          .bind(appId, envId, endpoint.method, endpoint.route, endpoint.first, endpoint.last),
      ),
    );
    if (results.some((result) => !result.success))
      throw new Error('D1 endpoint inventory update failed');
  }

  async listObserved(appId: string, envId: string) {
    return (
      await this.db
        .prepare(
          'SELECT method, route, first_seen, last_seen FROM observed_endpoints WHERE app_id = ? AND environment_id = ? ORDER BY method, route',
        )
        .bind(appId, envId)
        .all<{ method: string; route: string; first_seen: number; last_seen: number }>()
    ).results;
  }
}

interface LogRow {
  log_id: string;
  timestamp: number;
  event: string;
  level: LogEventV1['level'];
  title: string | null;
  description: string | null;
  icon: string | null;
  props: string;
  source: LogSource;
}

interface PublicKeyRow {
  id: string;
  app_id: string;
  environment_id: string;
  allowed_origins: string;
  created_at: number;
  revoked_at: number | null;
}

function publicKeyFromRow(row: PublicKeyRow): PublicLogKeyV1 {
  return { ...row, allowed_origins: JSON.parse(row.allowed_origins) as string[] };
}

function logFromRow(row: LogRow): StoredLogV1 {
  return {
    log_id: row.log_id,
    timestamp: row.timestamp,
    event: row.event,
    level: row.level,
    source: row.source,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.icon !== null ? { icon: row.icon } : {}),
    props: JSON.parse(row.props) as LogEventV1['props'],
  };
}
