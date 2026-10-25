import { expect, it } from 'vitest';
import {
  AnalysisDefinition,
  AnalysisQuery,
  AnalysisRecord,
  AnalysisRecords,
  AnalysisReport,
  AnalysisSegment,
  AnalysisStep,
} from '../src/index.js';

it('accepts strict page, prefix and property-conditioned event definitions', () => {
  for (const target of ['/', '/pricing', '/docs/*'])
    expect(AnalysisStep.safeParse({ type: 'page', target }).success).toBe(true);
  expect(
    AnalysisDefinition.parse({
      kind: 'goal',
      name: ' Pro signup ',
      step: { type: 'event', target: 'signup.completed', property: 'plan', equals: 'pro' },
    }).name,
  ).toBe('Pro signup');
  expect(
    AnalysisDefinition.parse({
      kind: 'funnel',
      name: 'Checkout',
      steps: [
        { type: 'page', target: '/pricing' },
        { type: 'event', target: 'checkout.completed' },
      ],
    }),
  ).toMatchObject({ window_ms: 86400000 });
  expect(
    AnalysisDefinition.parse({
      kind: 'segment',
      name: 'Mobile',
      filters: { device: 'Mobile', country: 'IN', source: 'ChatGPT' },
    }).kind,
  ).toBe('segment');
});
it('rejects unsafe paths, malformed event conditions and unknown fields', () => {
  for (const target of [
    'pricing',
    '/pricing?secret=x',
    '/a/*/b',
    '/a*',
    '/alice@example.com',
    '/has space',
    '/a\\b',
  ])
    expect(AnalysisStep.safeParse({ type: 'page', target }).success).toBe(false);
  for (const step of [
    { type: 'event', target: 'has space' },
    { type: 'event', target: 'signup', property: 'plan' },
    { type: 'event', target: 'signup', equals: true },
    { type: 'event', target: 'signup', property: 'plan', equals: {} },
    { type: 'page', target: '/', property: 'plan', equals: 'pro' },
    { type: 'event', target: 'signup', property: 'bad.key', equals: 'pro' },
  ])
    expect(AnalysisStep.safeParse(step).success).toBe(false);
  expect(AnalysisSegment.safeParse({ arbitrary: 'value' }).success).toBe(false);
  expect(
    AnalysisDefinition.safeParse({
      kind: 'funnel',
      name: 'One',
      steps: [{ type: 'page', target: '/' }],
    }).success,
  ).toBe(false);
  expect(
    AnalysisDefinition.safeParse({ kind: 'goal', name: '', step: { type: 'page', target: '/' } })
      .success,
  ).toBe(false);
});
it('bounds query scope and validates persisted records and report provenance', () => {
  const query = AnalysisQuery.parse({
    app_id: 'app_example',
    environment_id: 'env-production',
    filters: { campaign: 'launch' },
  });
  expect(query.range).toBe('24h');
  expect(AnalysisQuery.safeParse({ ...query, range: 'all' }).success).toBe(false);
  const record = AnalysisRecord.parse({
    id: '11111111-1111-4111-8111-111111111111',
    definition: { kind: 'segment', name: 'All', filters: {} },
    created_at: 1,
    updated_at: 2,
  });
  expect(AnalysisRecords.parse({ records: [record] }).records).toHaveLength(1);
  expect(
    AnalysisReport.safeParse({
      from: 1,
      to: 2,
      source: 'archive',
      complete: false,
      coverage_note: 'Observed events only',
      events: 0,
      sessions: 0,
      visitors: 0,
      unidentified_sessions: 0,
      values: [],
      properties: [],
      goals: [],
      funnels: [],
    }).success,
  ).toBe(true);
});
