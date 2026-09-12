import { describe, expect, it, vi } from 'vitest';
import {
  queryPublicBrowserBreakdowns,
  queryPublicBrowserTraffic,
} from '../src/public-browser-report.js';

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

  it('uses four aggregate queries and never requests named events', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: [{ bucket: 0, pageviews: 4, events: 3, sample_interval: 1 }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ name: '/home', count: 4, sample_interval: 1 }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ name: 'google', count: 2, sample_interval: 1 }] }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ sessions: 2, sample_interval: 1 }] }));
    const report = await queryPublicBrowserBreakdowns('workspace-one', 'app-one', 'env-one', {
      ...options,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(report.breakdowns).toMatchObject({ sessions: 2, events: 3 });
    expect(fetchImpl.mock.calls.map(([, init]) => String(init?.body)).join('\n')).not.toContain(
      'blob5 AS name',
    );
  });
});

const breakdownData = [
  [{ bucket: 0, pageviews: 4, events: 3, sample_interval: 2 }],
  [{ name: '/home', count: 4, sample_interval: 2 }],
  [{ name: '', count: 4, sample_interval: 1 }],
  [{ sessions: 2, sample_interval: 2 }],
];
function breakdownProvider(data: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const rows of data) fetchImpl.mockResolvedValueOnce(Response.json({ data: rows }));
  return fetchImpl;
}

it.each([
  ['duplicate trend bucket', 0, [breakdownData[0][0], breakdownData[0][0]]],
  ['invalid trend sampling', 0, [{ bucket: 0, pageviews: 4, events: 3, sample_interval: 0 }]],
  ['too many pages', 1, Array.from({ length: 21 }, () => breakdownData[1][0])],
  ['non-string route', 1, [{ name: { secret: true }, count: 1, sample_interval: 1 }]],
  ['overlong route', 1, [{ name: '/' + 'a'.repeat(256), count: 1, sample_interval: 1 }]],
  [
    'invalid source sampling despite sampled trend',
    2,
    [{ name: '', count: 1, sample_interval: 0 }],
  ],
  [
    'invalid later source despite earlier sampling',
    2,
    [
      { name: '', count: 1, sample_interval: 2 },
      { name: 'example.com', count: 1, sample_interval: 0 },
    ],
  ],
  [
    'too many session aggregates',
    3,
    [
      { sessions: 1, sample_interval: 1 },
      { sessions: 1, sample_interval: 1 },
    ],
  ],
  ['null sampling for nonempty sessions', 3, [{ sessions: 1, sample_interval: null }]],
  ['fractional sessions', 3, [{ sessions: 0.5, sample_interval: 1 }]],
])('rejects malformed public breakdowns: %s', async (_name, index, invalid) => {
  const data: unknown[] = [...breakdownData];
  data[index as number] = invalid;
  await expect(
    queryPublicBrowserBreakdowns('workspace-one', 'app-one', 'env-one', {
      ...options,
      fetchImpl: breakdownProvider(data),
    }),
  ).rejects.toThrow();
});

it('handles empty SQL aggregates and normalizes direct traffic', async () => {
  const empty = await queryPublicBrowserBreakdowns('workspace-one', 'app-one', 'env-one', {
    ...options,
    fetchImpl: breakdownProvider([[], [], [], [{ sessions: 0, sample_interval: null }]]),
  });
  expect(empty).toMatchObject({
    sampled: false,
    traffic: { pageviews: 0 },
    breakdowns: { sessions: 0, events: 0, pages: [], sources: [] },
  });
  const direct = await queryPublicBrowserBreakdowns('workspace-one', 'app-one', 'env-one', {
    ...options,
    fetchImpl: breakdownProvider(breakdownData),
  });
  expect(direct.breakdowns.sources).toEqual([{ name: 'Direct / unknown', count: 4 }]);
  expect(direct.sampled).toBe(true);
});
