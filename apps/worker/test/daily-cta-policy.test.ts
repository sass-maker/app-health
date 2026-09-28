import { describe, expect, it } from 'vitest';
import {
  DAILY_CTA_POLICY,
  DAILY_CTA_NOT_APPLICABLE_IDS,
  DAILY_CTA_REPORT_EVENT_NAMES,
  dailyCtaEventNamesForDate,
} from '../src/daily-cta-policy.js';

describe('daily CTA policy', () => {
  it('covers the 55-product rollout scope while distinguishing verified events from candidates', () => {
    expect(Object.keys(DAILY_CTA_POLICY)).toHaveLength(55);
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'candidate_only'),
    ).toHaveLength(0);
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'verified'),
    ).toHaveLength(48);
    expect(DAILY_CTA_POLICY.posttrainllm).toMatchObject({
      clarityCandidate: 'quickstart_opened',
      qualification: 'verified',
      qualifiedAppHealthEvents: ['quickstart_opened', 'specialist_proof_opened'],
    });
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'unknown'),
    ).toHaveLength(0);
    expect(DAILY_CTA_POLICY['app-health']).toMatchObject({
      clarityCandidate: 'release_status_opened',
      qualification: 'verified',
      qualifiedAppHealthEvents: ['release_status_opened'],
    });
    expect(DAILY_CTA_POLICY['site-health']).toMatchObject({
      clarityCandidate: null,
      qualification: 'not_applicable',
      qualifiedAppHealthEvents: [],
    });
    expect(DAILY_CTA_NOT_APPLICABLE_IDS).toHaveLength(7);
    expect(
      Object.values(DAILY_CTA_POLICY).filter((policy) => policy.qualification === 'not_applicable'),
    ).toHaveLength(7);
  });

  it('reports only App Health events with production ingest receipts', () => {
    expect(DAILY_CTA_REPORT_EVENT_NAMES).toEqual({
      anchor: ['testflight_status_opened'],
      'agent-testing': ['tools_catalog_opened'],
      'ai-game': ['play_now_clicked'],
      'anime-list': ['cta_search'],
      'app-health': ['release_status_opened'],
      browserdaddy: ['release_status_opened'],
      calorie: ['cta_testflight', 'cta_look_inside'],
      codevetter: ['benchmark_opened', 'download.release'],
      contextdaddy: ['how_it_works_opened'],
      daddyrad: ['app.performance.opened', 'app.storage.opened'],
      'email-manager': ['kinetic.cta.hero_connect_gmail', 'kinetic.cta.nav_open_app'],
      'every-song-is-a-website': ['song_world_opened'],
      'field-track': ['manager_dashboard_opened'],
      'free-ai': ['access_requirements.opened'],
      gitstat: ['cta.source_repository_opened'],
      'high-signal': ['signals.browse_opened', 'track_record.opened'],
      'issue-pages': ['repository_reader_opened', 'publish_started'],
      karte: ['page_creation_opened', 'live_profile_opened'],
      kith: ['how_it_works_opened'],
      'knowledge-base': ['integration.contract.opened'],
      live: ['hobby_finder_opened', 'hobby_timeline_builder_opened'],
      looptv: ['looptv.cta.start_watching', 'looptv.cta.browse_stations'],
      mashup: ['proof.play.clicked'],
      'meme-lab': ['paired_run_started'],
      'chatgpt-memory-insights': ['capabilities_opened', 'analysis_opened'],
      mentionpilot: ['free_check.opened', 'workspace.sign_in.opened'],
      motion: ['how_it_works_opened'],
      'nutrition-formula-engine': ['formula_checked', 'report_downloaded'],
      'nomad-data-adventure': ['comparison_opened'],
      'on-record': ['cta.inspect_receipt', 'cta.search_evidence', 'cta.browse_books_tools'],
      'open-historia': ['hero.play.clicked'],
      pace: ['pace_download_cta_clicked'],
      performancedaddy: ['source_opened'],
      'ph-catalog': ['sample_opened'],
      posttrainllm: ['quickstart_opened', 'specialist_proof_opened'],
      'reddit-insights': ['source_thread_opened', 'post_search_submitted'],
      reader: ['sample_opened', 'library_opened'],
      'research-papers': ['reading_paths_opened'],
      rolepatch: ['free_tools_opened', 'workspace_opened'],
      'saas-maker': ['directory_opened', 'spotlight_opened'],
      'sarthakagrawal-personal': ['projects_opened'],
      setline: ['testflight_status_opened'],
      significanthobbies: ['apps_explored', 'kith_opened'],
      starboard: ['public_catalog_browsed', 'project_preview_cta_clicked'],
      storagedaddy: ['download.clicked'],
      'swe-interview-prep': ['cta.daily_priority'],
      'web-playables': ['game_opened'],
      'what-it-takes-to-win': ['journey_continued'],
    });
  });

  it('leaves days before the first production qualification unknown', () => {
    expect(dailyCtaEventNamesForDate('2026-09-27')).toEqual({});
    expect(dailyCtaEventNamesForDate('2026-09-28')).toEqual(DAILY_CTA_REPORT_EVENT_NAMES);
  });
});
