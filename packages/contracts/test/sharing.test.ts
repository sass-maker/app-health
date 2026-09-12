import { expect, it } from 'vitest';
import { parseSharedAnalytics } from '../src/sharing.js';
const valid = {
  project: { name: 'Product', environment: 'prod' },
  live: { active: 1, measured_at: 100, ttl_ms: 45000 },
  traffic: { pageviews: 4, from: 0, to: 100, series: [{ timestamp: 0, pageviews: 4 }] },
  source: 'local',
  sampled: false,
  updated_at: 100,
};
it('validates and projects aggregate fields without leaking appended private data', () => {
  expect(
    parseSharedAnalytics({ ...valid, logs: [1], project: { ...valid.project, key: 'private' } }),
  ).toEqual(valid);
  expect(
    parseSharedAnalytics({
      ...valid,
      live: { ...valid.live, active: null },
      traffic: null,
      source: 'analytics-engine',
    }),
  ).not.toBeNull();
  for (const value of [
    null,
    [],
    {},
    { ...valid, project: null },
    { ...valid, live: {} },
    { ...valid, source: 'unknown' },
    { ...valid, sampled: 'false' },
    { ...valid, updated_at: -1 },
    { ...valid, traffic: {} },
    {
      ...valid,
      traffic: { ...valid.traffic, series: Array(25).fill({ timestamp: 0, pageviews: 1 }) },
    },
    { ...valid, traffic: { ...valid.traffic, series: [{ timestamp: 0, pageviews: '4' }] } },
    { ...valid, traffic: { ...valid.traffic, pageviews: Infinity } },
  ])
    expect(parseSharedAnalytics(value)).toBeNull();
});

it('accepts only the bounded opt-in breakdown projection', () => {
  const breakdowns = {
    sessions: 2,
    events: 3,
    pages: [{ name: '/home', count: 4 }],
    sources: [{ name: 'Direct / unknown', count: 4 }],
  };
  expect(parseSharedAnalytics({ ...valid, breakdowns })).toMatchObject({ breakdowns });
  expect(parseSharedAnalytics({ ...valid, breakdowns: { ...breakdowns, events: -1 } })).toBeNull();
  const projected = parseSharedAnalytics({
    ...valid,
    breakdowns: { ...breakdowns, pages: [{ ...breakdowns.pages[0], secret: 'x' }] },
  });
  expect(projected?.breakdowns).toEqual(breakdowns);
  expect(JSON.stringify(projected)).not.toContain('secret');
});
