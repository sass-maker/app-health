/**
 * CTA policy for the Fleet daily engagement report.
 *
 * The rollout inventory names one existing Clarity CTA candidate for 42
 * products. Clarity is not an App Health event source, so those candidates are
 * useful for product review but cannot be queried as App Health counts.
 * Reportable names enter this map only after a deployed CTA click receives a
 * successful App Health browser-ingest response for its catalog-bound app.
 */

export interface DailyCtaPolicy {
  /** Existing Clarity action name from the Fleet rollout inventory, if any. */
  clarityCandidate: string | null;
  /** App Health event names with qualifying production ingest evidence. */
  qualifiedAppHealthEvents: readonly string[];
  qualification: 'verified' | 'candidate_only' | 'unknown';
}

/** Production browser-ingest receipts observed on 2026-09-28. */
const firstQualifiedIndiaDay = '2026-09-28';
const verifiedAppHealthEvents: Readonly<Record<string, readonly string[]>> = {
  anchor: ['testflight_status_opened'],
  'anime-list': ['cta_search'],
  browserdaddy: ['release_status_opened'],
  calorie: ['cta_testflight', 'cta_look_inside'],
  codevetter: ['benchmark_opened'],
  contextdaddy: ['how_it_works_opened'],
  daddyrad: ['app.performance.opened'],
  'every-song-is-a-website': ['song_world_opened'],
  'field-track': ['manager_dashboard_opened'],
  gitstat: ['cta.source_repository_opened'],
  'issue-pages': ['repository_reader_opened'],
  kith: ['how_it_works_opened'],
  live: ['hobby_finder_opened'],
  looptv: ['looptv.cta.start_watching', 'looptv.cta.browse_stations'],
  mashup: ['proof.play.clicked'],
  'meme-lab': ['paired_run_started'],
  mentionpilot: ['free_check.opened'],
  motion: ['how_it_works_opened'],
  'nutrition-formula-engine': ['formula_checked', 'report_downloaded'],
  'on-record': ['cta.inspect_receipt'],
  'open-historia': ['hero.play.clicked'],
  pace: ['pace_download_cta_clicked'],
  performancedaddy: ['source_opened'],
  'ph-catalog': ['sample_opened'],
  posttrainllm: ['quickstart_opened'],
  'reddit-insights': ['source_thread_opened', 'post_search_submitted'],
  reader: ['sample_opened'],
  rolepatch: ['free_tools_opened'],
  'saas-maker': ['directory_opened'],
  'sarthakagrawal-personal': ['projects_opened'],
  setline: ['testflight_status_opened'],
  significanthobbies: ['apps_explored', 'kith_opened'],
  starboard: ['public_catalog_browsed'],
  storagedaddy: ['download.clicked'],
  'what-it-takes-to-win': ['journey_continued'],
};

const candidateNames: Readonly<Record<string, string>> = {
  codevetter: 'benchmark_opened',
  pace: 'download_opened',
  posttrainllm: 'quickstart_opened',
  live: 'hobby_finder_opened',
  'saas-maker': 'directory_opened',
  gitstat: 'analysis_started',
  'email-manager': 'gmail_connect_opened',
  'chatgpt-memory-insights': 'capabilities_opened',
  'high-signal': 'signals_opened',
  'on-record': 'claim_search_opened',
  'issue-pages': 'publish_opened',
  'research-papers': 'reading_paths_opened',
  'knowledge-base': 'agent_contract_opened',
  significanthobbies: 'private_hub_opened',
  'anime-list': 'anime_search_opened',
  looptv: 'watch_started',
  reader: 'sample_opened',
  'swe-interview-prep': 'curriculum_opened',
  calorie: 'testflight_status_opened',
  setline: 'testflight_status_opened',
  kith: 'testflight_status_opened',
  rolepatch: 'free_tools_opened',
  karte: 'page_creation_opened',
  starboard: 'catalog_opened',
  'app-health': 'release_status_opened',
  mashup: 'receipt_opened',
  motion: 'testflight_status_opened',
  'web-playables': 'play_idle_startup',
  'what-it-takes-to-win': 'evidence_room_opened',
  'sarthakagrawal-personal': 'projects_opened',
  'field-track': 'manager_dashboard_opened',
  'reddit-insights': 'source_thread_opened',
  anchor: 'mac_beta_downloaded',
  storagedaddy: 'source_opened',
  browserdaddy: 'release_status_opened',
  performancedaddy: 'source_opened',
  'meme-lab': 'paired_run_started',
  'nutrition-formula-engine': 'formula_checked',
  'every-song-is-a-website': 'song_world_opened',
  contextdaddy: 'download_opened',
  mentionpilot: 'brand_check_opened',
  daddyrad: 'app_card_opened',
};

const productsWithoutCandidate = [
  'site-health',
  'chatgpt-connections',
  'fleet-social',
  'free-ai',
  'ios-landings',
  'ai-game',
  'open-historia',
  'ph-catalog',
  'nomad-data-adventure',
  'slow-serp',
  'unified-portfolio',
  'agent-testing',
  'war-chest',
] as const;

/** All 55 in-scope products; candidate names never become report counts. */
export const DAILY_CTA_POLICY: Readonly<Record<string, DailyCtaPolicy>> = Object.freeze(
  Object.fromEntries([
    ...Object.entries(candidateNames).map(([catalogId, clarityCandidate]) => [
      catalogId,
      {
        clarityCandidate,
        qualifiedAppHealthEvents: verifiedAppHealthEvents[catalogId] ?? [],
        qualification: verifiedAppHealthEvents[catalogId] ? 'verified' : 'candidate_only',
      } satisfies DailyCtaPolicy,
    ]),
    ...productsWithoutCandidate.map((catalogId) => [
      catalogId,
      {
        clarityCandidate: null,
        qualifiedAppHealthEvents: verifiedAppHealthEvents[catalogId] ?? [],
        qualification: verifiedAppHealthEvents[catalogId] ? 'verified' : 'unknown',
      } satisfies DailyCtaPolicy,
    ]),
  ]),
);

/** Only qualified App Health event names may be passed to report composition. */
export const DAILY_CTA_REPORT_EVENT_NAMES: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(DAILY_CTA_POLICY)
        .filter(([, policy]) => policy.qualifiedAppHealthEvents.length > 0)
        .map(([catalogId, policy]) => [catalogId, policy.qualifiedAppHealthEvents]),
    ),
  );

/** Older days remain unknown because these browser hooks were not yet qualified. */
export function dailyCtaEventNamesForDate(
  date: string,
): Readonly<Record<string, readonly string[]>> {
  return date >= firstQualifiedIndiaDay ? DAILY_CTA_REPORT_EVENT_NAMES : {};
}
