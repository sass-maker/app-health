import { expect, it, vi } from 'vitest';
import { D1ControlPlane } from '../src/d1-adapter.js';
import { importCatalogProjects } from '../src/catalog-import.js';
import { readMonitoringReport, saveMonitoringPolicy } from '../src/monitoring.js';
import { runScheduledMonitoring, workerMeasure } from '../src/monitoring-scheduled.js';
import { analysisDatabase } from './analysis-sqlite.js';

it('runs only an explicitly declared owned public check, persists incidents and recovery atomically, and respects the lease', async () => {
  const { db, sqlite } = analysisDatabase();
  const now = 1800000000000;
  try {
    const key = await new D1ControlPlane(db).createKey('app', 'env', now);
    const env = { DB: db, APP_HEALTH_SELF_BACKEND_KEY: key.rawKey };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    await Promise.all([
      runScheduledMonitoring(env, fetcher, now),
      runScheduledMonitoring(env, fetcher, now),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    await importCatalogProjects(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'app-health',
            name: 'Health',
            existing_app_id: 'app',
            repository: null,
            hostname: null,
            lifecycle: 'active',
          },
        ],
      },
      now,
    );
    await saveMonitoringPolicy(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'app-health',
            name: 'Health',
            scope: 'public',
            reason: null,
            journeys: ['api-health'],
          },
          {
            catalog_id: 'private',
            name: 'Private',
            scope: 'private',
            reason: 'Private app.',
            journeys: [],
          },
        ],
      },
      now,
    );
    fetcher.mockImplementation(async () => new Response('down', { status: 503 }));
    await runScheduledMonitoring(env, fetcher, now);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://health.sassmaker.com/v1/health');
    expect(
      (await readMonitoringReport(db, 'ws', now)).projects.find(
        (p) => p.catalog_id === 'app-health',
      )?.state,
    ).toBe('failing');
    await runScheduledMonitoring(env, fetcher, now + 60000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => Response.json({ ok: true }));
    await runScheduledMonitoring(env, fetcher, now + 3600000);
    expect(
      (await readMonitoringReport(db, 'ws', now + 3600000)).projects.find(
        (p) => p.catalog_id === 'app-health',
      )?.state,
    ).toBe('failing');
    await runScheduledMonitoring(env, fetcher, now + 7200000);
    expect(
      (await readMonitoringReport(db, 'ws', now + 7200000)).projects.find(
        (p) => p.catalog_id === 'app-health',
      )?.state,
    ).toBe('healthy');
    expect(
      sqlite
        .prepare("SELECT event FROM log_events WHERE event LIKE 'journey.%' ORDER BY timestamp")
        .all()
        .map((row) => row.event),
    ).toEqual(['journey.failed', 'journey.recovered']);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM log_events WHERE event='probe.result'").get()?.n,
    ).toBe(3);
    expect(
      (await readMonitoringReport(db, 'ws', now + 19000000)).projects.find(
        (p) => p.catalog_id === 'app-health',
      )?.state,
    ).toBe('stale');
    const before = fetcher.mock.calls.length;
    await runScheduledMonitoring(
      { ...env, APP_HEALTH_SELF_APP_ID: 'other-app' },
      fetcher,
      now + 20000000,
    );
    expect(fetcher).toHaveBeenCalledTimes(before);
    const stored = JSON.stringify(sqlite.prepare('SELECT * FROM log_events').all());
    expect(stored).not.toContain(key.rawKey);
    expect(stored).not.toContain('https://');
  } finally {
    sqlite.close();
  }
});

it('keeps complete-body deadlines and byte limits on Worker fetch measurements', async () => {
  const measure = workerMeasure(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
      ),
    Date.now() + 10000,
  );
  const request = {
    url: 'https://public.test/',
    method: 'GET' as const,
    timeoutMs: 10,
    maxBytes: 100,
    userAgent: 'test',
  };
  expect(await measure(request)).toMatchObject({ failure: 'timeout' });
  const oversized = workerMeasure(async () => new Response('too large'), Date.now() + 10000);
  expect(await oversized({ ...request, maxBytes: 3 })).toMatchObject({ failure: 'body_too_large' });
});

it('rolls back incident state together with logs when durable delivery fails', async () => {
  const { db, sqlite } = analysisDatabase();
  const now = 1800000000000;
  try {
    const key = await new D1ControlPlane(db).createKey('app', 'env', now);
    await importCatalogProjects(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'app-health',
            name: 'Health',
            existing_app_id: 'app',
            repository: null,
            hostname: null,
            lifecycle: 'active',
          },
        ],
      },
      now,
    );
    await saveMonitoringPolicy(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'app-health',
            name: 'Health',
            scope: 'public',
            reason: null,
            journeys: ['api-health'],
          },
        ],
      },
      now,
    );
    sqlite.exec(
      "CREATE TRIGGER fail_probe_write BEFORE INSERT ON log_events BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END",
    );
    const env = { DB: db, APP_HEALTH_SELF_BACKEND_KEY: key.rawKey };
    const fetcher: typeof fetch = async () => new Response('down', { status: 503 });
    await expect(runScheduledMonitoring(env, fetcher, now)).rejects.toThrow(
      'synthetic storage failure',
    );
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM log_events').get()?.n).toBe(0);
    const state = JSON.parse(
      String(sqlite.prepare('SELECT state_json FROM workspace_monitoring_runs').get()?.state_json),
    );
    expect(state.journeys).toEqual({});
    sqlite.exec('DROP TRIGGER fail_probe_write');
    await runScheduledMonitoring(env, fetcher, now + 3600000);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM log_events WHERE event='journey.failed'").get()?.n,
    ).toBe(1);
  } finally {
    sqlite.close();
  }
});

it.each(['key-revoked', 'policy-changed', 'source-moved'])(
  'fences a completed fetch when %s before commit',
  async (change) => {
    const { db, sqlite } = analysisDatabase();
    const now = 1800000000000;
    try {
      const control = new D1ControlPlane(db);
      const key = await control.createKey('app', 'env', now);
      await importCatalogProjects(
        db,
        'ws',
        {
          schema_version: 1,
          projects: [
            {
              catalog_id: 'app-health',
              name: 'Health',
              existing_app_id: 'app',
              repository: null,
              hostname: null,
              lifecycle: 'active',
            },
          ],
        },
        now,
      );
      const policy = {
        schema_version: 1 as const,
        projects: [
          {
            catalog_id: 'app-health',
            name: 'Health',
            scope: 'public' as const,
            reason: null,
            journeys: ['api-health'],
          },
        ],
      };
      await saveMonitoringPolicy(db, 'ws', policy, now);
      const fetcher: typeof fetch = async () => {
        if (change === 'key-revoked') await control.revokeKey(key.record.id, now + 1);
        if (change === 'policy-changed') await saveMonitoringPolicy(db, 'ws', policy, now);
        if (change === 'source-moved') sqlite.exec("DELETE FROM workspace_apps WHERE app_id='app'");
        return Response.json({ ok: true });
      };
      await expect(
        runScheduledMonitoring({ DB: db, APP_HEALTH_SELF_BACKEND_KEY: key.rawKey }, fetcher, now),
      ).rejects.toThrow('Monitoring run commit failed');
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM log_events').get()?.n).toBe(0);
      expect(
        JSON.parse(
          String(
            sqlite.prepare('SELECT state_json FROM workspace_monitoring_runs').get()?.state_json,
          ),
        ).journeys,
      ).toEqual({});
    } finally {
      sqlite.close();
    }
  },
);
