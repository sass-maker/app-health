import { describe, expect, it } from 'vitest';
import { DAILY_CTA_POLICY, DAILY_CTA_REPORT_EVENT_NAMES } from '../src/daily-cta-policy.js';

describe('daily CTA policy', () => {
  it('covers the 55-product rollout scope while distinguishing verified events from candidates', () => {
    expect(Object.keys(DAILY_CTA_POLICY)).toHaveLength(55);
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'candidate_only'),
    ).toHaveLength(39);
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'verified'),
    ).toHaveLength(3);
    expect(DAILY_CTA_POLICY.posttrainllm).toMatchObject({
      clarityCandidate: 'quickstart_opened',
      qualification: 'verified',
      qualifiedAppHealthEvents: ['quickstart_opened'],
    });
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'unknown'),
    ).toHaveLength(13);
    expect(DAILY_CTA_POLICY['app-health']).toMatchObject({
      clarityCandidate: 'release_status_opened',
      qualification: 'candidate_only',
      qualifiedAppHealthEvents: [],
    });
    expect(DAILY_CTA_POLICY['site-health']).toMatchObject({
      clarityCandidate: null,
      qualification: 'unknown',
      qualifiedAppHealthEvents: [],
    });
  });

  it('reports only App Health events with production ingest receipts', () => {
    expect(DAILY_CTA_REPORT_EVENT_NAMES).toEqual({
      codevetter: ['benchmark_opened'],
      live: ['hobby_finder_opened'],
      posttrainllm: ['quickstart_opened'],
    });
  });
});
