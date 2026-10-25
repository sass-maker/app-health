import { expect, it } from 'vitest';
import {
  AnalysisDefinition,
  AnalysisReport,
  type AnalysisQuery,
  type AnalysisRecord,
  type BrowserEventV1,
} from '@app-health/contracts';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import { evaluateConversions } from '../src/conversion-evaluator.js';

const query: AnalysisQuery = { app_id: 'app', environment_id: 'env', range: '24h' };
let sequence = 0;
function event(
  type: 'pageview' | 'event',
  target: string,
  timestamp: number,
  extra: Partial<BrowserEventV1> = {},
): BrowserEventV1 {
  return {
    event_id: `event-${++sequence}`,
    timestamp,
    type,
    path: type === 'pageview' ? target : '/account',
    referrer: '',
    ...(type === 'event' ? { name: target } : {}),
    ...extra,
  };
}
function batch(
  events: BrowserEventV1[],
  extra: Partial<CollectedBrowserBatch> = {},
): CollectedBrowserBatch {
  return {
    workspace: 'ws',
    app_id: 'app',
    environment_id: 'env',
    batch_id: `batch-${++sequence}`,
    received_at: 10000,
    session_hash: 's1',
    visitor_hash: 'v1',
    events,
    ...extra,
  };
}
function definition(value: unknown): AnalysisRecord {
  return {
    id: `definition-${++sequence}`,
    definition: AnalysisDefinition.parse(value),
    created_at: 0,
    updated_at: 0,
  };
}
function report(
  batches: CollectedBrowserBatch[],
  definitions: AnalysisRecord[] = [],
  filters: AnalysisQuery['filters'] = {},
) {
  return AnalysisReport.parse(
    evaluateConversions({
      batches,
      definitions,
      query: { ...query, filters },
      from: 1000,
      to: 10000,
      source: 'archive',
      complete: false,
      coverage_note: 'Observed archive only',
    }),
  );
}
const funnel = (steps: unknown[], extra = {}) =>
  definition({ kind: 'funnel', name: 'Checkout', steps, ...extra });
const page = (target: string) => ({ type: 'page', target });
const action = (target: string) => ({ type: 'event', target });

it('deduplicates event UUIDs, rejects conflicting facts and excludes other environments and time bounds', () => {
  const first = event('pageview', '/pricing', 1000);
  const source = batch([first, event('event', 'signup', 9999)]);
  const result = report([
    source,
    batch([first]),
    batch([event('event', 'signup', 2000)], { environment_id: 'other' }),
    batch([event('pageview', '/', 999), event('pageview', '/', 10000)]),
  ]);
  expect(result).toMatchObject({ events: 1, sessions: 1, visitors: 1, complete: false });
  expect(() => report([source, batch([{ ...first, path: '/changed' }])])).toThrow('Conflicting');
});
it('computes unique visitor goals with strict property predicates, values and missing identity separately', () => {
  const goal = definition({
    kind: 'goal',
    name: 'Pro signup',
    step: { ...action('signup'), property: 'plan', equals: 'pro' },
  });
  const result = report(
    [
      batch([
        event('pageview', '/', 1100),
        event('event', 'signup', 2000, { properties: { plan: 'pro' }, value: 12 }),
        event('event', 'signup', 3000, { properties: { plan: 'pro' }, value: 8 }),
      ]),
      batch([event('event', 'signup', 2100, { properties: { plan: 'free' } })], {
        session_hash: 's2',
        visitor_hash: 'v2',
      }),
      batch([event('event', 'signup', 2100, { properties: { plan: 'pro' } })], {
        session_hash: 's3',
        visitor_hash: undefined,
      }),
    ],
    [goal],
  );
  expect(result.goals[0]).toMatchObject({
    occurrences: 3,
    visitors: 1,
    sessions: 2,
    conversion_rate: 0.5,
    value: 20,
  });
  expect(result).toMatchObject({ visitors: 2, unidentified_sessions: 1 });
});
it('supports exact and prefix page goals, event name checks, empty denominators and hashless facts', () => {
  const definitions = [
    definition({ kind: 'goal', name: 'Docs', step: page('/docs/*') }),
    definition({ kind: 'goal', name: 'Root', step: page('/') }),
  ];
  const result = report(
    [
      batch(
        [
          event('pageview', '/docs', 2000),
          event('pageview', '/docs/start', 3000),
          event('pageview', '/docstring', 4000),
          event('event', 'signup', 5000),
        ],
        { session_hash: undefined, visitor_hash: undefined },
      ),
    ],
    definitions,
  );
  expect(result.goals[0]).toMatchObject({
    occurrences: 2,
    sessions: 0,
    visitors: 0,
    conversion_rate: null,
  });
  expect(result.goals[1].occurrences).toBe(0);
  expect(report([], definitions).goals[0].conversion_rate).toBeNull();
});
it('sorts shuffled events, permits unrelated steps and counts each session once in ordered funnels', () => {
  const definition = funnel([page('/pricing'), action('signup'), action('paid')]);
  const result = report(
    [
      batch([
        event('event', 'paid', 6000),
        event('pageview', '/pricing', 2000),
        event('event', 'unrelated', 3000),
        event('event', 'signup', 4000),
        event('event', 'signup', 4500),
      ]),
      batch([event('pageview', '/pricing', 2200), event('event', 'signup', 4200)], {
        session_hash: 's2',
      }),
      batch([event('event', 'paid', 6200)], { session_hash: 's3' }),
    ],
    [definition],
  );
  expect(result.funnels[0].steps.map((row) => [row.sessions, row.dropoff])).toEqual([
    [2, 0],
    [2, 0],
    [1, 1],
  ]);
  expect(result.funnels[0]).toMatchObject({ conversion_rate: 0.5, median_conversion_ms: 4000 });
});
it('does not cross sessions, infer order at equal timestamps or count events outside the conversion window', () => {
  const definition = funnel([action('start'), action('finish')], { window_ms: 1000 });
  const result = report(
    [
      batch([
        event('event', 'start', 2000),
        event('event', 'finish', 2000),
        event('event', 'finish', 4000),
      ]),
      batch([event('event', 'start', 3000)], { session_hash: 's2' }),
      batch([event('event', 'finish', 3200)], { session_hash: 's3' }),
    ],
    [definition],
  );
  expect(result.funnels[0].steps.map((row) => row.sessions)).toEqual([2, 0]);
  expect(result.funnels[0].median_conversion_ms).toBeNull();
});
it('allows a later attempt to convert when the first attempt expired, including the exact window boundary', () => {
  const definition = funnel([action('start'), action('middle'), action('finish')], {
    window_ms: 1000,
  });
  const result = report(
    [
      batch([
        event('event', 'start', 2000),
        event('event', 'middle', 2500),
        event('event', 'start', 5000),
        event('event', 'middle', 5500),
        event('event', 'finish', 6000),
      ]),
    ],
    [definition],
  );
  expect(result.funnels[0]).toMatchObject({ conversion_rate: 1, median_conversion_ms: 1000 });
});
it('qualifies a funnel segment at its first step and retains later pages in that session', () => {
  const definition = funnel([page('/pricing'), action('paid')], { segment: { device: 'Mobile' } });
  const result = report(
    [
      batch([event('pageview', '/pricing', 2000), event('event', 'paid', 3000)], {
        metadata: { device: 'Mobile', browser: 'Chrome', channel: 'Referral', country: 'IN' },
        attribution: {
          source: 'x.com',
          medium: '',
          campaign: '',
          content: '',
          term: '',
          entry_path: '/pricing',
        },
      }),
      batch([event('pageview', '/pricing', 2000), event('event', 'paid', 3000)], {
        session_hash: 'desktop',
      }),
    ],
    [definition],
    { path: '/pricing', source: 'X' },
  );
  expect(result.funnels[0].steps.map((row) => row.sessions)).toEqual([1, 1]);
});
it('reports typed property breakdowns and event values without merging scalar types', () => {
  const input = {
    batches: [
      batch([
        event('event', 'purchase', 2000, {
          properties: { plan: 'pro', seats: 1, trial: false },
          value: 10,
        }),
        event('event', 'purchase', 3000, {
          properties: { plan: 'pro', seats: '1', trial: false },
          value: -2,
        }),
        event('event', 'other', 4000, { value: 100 }),
      ]),
    ],
    definitions: [],
    query: { ...query, event: 'purchase' },
    from: 1000,
    to: 10000,
    source: 'local' as const,
    complete: true,
    coverage_note: 'Local',
  };
  const result = evaluateConversions(input);
  expect(result.values).toEqual([{ name: 'purchase', occurrences: 2, value: 8 }]);
  expect(result.properties.find((row) => row.key === 'seats')?.values).toEqual([
    { value: 1, count: 1 },
    { value: '1', count: 1 },
  ]);
  expect(report(input.batches).properties).toEqual([]);
});
