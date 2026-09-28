import { describe, expect, it } from 'vitest';
import { DAILY_CTA_POLICY, DAILY_CTA_REPORT_EVENT_NAMES } from '../src/daily-cta-policy.js';

describe('daily CTA policy', () => {
  it('covers the 55-product rollout scope while distinguishing verified events from candidates', () => {
    expect(Object.keys(DAILY_CTA_POLICY)).toHaveLength(55);
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'candidate_only'),
    ).toHaveLength(28);
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'verified'),
    ).toHaveLength(16);
    expect(DAILY_CTA_POLICY.posttrainllm).toMatchObject({
      clarityCandidate: 'quickstart_opened',
      qualification: 'verified',
      qualifiedAppHealthEvents: ['quickstart_opened'],
    });
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'unknown'),
    ).toHaveLength(11);
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
      'every-song-is-a-website': ['song_world_opened'],
      'field-track': ['manager_dashboard_opened'],
      kith: ['how_it_works_opened'],
      live: ['hobby_finder_opened'],
      mashup: ['proof.play.clicked'],
      'meme-lab': ['paired_run_started'],
      mentionpilot: ['free_check.opened'],
      motion: ['how_it_works_opened'],
      'open-historia': ['hero.play.clicked'],
      'ph-catalog': ['sample_opened'],
      posttrainllm: ['quickstart_opened'],
      'reddit-insights': ['source_thread_opened', 'post_search_submitted'],
      rolepatch: ['free_tools_opened'],
      'sarthakagrawal-personal': ['projects_opened'],
      setline: ['testflight_status_opened'],
    });
  });
});
