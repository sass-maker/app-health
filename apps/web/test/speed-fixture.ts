import type { SpeedReportV1 } from '@app-health/contracts';

export function speedFixture(): SpeedReportV1 {
  const measured: SpeedReportV1['products'][number] = {
    catalog_id: 'atlas',
    app_id: 'app-atlas',
    name: 'Atlas',
    state: 'measured',
    rejected: 3,
    vitals: {
      samples: 60,
      truncated: true,
      routes: [
        {
          route_group: '/articles',
          samples: 60,
          lcp_ms: { p75: 2800 },
          inp_ms: { p75: 140 },
          cls_milli: { p75: 75 },
          ttfb_ms: null,
          breaches: [{ metric: 'lcp_ms', value: 2800, budget: 2500 }],
          sustained: 'breach',
        },
      ],
    },
    server: {
      samples: 40,
      truncated: false,
      routes: [
        {
          route: '/api/articles/:id',
          samples: 40,
          error_rate: 0.025,
          total_ms: { p50: 100, p95: 700, p99: 900 },
          cache: {
            HIT: 18,
            MISS: 12,
            EXPIRED: 0,
            BYPASS: 0,
            DYNAMIC: 0,
            STALE: 0,
            REVALIDATED: 0,
            NONE: 10,
            hit_ratio: 0.6,
          },
          colos: [
            { colo: 'BOM', samples: 30, p95_ms: 650 },
            { colo: 'SIN', samples: 10, p95_ms: 700 },
          ],
          stages_p95_ms: { db_ms: 90, render_ms: 25 },
          breaches: [{ metric: 'total_ms.p95', value: 700, budget: 500 }],
          sustained: 'insufficient',
        },
      ],
    },
  };
  const healthy = structuredClone(measured);
  healthy.catalog_id = 'beacon';
  healthy.app_id = 'app-beacon';
  healthy.name = 'Beacon';
  healthy.vitals.truncated = false;
  healthy.rejected = 0;
  healthy.vitals.routes[0].lcp_ms = { p75: 1200 };
  healthy.vitals.routes[0].breaches = [];
  healthy.vitals.routes[0].sustained = 'ok';
  healthy.server.routes[0].total_ms = { p50: 80, p95: 250, p99: 450 };
  healthy.server.routes[0].error_rate = 0;
  healthy.server.routes[0].breaches = [];
  healthy.server.routes[0].sustained = 'ok';
  const insufficient = structuredClone(healthy);
  insufficient.catalog_id = 'cedar';
  insufficient.app_id = 'app-cedar';
  insufficient.name = 'Cedar';
  insufficient.state = 'insufficient';
  insufficient.vitals.samples = 4;
  insufficient.vitals.routes[0].samples = 4;
  insufficient.vitals.routes[0].lcp_ms = { p75: 4000 };
  insufficient.vitals.routes[0].sustained = 'insufficient';
  insufficient.server = { samples: 0, truncated: false, routes: [] };
  return {
    range: '24h',
    class: 'app',
    generated_at: 1791633600000,
    budgets: {
      vitals: {
        lcp_ms: { p75: 2500 },
        inp_ms: { p75: 200 },
        cls_milli: { p75: 100 },
        ttfb_ms: { p75: 800 },
      },
      server: { p50: 150, p95: 500, p99: 1500 },
    },
    min_samples: { vitals: 50, server: 30, alert_window: 30 },
    products: [
      measured,
      healthy,
      insufficient,
      {
        catalog_id: 'drift',
        app_id: 'app-drift',
        name: 'Drift',
        state: 'no_data',
        rejected: 0,
        vitals: { samples: 0, truncated: true, routes: [] },
        server: { samples: 0, truncated: false, routes: [] },
      },
    ],
    summary: { measured: 2, insufficient: 1, no_data: 1, breaching: 1 },
  };
}
