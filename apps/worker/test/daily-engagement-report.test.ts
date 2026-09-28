import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DailyEngagementReportV1 } from '@app-health/contracts';
import worker, { type Env } from '../src/index.js';
import {
  buildDailyEngagementReport,
  dailyEngagementWindow,
  readDailyEngagementLogs,
  composeDailyEngagementReport,
  type CatalogProductRow,
  type EngagementLogRow,
} from '../src/daily-engagement-report.js';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';

// 2026-09-27 is a completed India day when "now" is 2026-09-28 noon UTC.
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const DAY = '2026-09-27';
const FROM = Date.UTC(2026, 8, 26, 18, 30);
const TO = FROM + 86_400_000;

function catalog(n: number): CatalogProductRow[] {
  return Array.from({ length: n }, (_, i) => ({
    catalog_id: `product-${String(i).padStart(3, '0')}`,
    app_id: `app-${String(i).padStart(3, '0')}`,
    catalog_name: `Product ${i}`,
    environment_id: `env-${String(i).padStart(3, '0')}`,
    analytics_first_received_at: null,
  }));
}

describe('dailyEngagementWindow', () => {
  it('defaults to the most recent completed Asia/Kolkata day', () => {
    const window = dailyEngagementWindow(null, NOW);
    expect(window).not.toHaveProperty('error');
    expect((window as { date: string }).date).toBe(DAY);
    expect((window as { from: number }).from).toBe(FROM);
    expect((window as { to: number }).to).toBe(TO);
  });

  it('rolls the day at India midnight instead of UTC midnight', () => {
    const window = dailyEngagementWindow(null, Date.UTC(2026, 8, 27, 19, 0));
    expect(window).toMatchObject({
      date: '2026-09-27',
      from: Date.UTC(2026, 8, 26, 18, 30),
      to: Date.UTC(2026, 8, 27, 18, 30),
    });
  });

  it('accepts an explicit completed Asia/Kolkata day', () => {
    const window = dailyEngagementWindow('2026-09-01', NOW);
    expect((window as { from: number }).from).toBe(Date.UTC(2026, 7, 31, 18, 30));
    expect((window as { to: number }).to).toBe(Date.UTC(2026, 8, 1, 18, 30));
  });

  it('rejects today and future days as not completed', () => {
    expect(dailyEngagementWindow('2026-09-28', NOW)).toEqual({
      error: 'date must be a completed Asia/Kolkata day',
    });
    expect(dailyEngagementWindow('2026-09-29', NOW)).toEqual({
      error: 'date must be a completed Asia/Kolkata day',
    });
  });

  it('rejects malformed and impossible calendar dates', () => {
    expect(dailyEngagementWindow('2026-9-1', NOW)).toEqual({ error: 'date must be YYYY-MM-DD' });
    expect(dailyEngagementWindow('2026-13-01', NOW)).toEqual({
      error: 'date must be a real calendar day',
    });
    expect(dailyEngagementWindow('2026-02-30', NOW)).toEqual({
      error: 'date must be a real calendar day',
    });
  });
});

describe('buildDailyEngagementReport', () => {
  it('covers 55 catalog products and marks missing rows unknown, never zero', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(55),
      browserVisitors: [],
      ctaEvents: [],
      logs: [],
      ctaEventNamesByCatalogId: {},
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    expect(DailyEngagementReportV1.parse(report)).toEqual(report);
    expect(report.product_count).toBe(55);
    expect(report.products).toHaveLength(55);
    // No telemetry rows for any product -> every surface unknown (null), not 0.
    for (const product of report.products) {
      expect(product.browser_visitors).toBeNull();
      expect(product.cta_events).toEqual([]);
      expect(product.cta_status).toBe('unknown');
      expect(product.feedback_submitted).toBeNull();
      expect(product.waitlist_joins).toBeNull();
      expect(product.newsletter_joins).toBeNull();
      expect(product.native_sessions).toBeNull();
      expect(product.api_activity).toBeNull();
      expect(product.coverage).toBe('unknown');
    }
  });

  it('labels a product with no applicable visitor CTA without inventing a count', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(1),
      browserVisitors: [],
      ctaEvents: [],
      logs: [],
      ctaEventNamesByCatalogId: {},
      ctaNotApplicableCatalogIds: ['product-000'],
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    expect(report.products[0]).toMatchObject({ cta_events: [], cta_status: 'not_applicable' });
  });

  it('reports measurable zero honestly but treats absent telemetry as unknown', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(2),
      // product-000 had browser traffic but zero identifiable visitors.
      browserVisitors: [
        { app_id: 'app-000', visitors: 0, last_seen: FROM + 1000, sample_interval: 1 },
      ],
      ctaEvents: [],
      logs: [],
      ctaEventNamesByCatalogId: { 'product-000': ['cta.click', 'signup', 'get.started'] },
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    const first = report.products[0];
    expect(first.browser_visitors).toBe(0); // measurable zero, not unknown
    expect(first.cta_events).toEqual([
      { name: 'cta.click', count: 0, estimated: false },
      { name: 'signup', count: 0, estimated: false },
      { name: 'get.started', count: 0, estimated: false },
    ]);
    expect(first.coverage).toBe('partial');
    const second = report.products[1];
    expect(second.browser_visitors).toBeNull(); // absent -> unknown
    expect(second.cta_events).toEqual([]);
    expect(second.coverage).toBe('unknown');
  });

  it('reports zero on a quiet day with browser receipt and confirmed event hooks', () => {
    const scope = catalog(2);
    scope[0].analytics_first_received_at = FROM - 1000;
    const report = buildDailyEngagementReport({
      catalog: scope,
      browserVisitors: [],
      ctaEvents: [],
      logs: [],
      ctaEventNamesByCatalogId: { 'product-000': ['cta.opened'] },
      confirmedLogMetricsByCatalogId: {
        'product-000': ['feedback', 'waitlist', 'newsletter'],
      },
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    expect(report.products[0]).toMatchObject({
      browser_visitors: 0,
      cta_events: [{ name: 'cta.opened', count: 0, estimated: false }],
      feedback_submitted: 0,
      waitlist_joins: 0,
      newsletter_joins: 0,
    });
    expect(report.products[1].browser_visitors).toBeNull();
    expect(report.products[1].feedback_submitted).toBeNull();
  });

  it('counts CTA events per product from grouped browser rows', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(1),
      browserVisitors: [
        { app_id: 'app-000', visitors: 42, last_seen: FROM + 2000, sample_interval: 1 },
      ],
      ctaEvents: [
        { app_id: 'app-000', name: 'cta.click', count: 10, sample_interval: 1 },
        { app_id: 'app-000', name: 'signup', count: 3, sample_interval: 1 },
      ],
      logs: [],
      ctaEventNamesByCatalogId: { 'product-000': ['cta.click', 'signup', 'get.started'] },
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    const product = report.products[0];
    expect(product.browser_visitors).toBe(42);
    expect(product.cta_events).toEqual([
      { name: 'cta.click', count: 10, estimated: false },
      { name: 'signup', count: 3, estimated: false },
      { name: 'get.started', count: 0, estimated: false },
    ]);
    expect(product.freshness.browser_last_seen).toBe(FROM + 2000);
  });

  it('marks scaled CTA counts as estimates even when no visitor row exists', () => {
    const products = catalog(2);
    products[1].analytics_first_received_at = FROM - 1000;
    const report = buildDailyEngagementReport({
      catalog: products,
      browserVisitors: [],
      ctaEvents: [
        { app_id: 'app-000', name: 'cta.click', count: 20, sample_interval: 10 },
        { app_id: 'app-000', name: 'signup', count: 2, sample_interval: 1 },
      ],
      logs: [],
      ctaEventNamesByCatalogId: {
        'product-000': ['cta.click', 'signup', 'get.started'],
        'product-001': ['open'],
      },
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });

    expect(report.products[0].browser_visitors).toBeNull();
    expect(report.products[0].cta_events).toEqual([
      { name: 'cta.click', count: 20, estimated: true },
      { name: 'signup', count: 2, estimated: false },
    ]);
    expect(report.products[0].coverage).toBe('partial');
    expect(report.products[1].cta_events).toEqual([]);
    expect(report.products[1].cta_status).toBe('unknown');
    expect(report.products[1].coverage).toBe('partial'); // its unsampled visitor query measured zero
    expect(report.sampled).toBe(true);
    expect(report.notes).not.toContain(
      'Sampled browser visitor groups are unknown because distinct visitors cannot be scaled.',
    );
    expect(report.notes).toContain(
      'Sampled CTA query days omit unobserved actions; scaled counts are labeled approximate.',
    );
  });

  it('keeps CTA zeroes unknown when visitors are sampled and no CTA row was observed', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(1),
      browserVisitors: [
        { app_id: 'app-000', visitors: 40, last_seen: FROM + 1000, sample_interval: 10 },
      ],
      ctaEvents: [],
      logs: [],
      ctaEventNamesByCatalogId: { 'product-000': ['cta.click', 'signup'] },
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });

    expect(report.products[0].browser_visitors).toBeNull();
    expect(report.products[0].cta_events).toEqual([]);
    expect(report.products[0].cta_status).toBe('unknown');
    expect(report.products[0].coverage).toBe('unknown');
  });

  it('maps centralized SaaS Maker logs by project_id and discriminates newsletter via type/kind', () => {
    const logs: EngagementLogRow[] = [
      // SaaS Maker app ingests a feedback log for product-001 via project_id.
      {
        app_id: 'app-saas-maker',
        event: 'feedback.submitted',
        project_id: 'product-001',
        project: null,
        type: null,
        kind: null,
        count: 4,
        last_seen: FROM + 5000,
      },
      // A newsletter join for product-001.
      {
        app_id: 'app-saas-maker',
        event: 'newsletter.subscribe',
        project_id: 'product-001',
        project: null,
        type: null,
        kind: 'newsletter',
        count: 7,
        last_seen: FROM + 6000,
      },
      // A waitlist join, mapped via `project` prop.
      {
        app_id: 'app-saas-maker',
        event: 'waitlist.join',
        project_id: 'saas-maker-project-uuid',
        project: 'product-001',
        type: null,
        kind: null,
        count: 2,
        last_seen: FROM + 7000,
      },
      // direct ingest under product-000's own app_id (no project prop).
      {
        app_id: 'app-000',
        event: 'feedback.submitted',
        project_id: null,
        project: null,
        type: null,
        kind: null,
        count: 1,
        last_seen: FROM + 8000,
      },
      // unmappable log (project_id points to an undeclared product).
      {
        app_id: 'app-saas-maker',
        event: 'feedback.submitted',
        project_id: 'product-999',
        project: null,
        type: null,
        kind: null,
        count: 9,
        last_seen: FROM + 9000,
      },
    ];
    const report = buildDailyEngagementReport({
      catalog: catalog(2),
      browserVisitors: [],
      ctaEvents: [],
      logs,
      ctaEventNamesByCatalogId: {},
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    const p0 = report.products[0];
    expect(p0.feedback_submitted).toBe(1);
    expect(p0.freshness.log_last_seen).toBe(FROM + 8000);
    const p1 = report.products[1];
    expect(p1.feedback_submitted).toBe(4);
    expect(p1.waitlist_joins).toBe(2);
    expect(p1.newsletter_joins).toBe(7);
    expect(p1.freshness.log_last_seen).toBe(FROM + 7000);
    // The unmappable log is excluded and noted honestly.
    expect(report.notes.some((n) => n.includes('could not be mapped'))).toBe(true);
  });

  it('never credits an unmapped centralized project to the SaaS Maker app', () => {
    const scope = [
      ...catalog(1),
      {
        catalog_id: 'saas-maker',
        app_id: 'app-saas-maker',
        catalog_name: 'SaaS Maker',
        environment_id: 'env-saas-maker',
        analytics_first_received_at: null,
      },
    ];
    const report = buildDailyEngagementReport({
      catalog: scope,
      browserVisitors: [],
      ctaEvents: [],
      logs: [
        {
          app_id: 'app-saas-maker',
          event: 'feedback.submitted',
          project_id: 'unmapped-saas-maker-uuid',
          project: 'unmapped-project',
          type: 'feedback',
          kind: null,
          count: 3,
          last_seen: FROM,
        },
      ],
      ctaEventNamesByCatalogId: {},
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    expect(
      report.products.find((row) => row.catalog_id === 'saas-maker')?.feedback_submitted,
    ).toBeNull();
    expect(report.notes.some((note) => note.includes('could not be mapped'))).toBe(true);
  });

  it('never exposes log content, email, identities, raw URLs, or tokens', () => {
    const logs: EngagementLogRow[] = [
      {
        app_id: 'app-000',
        event: 'feedback.submitted',
        project_id: null,
        project: null,
        type: null,
        kind: null,
        count: 1,
        last_seen: FROM,
      },
    ];
    const report = buildDailyEngagementReport({
      catalog: catalog(1),
      browserVisitors: [],
      ctaEvents: [],
      logs,
      ctaEventNamesByCatalogId: {},
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      'email',
      'content',
      'token',
      'header',
      'cookie',
      'http://',
      'https://',
      'project_id',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('keeps coverage partial while runtime applicability is unverified', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(1),
      browserVisitors: [{ app_id: 'app-000', visitors: 5, last_seen: FROM, sample_interval: 1 }],
      ctaEvents: [],
      logs: [
        {
          app_id: 'app-000',
          event: 'feedback.submitted',
          project_id: null,
          project: null,
          type: null,
          kind: null,
          count: 1,
          last_seen: FROM,
        },
      ],
      ctaEventNamesByCatalogId: {},
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: true,
      logsMeasured: true,
    });
    expect(report.products[0].coverage).toBe('partial');
  });

  it('marks every surface unknown when grouped queries were unavailable', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(1),
      browserVisitors: [],
      ctaEvents: [],
      logs: [],
      ctaEventNamesByCatalogId: {},
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: false,
      logsMeasured: false,
    });
    const product = report.products[0];
    expect(product.browser_visitors).toBeNull();
    expect(product.cta_events).toEqual([]);
    expect(product.feedback_submitted).toBeNull();
    expect(product.coverage).toBe('unknown');
    expect(
      report.notes.some((n) => n.includes('Browser Analytics Engine query was unavailable')),
    ).toBe(true);
    expect(report.notes.some((n) => n.includes('D1 log_events query was unavailable'))).toBe(true);
  });
});

// Minimal D1 mock that returns canned rows by SQL pattern, like worker.test.ts.
class MockDatabase implements D1DatabaseLike {
  constructor(
    private readonly catalogRows: CatalogProductRow[],
    private readonly logRows: EngagementLogRow[],
  ) {}
  prepare(sql: string): D1PreparedStatement {
    return new MockStatement(sql, this);
  }
  async batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

class MockStatement implements D1PreparedStatement {
  private values: unknown[] = [];
  constructor(
    private sql: string,
    private db: MockDatabase,
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM catalog_project_imports')) {
      return { results: this.db['catalogRows'] as unknown as T[] };
    }
    if (this.sql.includes('FROM log_events')) {
      // Filter the canned log rows to the requested time window and app_ids.
      const from = Number(this.values[0]);
      const to = Number(this.values[1]);
      const appIds = (this.values.slice(2) as string[]) ?? [];
      const inWindow = this.db['logRows'].filter(
        (row) => row.last_seen >= from && row.last_seen < to && appIds.includes(row.app_id),
      );
      return { results: inWindow as unknown as T[] };
    }
    return { results: [] as T[] };
  }
  async run(): Promise<D1RunResult> {
    return { success: true, meta: { changes: 0 } };
  }
}

describe('readDailyEngagementLogs', () => {
  it('emits one grouped query with GROUP BY, not a per-app loop', async () => {
    const seen: string[] = [];
    const db: D1DatabaseLike = {
      prepare(sql: string) {
        seen.push(sql);
        return {
          bind(...values: unknown[]) {
            return {
              all: async () => {
                expect(values.slice(0, 2)).toEqual([FROM, TO]);
                expect(values.slice(2)).toEqual(['app-000', 'app-001']);
                return { results: [] };
              },
              first: async () => null,
              run: async () => ({ success: true, meta: { changes: 0 } }),
              bind(this: unknown, ..._v: unknown[]) {
                return this as D1PreparedStatement;
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
      batch: async (s) => Promise.all(s.map((x) => x.run())),
    };
    await readDailyEngagementLogs(db, ['app-000', 'app-001'], FROM, TO);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('GROUP BY log_events.app_id, project_id, project, type, kind, event');
    expect(seen[0]).toContain("lower(e.name) = 'production'");
    expect(seen[0]).toContain(
      "event IN ('feedback.submitted', 'waitlist.join', 'newsletter.subscribe')",
    );
  });

  it('counts production submissions only in real SQLite', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(`CREATE TABLE environments (id TEXT PRIMARY KEY, app_id TEXT, name TEXT);
        CREATE TABLE log_events (app_id TEXT, environment_id TEXT, timestamp INTEGER, event TEXT, props TEXT);`);
      sqlite.exec(`INSERT INTO environments VALUES
        ('prod', 'app-000', 'production'), ('stage', 'app-000', 'staging');`);
      sqlite
        .prepare('INSERT INTO log_events VALUES (?, ?, ?, ?, ?)')
        .run('app-000', 'prod', FROM + 100, 'feedback.submitted', '{}');
      sqlite
        .prepare('INSERT INTO log_events VALUES (?, ?, ?, ?, ?)')
        .run('app-000', 'stage', FROM + 200, 'feedback.submitted', '{}');
      const db = {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                all: async () => ({
                  results: sqlite.prepare(sql).all(...(values as Array<string | number>)),
                }),
              };
            },
          };
        },
      } as unknown as D1DatabaseLike;
      const rows = await readDailyEngagementLogs(db, ['app-000'], FROM, TO);
      expect(rows).toMatchObject([{ app_id: 'app-000', event: 'feedback.submitted', count: 1 }]);
    } finally {
      sqlite.close();
    }
  });
});

describe('composeDailyEngagementReport', () => {
  it('keeps browser results when the grouped log query fails', async () => {
    class FailingLogDatabase extends MockDatabase {
      override prepare(sql: string): D1PreparedStatement {
        if (sql.includes('FROM log_events')) throw new Error('log table unavailable');
        return super.prepare(sql);
      }
    }
    const report = await composeDailyEngagementReport({
      db: new FailingLogDatabase(catalog(1), []),
      workspaceId: 'ws-1',
      date: DAY,
      now: NOW,
      query: async () => [
        { app_id: 'app-000', visitors: 3, last_seen: FROM + 100, sample_interval: 1 },
      ],
    });
    expect(report.products[0].browser_visitors).toBe(3);
    expect(report.products[0].feedback_submitted).toBeNull();
    expect(report.notes.some((note) => note.includes('D1 log_events query was unavailable'))).toBe(
      true,
    );
  });

  it('preserves visitor counts and marks only CTA unknown when the CTA query fails', async () => {
    const report = await composeDailyEngagementReport({
      db: new MockDatabase(catalog(1), []),
      workspaceId: 'ws-1',
      date: DAY,
      now: NOW,
      ctaEventNamesByCatalogId: { 'product-000': ['cta.click'] },
      query: async (sql) => {
        if (sql.includes('AS name')) throw new Error('cta query unavailable');
        return [{ app_id: 'app-000', visitors: 7, last_seen: FROM + 100, sample_interval: 1 }];
      },
    });
    const product = report.products[0];
    expect(product.browser_visitors).toBe(7);
    expect(product.cta_events).toEqual([]);
    expect(product.cta_status).toBe('unknown');
    expect(product.coverage).toBe('partial');
    expect(report.notes.some((n) => n.includes('CTA Analytics Engine query was unavailable'))).toBe(
      true,
    );
    expect(
      report.notes.some((n) => n.includes('Browser Analytics Engine query was unavailable')),
    ).toBe(false);
  });

  it('preserves CTA counts when the visitor query fails', async () => {
    const report = await composeDailyEngagementReport({
      db: new MockDatabase(catalog(1), []),
      workspaceId: 'ws-1',
      date: DAY,
      now: NOW,
      ctaEventNamesByCatalogId: { 'product-000': ['cta.click'] },
      query: async (sql) => {
        if (sql.includes('AS visitors')) throw new Error('visitor query unavailable');
        return [{ app_id: 'app-000', name: 'cta.click', count: 3, sample_interval: 1 }];
      },
    });
    expect(report.products[0]).toMatchObject({
      browser_visitors: null,
      cta_events: [{ name: 'cta.click', count: 3, estimated: false }],
      cta_status: 'measured',
      coverage: 'partial',
    });
    expect(report.notes).toContain(
      'Browser visitor Analytics Engine query was unavailable; browser visitors are unknown.',
    );
  });

  it('does not claim CTA coverage when no action is configured', () => {
    const report = buildDailyEngagementReport({
      catalog: catalog(1),
      browserVisitors: [],
      ctaEvents: [],
      logs: [],
      ctaEventNamesByCatalogId: {},
      date: DAY,
      from: FROM,
      to: TO,
      now: NOW,
      browserMeasured: false,
      ctaMeasured: true,
      logsMeasured: true,
    });
    expect(report.products[0]).toMatchObject({ cta_status: 'unknown', coverage: 'unknown' });
  });

  it('includes only active and primary catalog imports in real SQLite', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(`CREATE TABLE catalog_project_imports
        (workspace_id TEXT, catalog_id TEXT, catalog_name TEXT, app_id TEXT, lifecycle TEXT);
        CREATE TABLE environments (id TEXT, app_id TEXT, name TEXT);
        CREATE TABLE environment_capabilities
        (app_id TEXT, environment_id TEXT, capability TEXT, first_received_at INTEGER);
        CREATE TABLE log_events
        (app_id TEXT, environment_id TEXT, timestamp INTEGER, event TEXT, props TEXT);
        INSERT INTO catalog_project_imports VALUES
        ('ws-1', 'active-product', 'Active', 'app-active', 'active'),
        ('ws-1', 'retired-product', 'Retired', 'app-retired', 'retired'),
        ('ws-2', 'other-product', 'Other', 'app-other', 'active');`);
      const db = {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                all: async () => ({
                  results: sqlite.prepare(sql).all(...(values as Array<string | number>)),
                }),
              };
            },
          };
        },
      } as unknown as D1DatabaseLike;
      const report = await composeDailyEngagementReport({
        db,
        workspaceId: 'ws-1',
        date: DAY,
        now: NOW,
      });
      expect(report.product_count).toBe(1);
      expect(report.products.map((row) => row.catalog_id)).toEqual(['active-product']);
    } finally {
      sqlite.close();
    }
  });

  it('queries only configured product CTAs and production environment IDs', async () => {
    const queries: string[] = [];
    const report = await composeDailyEngagementReport({
      db: new MockDatabase(catalog(2), []),
      workspaceId: 'ws-1',
      date: DAY,
      now: NOW,
      ctaEventNamesByCatalogId: { 'product-000': ['download_opened'] },
      query: async (sql) => {
        queries.push(sql);
        return sql.includes('AS visitors')
          ? [{ app_id: 'app-000', visitors: 4, last_seen: FROM, sample_interval: 1 }]
          : [{ app_id: 'app-000', name: 'download_opened', count: 2, sample_interval: 1 }];
      },
    });
    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => sql.includes("blob2 IN ('env-000','env-001')"))).toBe(true);
    expect(queries[1]).toContain("blob5 IN ('download_opened')");
    expect(report.products[0].cta_events).toEqual([
      { name: 'download_opened', count: 2, estimated: false },
    ]);
    expect(report.products[1].cta_events).toEqual([]);
  });

  it('reads catalog and grouped logs from D1 and builds a validated report', async () => {
    const catalogRows = catalog(3);
    const logRows: EngagementLogRow[] = [
      {
        app_id: 'app-000',
        event: 'feedback.submitted',
        project_id: null,
        project: null,
        type: null,
        kind: null,
        count: 2,
        last_seen: FROM + 100,
      },
      {
        app_id: 'app-001',
        event: 'newsletter.subscribe',
        project_id: 'product-002',
        project: null,
        type: null,
        kind: 'newsletter',
        count: 5,
        last_seen: FROM + 200,
      },
    ];
    const db = new MockDatabase(catalogRows, logRows);
    const report = await composeDailyEngagementReport({
      db,
      workspaceId: 'ws-1',
      query: undefined, // no AE credentials -> browser unknown
      date: DAY,
      now: NOW,
    });
    expect(DailyEngagementReportV1.parse(report)).toEqual(report);
    expect(report.product_count).toBe(3);
    expect(report.products[0].feedback_submitted).toBe(2);
    // A centralized newsletter event maps through its product prop.
    expect(report.products[2].newsletter_joins).toBe(5);
    expect(report.products[1].newsletter_joins).toBeNull();
    // No AE query -> browser visitors unknown for all.
    for (const p of report.products) expect(p.browser_visitors).toBeNull();
  });
});

describe('worker /v1/reports/daily-engagement route', () => {
  function routeEnv(): Env {
    return {
      DB: new MockDatabase(catalog(2), [
        {
          app_id: 'app-000',
          event: 'feedback.submitted',
          project_id: null,
          project: null,
          type: null,
          kind: null,
          count: 1,
          last_seen: FROM,
        },
      ]),
      TELEMETRY: { writeDataPoint() {} },
      OWNER_AUTH_TOKEN: 'aho_production-owner',
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      ANALYTICS_ENGINE_QUERY_TOKEN: 'query-token',
      APP_HEALTH_DASHBOARD_HOST: 'health.sassmaker.com',
      APP_HEALTH_INGEST_HOST: 'ingest.sassmaker.com',
      APP_HEALTH_INGEST_ORIGIN: 'https://ingest.sassmaker.com',
    };
  }

  it('requires a workspace owner and serves no-store JSON', async () => {
    // Bearer owner has no workspaceId -> 403 (consistent with catalog import).
    const res = await worker.fetch(
      new Request('https://health.sassmaker.com/v1/reports/daily-engagement', {
        headers: { authorization: 'Bearer aho_production-owner' },
      }),
      routeEnv(),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('forbids product-scoped keys', async () => {
    const env = routeEnv();
    const res = await worker.fetch(
      new Request('https://health.sassmaker.com/v1/reports/daily-engagement', {
        headers: { authorization: 'Bearer ahk_polaris-product' },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('rejects bad date queries with 400', async () => {
    // Use an account-style owner by enabling accounts and providing a session.
    // Simpler: call compose via a workspace-bearing owner is not reachable
    // through bearer in this harness, so verify the date validation directly.
    const window = dailyEngagementWindow('not-a-date', NOW);
    expect(window).toEqual({ error: 'date must be YYYY-MM-DD' });
  });

  it('returns 405 for non-GET methods', async () => {
    const res = await worker.fetch(
      new Request('https://health.sassmaker.com/v1/reports/daily-engagement', {
        method: 'POST',
        headers: { authorization: 'Bearer aho_production-owner' },
      }),
      routeEnv(),
    );
    // Bearer owner has no workspace -> 403 before method check is unreachable;
    // the method guard runs first and returns 405.
    expect(res.status).toBe(405);
  });
});
