import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserReportFilter } from '@app-health/contracts';
import { localBrowserReport, queryBrowserReport } from '../src/browser-reports.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
const now = 1800000000000;
const event = (type: 'event' | 'pageview', timestamp: number, path = '/', name?: string) => ({
  event_id: crypto.randomUUID(),
  timestamp,
  type,
  path,
  name,
  referrer: 'google.com',
});
const batch: CollectedBrowserBatch = {
  workspace: 'w-one',
  app_id: 'a-one',
  environment_id: 'e-one',
  batch_id: crypto.randomUUID(),
  received_at: now,
  events: [
    event('pageview', now - 5000),
    event('pageview', now - 7200000, '/pricing'),
    event('event', now - 5000, '/pricing', 'signup.completed'),
    event('event', now - 4000, '/pricing', 'signup.completed'),
    event('event', now - 4000, '/checkout', 'checkout.started'),
    event('pageview', now - 90000000),
  ],
  session_hash: 'f'.repeat(64),
};
afterEach(() => vi.useRealTimers());
describe('browser reports', () => {
  it('aggregates actual trends, pages, referral sources and named events within the selected period', () => {
    const report = localBrowserReport([batch], { range: '24h' }, now);
    expect(report.series).toHaveLength(24);
    expect(report.series.reduce((n, r) => n + r.pageviews, 0)).toBe(2);
    expect(report.series.reduce((n, r) => n + r.events, 0)).toBe(3);
    expect(report.pages).toEqual([
      { name: '/', count: 1 },
      { name: '/pricing', count: 1 },
    ]);
    expect(report.sources).toEqual([{ name: 'google.com', count: 2 }]);
    expect(report.events[0]).toEqual({ name: 'signup.completed', count: 2, last_seen: now - 4000 });
    expect(report.sessions).toBe(1);
    expect(
      localBrowserReport([batch], { range: '1h' }, now).series.reduce((n, r) => n + r.pageviews, 0),
    ).toBe(1);
  });
  it('filters by project/environment and event, using event pages and referrers for drill-down', () => {
    expect(localBrowserReport([batch], { range: '24h', app_id: 'other' }, now).events).toEqual([]);
    expect(
      localBrowserReport([batch], { range: '24h', environment_id: 'other' }, now).events,
    ).toEqual([]);
    const report = localBrowserReport(
      [batch],
      { range: '24h', app_id: 'a-one', environment_id: 'e-one', event: 'signup.completed' },
      now,
    );
    expect(report.pages).toEqual([{ name: '/pricing', count: 2 }]);
    expect(report.sources).toEqual([{ name: 'google.com', count: 2 }]);
    expect(report.series.reduce((n, r) => n + r.pageviews, 0)).toBe(0);
    expect(report.events).toHaveLength(1);
    const direct = { ...batch, events: [{ ...batch.events[0], referrer: '' }] };
    expect(localBrowserReport([direct], { range: '24h' }, now).sources[0].name).toBe(
      'Direct / unknown',
    );
  });
  it('queries four bounded aggregates with workspace and validated filters in every query', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ bucket: '23', pageviews: '10', events: '4', sample_interval: 2 }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ name: '/pricing', count: 4, sample_interval: 2 }] }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ name: '', count: 4, sample_interval: 2 }] }))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ name: 'signup.completed', count: 4, last_seen: now - 4000, sample_interval: 2 }],
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ sessions: 1, sample_interval: 2 }] }));
    const options = { accountId: 'a'.repeat(32), token: 'test', fetchImpl };
    const report = await queryBrowserReport(
      'w-one',
      { range: '24h', app_id: 'a-one', environment_id: 'e-one', event: 'signup.completed' },
      options,
    );
    expect(report.sampled).toBe(true);
    expect(report.series[23].events).toBe(4);
    expect(report.sources[0].name).toBe('Direct / unknown');
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.body).toContain("index1 = 'w-one'");
      expect(init?.body).toContain("blob1 = 'a-one'");
      expect(init?.body).toContain("blob5 = 'signup.completed'");
    }
    expect(report.sessions).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    await expect(
      queryBrowserReport('w-one', { range: '24h', event: "x' OR 1=1" }, options),
    ).rejects.toThrow();
    expect(BrowserReportFilter.safeParse({ range: '7d' }).success).toBe(false);
  });
  it('fails closed on malformed provider output and upstream outages', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const options = { accountId: 'a'.repeat(32), token: 'test', fetchImpl };
    await expect(queryBrowserReport('w-one', { range: '1h' }, options)).rejects.toThrow(
      'unavailable',
    );
    await expect(queryBrowserReport("w'", { range: '24h' }, options)).rejects.toThrow('scope');
    fetchImpl.mockImplementation(async () =>
      Response.json({
        data: [{ name: 'x', count: -1, sample_interval: 1, bucket: 0, pageviews: 0, events: 0 }],
      }),
    );
    await expect(queryBrowserReport('w-one', { range: '1h' }, options)).rejects.toThrow('response');
  });
  it('rejects null or blank counts and duplicated trend buckets instead of showing zeros', async () => {
    for (const pageviews of [null, '', ' ', true]) {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json({
          data: [{ bucket: 0, pageviews, events: 0, sample_interval: 1 }],
        }),
      );
      await expect(
        queryBrowserReport(
          'w-one',
          { range: '1h' },
          {
            accountId: 'a'.repeat(32),
            token: 'test',
            fetchImpl,
          },
        ),
      ).rejects.toThrow('response');
    }
    const row = { bucket: 0, pageviews: 1, events: 0, sample_interval: 1 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ data: [row, row] }));
    await expect(
      queryBrowserReport(
        'w-one',
        { range: '1h' },
        {
          accountId: 'a'.repeat(32),
          token: 'test',
          fetchImpl,
        },
      ),
    ).rejects.toThrow('bucket');
  });
});
