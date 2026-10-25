import { AnalysisRecord, type AnalysisDefinition, type AnalysisScope } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';

export type AnalysisStoreScope = AnalysisScope & { workspace: string };
export interface AnalysisStore {
  list(scope: AnalysisStoreScope): Promise<AnalysisRecord[]>;
  save(
    scope: AnalysisStoreScope,
    definition: AnalysisDefinition,
    id?: string,
  ): Promise<AnalysisRecord | null>;
  remove(scope: AnalysisStoreScope, id: string): Promise<boolean>;
}
const scopeKey = (scope: AnalysisStoreScope) =>
  JSON.stringify([scope.workspace, scope.app_id, scope.environment_id]);

export class LocalAnalysisStore implements AnalysisStore {
  private scopes = new Map<string, Map<string, AnalysisRecord>>();
  async list(scope: AnalysisStoreScope) {
    return [...(this.scopes.get(scopeKey(scope))?.values() ?? [])];
  }
  async save(scope: AnalysisStoreScope, definition: AnalysisDefinition, id?: string) {
    const key = scopeKey(scope);
    const records = this.scopes.get(key) ?? new Map<string, AnalysisRecord>();
    const old = id ? records.get(id) : undefined;
    if (id && !old) return null;
    if (!old && records.size >= 100) throw new Error('Analysis definition limit reached');
    if (!this.scopes.has(key) && this.scopes.size >= 1000)
      throw new Error('Local analysis scope limit reached');
    const record = AnalysisRecord.parse({
      id: id ?? crypto.randomUUID(),
      definition,
      created_at: old?.created_at ?? Date.now(),
      updated_at: Date.now(),
    });
    records.set(record.id, record);
    this.scopes.set(key, records);
    return record;
  }
  async remove(scope: AnalysisStoreScope, id: string) {
    const key = scopeKey(scope);
    const records = this.scopes.get(key);
    const removed = records?.delete(id) ?? false;
    if (records?.size === 0) this.scopes.delete(key);
    return removed;
  }
}

type DefinitionRow = {
  id: string;
  definition_json: string;
  created_at: number;
  updated_at: number;
};
function decode(row: DefinitionRow): AnalysisRecord {
  return AnalysisRecord.parse({
    id: row.id,
    definition: JSON.parse(row.definition_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
const bindings = (scope: AnalysisStoreScope) => [
  scope.workspace,
  scope.app_id,
  scope.environment_id,
];

export class D1AnalysisStore implements AnalysisStore {
  constructor(private readonly db: D1DatabaseLike) {}
  async list(scope: AnalysisStoreScope) {
    const rows = await this.db
      .prepare(
        'SELECT id, definition_json, created_at, updated_at FROM analytics_definitions WHERE workspace_id = ? AND app_id = ? AND environment_id = ? ORDER BY created_at, id LIMIT 101',
      )
      .bind(...bindings(scope))
      .all<DefinitionRow>();
    if (rows.results.length > 100) throw new Error('Analysis definition limit exceeded');
    return rows.results.map(decode);
  }
  async save(scope: AnalysisStoreScope, definition: AnalysisDefinition, id?: string) {
    const now = Date.now();
    const recordId = id ?? crypto.randomUUID();
    const body = JSON.stringify(definition);
    if (id) {
      const result = await this.db
        .prepare(
          'UPDATE analytics_definitions SET kind = ?, name = ?, definition_json = ?, updated_at = ? WHERE workspace_id = ? AND app_id = ? AND environment_id = ? AND id = ?',
        )
        .bind(definition.kind, definition.name, body, now, ...bindings(scope), id)
        .run();
      if (!result.meta.changes) return null;
    } else {
      await this.db
        .prepare(
          'INSERT INTO analytics_definitions (id, workspace_id, app_id, environment_id, kind, name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(recordId, ...bindings(scope), definition.kind, definition.name, body, now, now)
        .run();
    }
    const row = await this.db
      .prepare(
        'SELECT id, definition_json, created_at, updated_at FROM analytics_definitions WHERE workspace_id = ? AND app_id = ? AND environment_id = ? AND id = ?',
      )
      .bind(...bindings(scope), recordId)
      .first<DefinitionRow>();
    return row ? decode(row) : null;
  }
  async remove(scope: AnalysisStoreScope, id: string) {
    const result = await this.db
      .prepare(
        'DELETE FROM analytics_definitions WHERE workspace_id = ? AND app_id = ? AND environment_id = ? AND id = ?',
      )
      .bind(...bindings(scope), id)
      .run();
    return result.meta.changes === 1;
  }
}
