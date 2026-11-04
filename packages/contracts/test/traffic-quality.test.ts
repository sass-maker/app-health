import { expect, it } from 'vitest';
import { TrafficQuality } from '../src/traffic-quality.js';

const base = {
  app_id: 'app',
  environment_id: 'env',
  from: 1,
  to: 2,
  generated_at: 3,
  time_basis: 'receipt_time',
  qa_internal: 'not_separately_identified',
};
const bots = {
  status: 'observed',
  pageview_attempts: 3,
  cloudflare_verified: 1,
  recognized_user_agent: 2,
  estimated: false,
  coverage: 'partial',
};
it('allows positive partial observations and unknown, without permitting a counted zero or complete coverage claim', () => {
  expect(TrafficQuality.safeParse({ ...base, bots }).success).toBe(true);
  expect(
    TrafficQuality.safeParse({ ...base, bots: { status: 'unknown', reason: 'no_records' } })
      .success,
  ).toBe(true);
  for (const patch of [
    { pageview_attempts: 0 },
    { pageview_attempts: 4 },
    { coverage: 'complete' },
    { cloudflare_verified: -1 },
  ])
    expect(TrafficQuality.safeParse({ ...base, bots: { ...bots, ...patch } }).success).toBe(false);
  expect(TrafficQuality.safeParse({ ...base, from: 2, bots }).success).toBe(false);
});
