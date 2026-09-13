import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localBrowserReport, queryBrowserReport } from '../src/browser-reports.js';
import { browserReportPlan } from '../src/browser-report-plan.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

const now = 1_800_000_000_000;
const day = 86_400_000;

type Overrides = Partial<CollectedBrowserBatch> & {
  path?: string;
  referrer?: string;
};

function fixture(overrides: Overrides = {}): CollectedBrowserBatch {
  const path = overrides.path ?? '/target';
  const referrer = overrides.referrer ?? '';
  const batch: CollectedBrowserBatch = {
    workspace: 'workspace',
    app_id: 'app',
    environment_id: 'env',
    batch_id: crypto.randomUUID(),
    received_at: now,
    session_hash: crypto.randomUUID(),
    visitor_hash: crypto.randomUUID(),
    visit_type: 'new',
    attribution: {
      source: 'reddit.com',
      medium: 'social',
      campaign: 'spring',
      content: '',
      term: '',
      entry_path: '/landing',
    },
    metadata: { channel: 'Social', device: 'Mobile', browser: 'Chrome', country: 'IN' },
    events: [
      {
        event_id: crypto.randomUUID(),
        timestamp: now - 1_000,
        type: 'pageview',
        path,
        referrer,
      },
    ],
  };
  return { ...batch, ...overrides };
}

function sqliteFixture(rows: CollectedBrowserBatch[]) {
  const database = new DatabaseSync(':memory:');
  database.exec(
    `CREATE TABLE app_health_browser_v1 (index1 TEXT, ${Array.from({ length: 20 }, (_, i) => `blob${i + 1} TEXT DEFAULT ''`).join(',')}, double1 REAL, double2 REAL, _sample_interval INTEGER)`,
  );
  const insert = database.prepare(
    'INSERT INTO app_health_browser_v1 (index1,blob1,blob2,blob3,blob4,blob5,blob6,blob7,blob8,blob9,blob10,blob11,blob12,blob13,blob14,blob15,blob16,blob17,blob18,blob19,double1,double2,_sample_interval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const batch of rows) {
    const event = batch.events[0];
    const attribution = batch.attribution;
    const metadata = batch.metadata;
    insert.run(
      batch.workspace,
      batch.app_id,
      batch.environment_id,
      event.type,
      event.path,
      event.name ?? '',
      event.referrer,
      batch.session_hash ?? '',
      batch.visitor_hash ?? '',
      batch.visit_type ?? '',
      attribution?.source ?? '',
      attribution?.medium ?? '',
      attribution?.campaign ?? '',
      metadata?.channel ?? '',
      metadata?.device ?? '',
      metadata?.browser ?? '',
      metadata?.country ?? '',
      attribution?.entry_path ?? '',
      attribution?.content ?? '',
      attribution?.term ?? '',
      1,
      event.timestamp,
      1,
    );
  }
  return database;
}

async function remoteReport(
  rows: CollectedBrowserBatch[],
  filter: Parameters<typeof localBrowserReport>[1],
) {
  const database = sqliteFixture(rows);
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
    Response.json({ data: database.prepare(String(init?.body)).all() }),
  );
  try {
    return await queryBrowserReport('workspace', filter, {
      accountId: 'a'.repeat(32),
      token: 'fixture',
      fetchImpl,
    });
  } finally {
    database.close();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('browser segment filters', () => {
  it('applies all eight filters together without cross-field false matches or scope leakage', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const target = fixture();
    const rows = [
      target,
      ...['country', 'device', 'browser', 'channel'].map((key) =>
        fixture({
          metadata: {
            ...target.metadata!,
            [key]: { country: 'US', device: 'Desktop', browser: 'Safari', channel: 'Email' }[key],
          },
        }),
      ),
      fixture({ attribution: { ...target.attribution!, source: 'x.com' } }),
      fixture({ attribution: { ...target.attribution!, campaign: 'autumn' } }),
      fixture({ attribution: { ...target.attribution!, entry_path: '/other' } }),
      fixture({ path: '/other' }),
      fixture({
        attribution: { ...target.attribution!, campaign: 'autumn' },
        events: [{ ...target.events[0], timestamp: now - 8 * day }],
      }),
      fixture({ workspace: 'other-workspace' }),
      fixture({ app_id: 'other-app' }),
      fixture({ environment_id: 'other-env' }),
      fixture({ events: [{ ...target.events[0], timestamp: now - 8 * day }] }),
    ];
    const filter = {
      range: '7d' as const,
      app_id: 'app',
      environment_id: 'env',
      country: 'IN' as const,
      source: 'reddit.com',
      path: '/target',
      entry_path: '/landing',
      device: 'Mobile' as const,
      browser: 'Chrome' as const,
      channel: 'Social' as const,
      campaign: 'spring',
    };
    const local = localBrowserReport(
      rows.filter((row) => row.workspace === 'workspace'),
      filter,
      now,
    );
    const remote = await remoteReport(rows, filter);
    expect(remote.pages).toEqual(local.pages);
    expect(remote.sources).toEqual(local.sources);
    expect(remote.audience).toMatchObject(local.audience!);
    expect(remote.previous).toEqual(local.previous);
    expect(remote.pages).toEqual([{ name: '/target', count: 1 }]);
  });

  it('keeps missing source separate from a campaign literally named unknown', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const rows = [
      fixture({
        attribution: { ...fixture().attribution!, source: '' },
        metadata: { ...fixture().metadata!, channel: 'Unknown' },
      }),
      fixture({
        attribution: { ...fixture().attribution!, source: 'unknown' },
        metadata: { ...fixture().metadata!, channel: 'Unknown' },
        path: '/literal',
      }),
      fixture({ attribution: { ...fixture().attribution!, source: 'x.com' }, path: '/social' }),
    ];
    const filter = { range: '7d' as const, source: 'Unknown' };
    const local = localBrowserReport(rows, filter, now);
    const remote = await remoteReport(rows, filter);
    expect(remote.pages).toEqual(local.pages);
    expect(remote.sources).toEqual(local.sources);
    expect(remote.pages).toEqual([{ name: '/target', count: 1 }]);
    const literal = await remoteReport(rows, { range: '7d', source: 'unknown' });
    expect(literal.pages).toEqual([{ name: '/literal', count: 1 }]);
  });

  it('escapes route filters and does not turn injection-shaped paths into broad matches', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const rows = [fixture({ path: "/a'b" }), fixture({ path: '/safe' })];
    const filter = { range: '7d' as const, path: "/a'b" };
    const local = localBrowserReport(rows, filter, now);
    const remote = await remoteReport(rows, filter);
    expect(remote.pages).toEqual(local.pages);
    expect(remote.pages).toEqual([{ name: "/a'b", count: 1 }]);
    const injection = await remoteReport(rows, { range: '7d', path: "/x'OR'1'='1" });
    expect(injection.pages).toEqual([]);
  });

  it('keeps acquisition medium, content, and term dimensions nonempty and filterable', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const target = fixture({
      attribution: { ...fixture().attribution!, medium: 'email', content: 'hero', term: 'alpha' },
    });
    const rows = [
      target,
      fixture({ attribution: { ...target.attribution!, medium: 'cpc' }, path: '/medium-conflict' }),
      fixture({
        attribution: { ...target.attribution!, content: 'footer' },
        path: '/content-conflict',
      }),
      fixture({ attribution: { ...target.attribution!, term: 'beta' }, path: '/term-conflict' }),
      fixture({
        attribution: { ...target.attribution!, medium: '', content: '', term: '' },
        path: '/empty',
      }),
    ];
    const filter = { range: '7d' as const, breakdown: 'acquisition' as const };
    const local = localBrowserReport(rows, filter, now);
    const remote = await remoteReport(rows, filter);
    expect(local.audience?.mediums).toEqual([
      { name: 'email', count: 3 },
      { name: 'cpc', count: 1 },
    ]);
    expect(local.audience?.contents).toEqual([
      { name: 'hero', count: 3 },
      { name: 'footer', count: 1 },
    ]);
    expect(local.audience?.terms).toEqual([
      { name: 'alpha', count: 3 },
      { name: 'beta', count: 1 },
    ]);
    expect(remote.audience).toMatchObject(local.audience!);
    expect(
      browserReportPlan('workspace', { ...filter, medium: 'email' }, now - 7 * day, now, day / 3)
        .sql,
    ).toHaveLength(11);
    expect((await remoteReport(rows, { ...filter, medium: 'email' })).pages).toHaveLength(3);
    expect((await remoteReport(rows, { ...filter, content: 'hero' })).pages).toHaveLength(3);
    expect((await remoteReport(rows, { ...filter, term: 'alpha' })).pages).toHaveLength(3);
  });
});
