import { describe, expect, it, vi } from 'vitest';
import { queryPublicBrowserTraffic } from '../src/public-browser-report.js';

const options = { accountId: 'a'.repeat(32), token: 'query-token' };
const row = { bucket: 0, pageviews: '6', sample_interval: '2' };

function provider(data: unknown, ok = true) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValue(ok ? Response.json({ data }) : new Response(null, { status: 503 }));
}

describe('public browser traffic query', () => {
  it('returns 24 weighted hourly buckets and an aggregate-only scoped query', async () => {
    const fetchImpl = provider([row, { bucket: 23, pageviews: 4, sample_interval: 1 }]);
    const result = await queryPublicBrowserTraffic('workspace-one', 'app-one', 'env-one', {
      ...options,
      fetchImpl,
    });
    expect(result.sampled).toBe(true);
    expect(result.traffic.series).toHaveLength(24);
    expect(result.traffic.series[0].pageviews).toBe(6);
    expect(result.traffic.series[23].pageviews).toBe(4);
    expect(result.traffic.pageviews).toBe(10);
    const sql = String(fetchImpl.mock.calls[0][1]?.body);
    expect(sql).toContain('SUM(_sample_interval)');
    expect(sql).toContain('MAX(_sample_interval)');
    expect(sql).toContain("index1 = 'workspace-one'");
    expect(sql).toContain("blob1 = 'app-one'");
    expect(sql).toContain("blob2 = 'env-one'");
    expect(sql).toContain("blob3 = 'pageview'");
    expect(sql).not.toContain('session');
    expect(sql).not.toContain('route');
  });

  it.each([
    ['out-of-range bucket', [{ bucket: 24, pageviews: 1, sample_interval: 1 }]],
    ['duplicate bucket', [row, row]],
    ['nonfinite count', [{ bucket: 1, pageviews: 'NaN', sample_interval: 1 }]],
    ['missing count', [{ bucket: 1, sample_interval: 1 }]],
    ['missing provider data', undefined],
  ])('rejects %s', async (_label, data) => {
    await expect(
      queryPublicBrowserTraffic('workspace-one', 'app-one', 'env-one', {
        ...options,
        fetchImpl: provider(data),
      }),
    ).rejects.toThrow();
  });

  it('rejects invalid scope and injection-shaped identifiers before provider use', async () => {
    const fetchImpl = provider([]);
    await expect(
      queryPublicBrowserTraffic("workspace-one' OR 1=1", 'app-one', 'env-one', {
        ...options,
        fetchImpl,
      }),
    ).rejects.toThrow('scope');
    await expect(
      queryPublicBrowserTraffic('workspace-one', "app-one' OR 1=1", 'env-one', {
        ...options,
        fetchImpl,
      }),
    ).rejects.toThrow();
    await expect(
      queryPublicBrowserTraffic('workspace-one', 'app-one', 'env-one', {
        ...options,
        accountId: 'bad-account',
        fetchImpl,
      }),
    ).rejects.toThrow('scope');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the provider fails', async () => {
    await expect(
      queryPublicBrowserTraffic('workspace-one', 'app-one', 'env-one', {
        ...options,
        fetchImpl: provider([], false),
      }),
    ).rejects.toThrow('unavailable');
  });
});
