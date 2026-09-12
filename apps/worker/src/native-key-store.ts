import { NativeKey } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import { generateRawKey, hashKey } from './crypto.js';

export type NativeScope = Pick<NativeKey, 'workspace_id' | 'app_id' | 'environment_id'>;
export class NativeKeyLimitError extends Error {
  constructor() {
    super('Maximum of five active native keys reached');
  }
}
interface NativeKeyStore {
  create(scope: NativeScope): Promise<{ key: string; record: NativeKey }>;
  list(scope: NativeScope): Promise<NativeKey[]>;
  revoke(scope: NativeScope, id: string): Promise<boolean>;
  resolve(key: string): Promise<NativeKey | null>;
}
const scopeValues = (scope: NativeScope) => [
  scope.workspace_id,
  scope.app_id,
  scope.environment_id,
];
const matches = (row: NativeKey, scope: NativeScope) =>
  scopeValues(row).join('/') === scopeValues(scope).join('/');
const keyPattern = /^ahk_native_[a-f0-9]{64}$/;
async function issue(scope: NativeScope) {
  const key = generateRawKey('ahk_native_');
  const record: NativeKey = {
    ...scope,
    id: crypto.randomUUID(),
    created_at: Date.now(),
    revoked_at: null,
  };
  return { key, record, verifier: await hashKey(key) };
}
const scopeWhere = 'workspace_id = ? AND app_id = ? AND environment_id = ?';
const fields = 'id, workspace_id, app_id, environment_id, created_at, revoked_at';

export class D1NativeKeyStore implements NativeKeyStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async create(scope: NativeScope) {
    const value = await issue(scope);
    await this.prune(scope);
    const result = await this.db
      .prepare(
        `INSERT INTO native_keys (${fields}, verifier_hash)
      SELECT ?, ?, ?, ?, ?, NULL, ? WHERE
      (SELECT COUNT(*) FROM native_keys WHERE ${scopeWhere} AND revoked_at IS NULL) < 5`,
      )
      .bind(
        value.record.id,
        ...scopeValues(scope),
        value.record.created_at,
        value.verifier,
        ...scopeValues(scope),
      )
      .run();
    if (!result.meta.changes) throw new NativeKeyLimitError();
    return { key: value.key, record: value.record };
  }
  async list(scope: NativeScope): Promise<NativeKey[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${fields} FROM native_keys WHERE ${scopeWhere}
      ORDER BY (revoked_at IS NOT NULL), created_at DESC, id DESC LIMIT 25`,
      )
      .bind(...scopeValues(scope))
      .all();
    return rows.results.map((row) => NativeKey.parse(row));
  }
  async resolve(key: string): Promise<NativeKey | null> {
    if (!keyPattern.test(key)) return null;
    const row = await this.db
      .prepare(`SELECT ${fields} FROM native_keys WHERE verifier_hash = ? AND revoked_at IS NULL`)
      .bind(await hashKey(key))
      .first();
    return row ? NativeKey.parse(row) : null;
  }
  async revoke(scope: NativeScope, id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE native_keys SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND ${scopeWhere}`,
      )
      .bind(Date.now(), id, ...scopeValues(scope))
      .run();
    await this.prune(scope);
    return (result.meta.changes ?? 0) > 0;
  }
  private async prune(scope: NativeScope) {
    await this.db
      .prepare(
        `DELETE FROM native_keys WHERE id IN (
      SELECT id FROM native_keys WHERE ${scopeWhere} AND revoked_at IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 20)`,
      )
      .bind(...scopeValues(scope))
      .run();
  }
}

export class MemoryNativeKeyStore implements NativeKeyStore {
  private readonly values = new Map<string, { record: NativeKey; verifier: string }>();
  async create(scope: NativeScope) {
    const value = await issue(scope);
    // No await between the capacity check and insert: concurrent creates cannot over-admit.
    const active = [...this.values.values()].filter(
      ({ record }) => matches(record, scope) && record.revoked_at === null,
    );
    if (active.length >= 5) throw new NativeKeyLimitError();
    this.values.set(value.record.id, { record: value.record, verifier: value.verifier });
    return { key: value.key, record: { ...value.record } };
  }
  async list(scope: NativeScope) {
    return [...this.values.values()]
      .map(({ record }) => record)
      .filter((row) => matches(row, scope))
      .sort(
        (a, b) =>
          Number(a.revoked_at !== null) - Number(b.revoked_at !== null) ||
          b.created_at - a.created_at,
      )
      .map((row) => ({ ...row }));
  }
  async resolve(key: string) {
    if (!keyPattern.test(key)) return null;
    const verifier = await hashKey(key);
    const value = [...this.values.values()].find(
      (value) => value.verifier === verifier && value.record.revoked_at === null,
    );
    return value ? { ...value.record } : null;
  }
  async revoke(scope: NativeScope, id: string) {
    const value = this.values.get(id);
    if (!value || !matches(value.record, scope)) return false;
    value.record.revoked_at ??= Date.now();
    const revoked = [...this.values.values()]
      .filter(({ record }) => matches(record, scope) && record.revoked_at !== null)
      .sort((a, b) => b.record.created_at - a.record.created_at);
    for (const row of revoked.slice(20)) this.values.delete(row.record.id);
    return true;
  }
}
