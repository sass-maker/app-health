import { CAPABILITY_IDS, type CapabilityId, type CapabilityState } from '@app-health/contracts';
import type { CapabilityRepository } from './repository.js';
import type { D1DatabaseLike } from './d1-adapter.js';

const empty = (id: CapabilityId): CapabilityState => ({
  id,
  enabled: false,
  first_received_at: null,
  last_received_at: null,
});

export class MemoryCapabilities implements CapabilityRepository {
  private readonly rows = new Map<string, CapabilityState[]>();
  private read(app: string, env: string): CapabilityState[] {
    return (this.rows.get(`${app}:${env}`) ?? CAPABILITY_IDS.map(empty)).map((row) => ({ ...row }));
  }
  async getCapabilities(app: string, env: string): Promise<CapabilityState[]> {
    return this.read(app, env);
  }
  async setCapabilities(app: string, env: string, enabled: readonly CapabilityId[]) {
    const rows = this.read(app, env);
    this.rows.set(
      `${app}:${env}`,
      rows.map((row) => ({ ...row, enabled: enabled.includes(row.id) })),
    );
  }
  async recordCapability(app: string, env: string, id: CapabilityId, now: number) {
    const rows = this.read(app, env);
    const row = rows.find((candidate) => candidate.id === id)!;
    if (row.first_received_at === null) row.enabled = true;
    row.first_received_at ??= now;
    row.last_received_at = Math.max(row.last_received_at ?? 0, now);
    this.rows.set(`${app}:${env}`, rows);
  }
}

export class D1Capabilities implements CapabilityRepository {
  constructor(private readonly db: D1DatabaseLike) {}
  async getCapabilities(app: string, env: string): Promise<CapabilityState[]> {
    const { results } = await this.db
      .prepare(
        'SELECT capability AS id, enabled, first_received_at, last_received_at FROM environment_capabilities WHERE app_id = ? AND environment_id = ?',
      )
      .bind(app, env)
      .all<Omit<CapabilityState, 'enabled'> & { enabled: number }>();
    return CAPABILITY_IDS.map((id) => {
      const row = results.find((candidate) => candidate.id === id);
      return row ? { ...row, enabled: Boolean(row.enabled) } : empty(id);
    });
  }
  async setCapabilities(app: string, env: string, enabled: readonly CapabilityId[]) {
    const results = await this.db.batch(
      CAPABILITY_IDS.map((id) =>
        this.db
          .prepare(
            'INSERT INTO environment_capabilities (app_id, environment_id, capability, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(app_id, environment_id, capability) DO UPDATE SET enabled = excluded.enabled',
          )
          .bind(app, env, id, enabled.includes(id) ? 1 : 0),
      ),
    );
    if (results.some((result) => !result.success))
      throw new Error('Capability preferences could not be saved');
  }
  async recordCapability(app: string, env: string, id: CapabilityId, now: number) {
    await this.db
      .prepare(
        'INSERT INTO environment_capabilities (app_id, environment_id, capability, enabled, first_received_at, last_received_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(app_id, environment_id, capability) DO UPDATE SET enabled = CASE WHEN environment_capabilities.first_received_at IS NULL THEN 1 ELSE environment_capabilities.enabled END, first_received_at = COALESCE(environment_capabilities.first_received_at, excluded.first_received_at), last_received_at = MAX(COALESCE(environment_capabilities.last_received_at, 0), excluded.last_received_at)',
      )
      .bind(app, env, id, now, now)
      .run();
  }
}
