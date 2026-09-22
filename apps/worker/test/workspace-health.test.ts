import { describe, expect, it } from 'vitest';
import { SEED_APP_ID, SEED_ENV_ID, WorkspaceHealthSummaryV1 } from '@app-health/contracts';
import worker, { AppHealthService, InMemoryAdapter, type Env } from '../src/index.js';
import { workspaceEndpointState } from '../src/workspace-health.js';

describe('workspace Watchtower health', () => {
  it('classifies setup and freshness states without inventing traffic', () => {
    const now = 1_800_000_000_000;
    expect(workspaceEndpointState(false, null, null, false, now)).toBe('unconfigured');
    expect(workspaceEndpointState(false, null, null, true, now)).toBe('waiting');
    expect(workspaceEndpointState(true, now - 1_000, now - 1_000, false, now)).toBe('revoked');
    expect(workspaceEndpointState(true, now - 1_000, now - 16 * 60_000, true, now)).toBe('stale');
    expect(workspaceEndpointState(true, now - 1_000, now - 60_000, true, now)).toBe('connected');
  });

  it('aggregates the local portfolio into one validated 24-hour response', async () => {
    const adapter = await InMemoryAdapter.create();
    const response = await new AppHealthService(adapter.asRepositories()).queryWorkspaceHealth(
      Date.now(),
    );
    expect(WorkspaceHealthSummaryV1.parse(response)).toEqual(response);
    expect(response.window).toBe('24h');
    expect(response.environments).toHaveLength(1);
    expect(response.environments[0]).toMatchObject({
      app_id: SEED_APP_ID,
      environment_id: SEED_ENV_ID,
      endpoints: {
        state: 'connected',
        runtime: 'node',
        metrics: { request_count: 30, error_count: 2 },
      },
    });
  });

  it('serves the owner-only route with no-store semantics', async () => {
    const env: Env = { APP_HEALTH_MODE: 'local' };
    const response = await worker.fetch(
      new Request('https://worker.local/v1/workspace/health'),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(WorkspaceHealthSummaryV1.safeParse(await response.json()).success).toBe(true);
  });
});
