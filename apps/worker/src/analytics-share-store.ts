import type { D1DatabaseLike } from './d1-adapter.js';

const TOKEN_PREFIX = 'ahs_';
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^ahs_[A-Za-z0-9_-]{43}$/;
const ACTIVE_LIMIT = 5;
const HISTORY_LIMIT = 20;

export interface ShareScope {
  workspace: string;
  app_id: string;
  environment_id: string;
}

export interface ShareRecord extends ShareScope {
  id: string;
  created_at: number;
  revoked_at: number | null;
}

export interface AnalyticsShareStore {
  create(scope: ShareScope): Promise<{ share: ShareRecord; token: string }>;
  list(scope: ShareScope): Promise<ShareRecord[]>;
  revoke(scope: ShareScope, id: string): Promise<boolean>;
  resolve(token: string): Promise<ShareRecord | null>;
}

export class AnalyticsShareLimitError extends Error {
  constructor() {
    super(`Maximum of ${ACTIVE_LIMIT} active analytics shares reached`);
    this.name = 'AnalyticsShareLimitError';
  }
}

function token(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let encoded = '';
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return TOKEN_PREFIX + btoa(encoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function record(row: {
  id: string;
  workspace_id: string;
  app_id: string;
  environment_id: string;
  created_at: number;
  revoked_at: number | null;
}): ShareRecord {
  return {
    id: row.id,
    workspace: row.workspace_id,
    app_id: row.app_id,
    environment_id: row.environment_id,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

function scopeValues(scope: ShareScope): [string, string, string] {
  return [scope.workspace, scope.app_id, scope.environment_id];
}

function pruneSql(): string {
  return `DELETE FROM analytics_shares
    WHERE workspace_id = ? AND app_id = ? AND environment_id = ?
      AND revoked_at IS NOT NULL
      AND id NOT IN (
        SELECT id FROM analytics_shares
        WHERE workspace_id = ? AND app_id = ? AND environment_id = ?
          AND revoked_at IS NOT NULL
        ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}
      )`;
}

export class D1AnalyticsShareStore implements AnalyticsShareStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async create(scope: ShareScope): Promise<{ share: ShareRecord; token: string }> {
    const rawToken = token();
    const now = Date.now();
    const share: ShareRecord = {
      ...scope,
      id: crypto.randomUUID(),
      created_at: now,
      revoked_at: null,
    };
    const values = scopeValues(scope);
    await this.prune(scope);
    const inserted = await this.db
      .prepare(
        `INSERT INTO analytics_shares
        (id, workspace_id, app_id, environment_id, token_hash, created_at, revoked_at)
        SELECT ?, ?, ?, ?, ?, ?, NULL
        WHERE (SELECT COUNT(*) FROM analytics_shares
          WHERE workspace_id = ? AND app_id = ? AND environment_id = ? AND revoked_at IS NULL) < ${ACTIVE_LIMIT}`,
      )
      .bind(
        share.id,
        scope.workspace,
        scope.app_id,
        scope.environment_id,
        await hash(rawToken),
        now,
        ...values,
      )
      .run();
    if (!inserted.meta.changes) throw new AnalyticsShareLimitError();
    return { share, token: rawToken };
  }

  async list(scope: ShareScope): Promise<ShareRecord[]> {
    const values = scopeValues(scope);
    const { results } = await this.db
      .prepare(
        `SELECT id, workspace_id, app_id, environment_id, created_at, revoked_at
        FROM analytics_shares WHERE workspace_id = ? AND app_id = ? AND environment_id = ?
        ORDER BY (revoked_at IS NOT NULL), created_at DESC, id DESC LIMIT ${HISTORY_LIMIT}`,
      )
      .bind(...values)
      .all();
    return results.map((row) => record(row as Parameters<typeof record>[0]));
  }

  async revoke(scope: ShareScope, id: string): Promise<boolean> {
    const values = scopeValues(scope);
    const found = await this.db
      .prepare(
        'SELECT id, revoked_at FROM analytics_shares WHERE id = ? AND workspace_id = ? AND app_id = ? AND environment_id = ?',
      )
      .bind(id, ...values)
      .first<{ id: string; revoked_at: number | null }>();
    if (!found) return false;
    if (found.revoked_at === null) {
      await this.db
        .prepare(
          'UPDATE analytics_shares SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND app_id = ? AND environment_id = ? AND revoked_at IS NULL',
        )
        .bind(Date.now(), id, ...values)
        .run();
    }
    await this.prune(scope);
    return true;
  }

  async resolve(rawToken: string): Promise<ShareRecord | null> {
    if (!TOKEN_PATTERN.test(rawToken)) return null;
    const row = await this.db
      .prepare(
        `SELECT id, workspace_id, app_id, environment_id, created_at, revoked_at
        FROM analytics_shares WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
      )
      .bind(await hash(rawToken))
      .first<Parameters<typeof record>[0]>();
    return row ? record(row) : null;
  }

  private async prune(scope: ShareScope): Promise<void> {
    const values = scopeValues(scope);
    await this.db
      .prepare(pruneSql())
      .bind(...values, ...values)
      .run();
  }
}

export class MemoryAnalyticsShareStore implements AnalyticsShareStore {
  private readonly shares = new Map<string, { share: ShareRecord; hash: string }>();
  private mutation: Promise<void> = Promise.resolve();

  async create(scope: ShareScope): Promise<{ share: ShareRecord; token: string }> {
    const rawToken = token();
    const share: ShareRecord = {
      ...scope,
      id: crypto.randomUUID(),
      created_at: Date.now(),
      revoked_at: null,
    };
    const tokenHash = await hash(rawToken);
    return this.serialized(() => {
      if (this.active(scope).length >= ACTIVE_LIMIT) throw new AnalyticsShareLimitError();
      this.shares.set(share.id, { share, hash: tokenHash });
      this.prune(scope);
      return { share: { ...share }, token: rawToken };
    });
  }

  async list(scope: ShareScope): Promise<ShareRecord[]> {
    return [...this.shares.values()]
      .map(({ share }) => share)
      .filter((share) => sameScope(share, scope))
      .sort(
        (left, right) =>
          Number(left.revoked_at !== null) - Number(right.revoked_at !== null) ||
          right.created_at - left.created_at ||
          right.id.localeCompare(left.id),
      )
      .slice(0, HISTORY_LIMIT)
      .map((share) => ({ ...share }));
  }

  async revoke(scope: ShareScope, id: string): Promise<boolean> {
    return this.serialized(() => {
      const entry = this.shares.get(id);
      if (!entry || !sameScope(entry.share, scope)) return false;
      if (entry.share.revoked_at === null) entry.share.revoked_at = Date.now();
      this.prune(scope);
      return true;
    });
  }

  async resolve(rawToken: string): Promise<ShareRecord | null> {
    if (!TOKEN_PATTERN.test(rawToken)) return null;
    const tokenHash = await hash(rawToken);
    for (const entry of this.shares.values()) {
      if (entry.hash === tokenHash && entry.share.revoked_at === null) return { ...entry.share };
    }
    return null;
  }

  private active(scope: ShareScope): ShareRecord[] {
    return [...this.shares.values()]
      .filter(({ share }) => sameScope(share, scope) && share.revoked_at === null)
      .map(({ share }) => share);
  }

  private prune(scope: ShareScope): void {
    const revoked = [...this.shares.values()]
      .filter(({ share }) => sameScope(share, scope) && share.revoked_at !== null)
      .sort((left, right) => right.share.created_at - left.share.created_at);
    for (const entry of revoked.slice(HISTORY_LIMIT)) this.shares.delete(entry.share.id);
  }

  private serialized<T>(operation: () => T): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function sameScope(left: ShareScope, right: ShareScope): boolean {
  return (
    left.workspace === right.workspace &&
    left.app_id === right.app_id &&
    left.environment_id === right.environment_id
  );
}
