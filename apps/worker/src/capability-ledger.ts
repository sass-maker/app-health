import type { CapabilityLedger, CapabilityState } from '@app-health/contracts';

const FEATURES: CapabilityLedger['features'] = [
  {
    id: 'browser_analytics',
    status: 'available',
    explanation:
      'Page views, anonymous visitors, acquisition, country/device/browser dimensions, filters and comparisons. Reports disclose sampling and observed-window limits.',
  },
  {
    id: 'product_events',
    status: 'partial',
    explanation:
      'Named events and scoped drill-down are available. Arbitrary properties, identity profiles and whole-session journeys are not implemented.',
  },
  {
    id: 'endpoint_monitoring',
    status: 'available',
    explanation:
      'Normalized endpoint counts, errors, fixed latency histograms and payload sizes. Successful raw request rows are not retained.',
  },
  {
    id: 'application_logs',
    status: 'available',
    explanation:
      'Explicit caller-authored logs with bounded detail retention; collection receipts do not prove any particular event occurred.',
  },
  {
    id: 'live_presence',
    status: 'available',
    explanation:
      'Workspace-scoped active sessions over one live connection. Sessions are not unique people; historical counts are separate.',
  },
  {
    id: 'public_reports',
    status: 'available',
    explanation:
      'Revocable aggregate-only shares with owner-controlled breakdown disclosure. Availability does not mean a share has been created.',
  },
  {
    id: 'javascript_sdk',
    status: 'available',
    explanation:
      'Maintained browser and server integrations with bounded delivery and runtime canaries. This is implementation status, not proof of installation in this environment.',
  },
  {
    id: 'native_swift',
    status: 'partial',
    explanation:
      'Local Swift package and collector runtime verified; remote package publication and project adoption are not qualified.',
  },
  {
    id: 'durable_history',
    status: 'partial',
    explanation:
      'Durable endpoint aggregates and immutable browser archive foundations exist. Historical replay, backfill, lossless compaction and long-range browser query parity remain incomplete.',
  },
  {
    id: 'bot_analytics',
    status: 'planned',
    explanation:
      'Dedicated classified server bot intake and reports are not implemented. Browser sessions do not measure non-JavaScript bots.',
  },
  {
    id: 'catalog_import',
    status: 'planned',
    explanation:
      'Bounded catalog import and ownership/verification semantics remain incomplete. Manual project creation is available.',
  },
  {
    id: 'provider_evidence',
    status: 'planned',
    explanation:
      'Cloudflare and Clarity provider evidence adapters are not implemented in this product. Existing external tooling does not establish this capability.',
  },
  {
    id: 'funnels_retention',
    status: 'deferred',
    explanation:
      'Funnels and cohorts are deferred by the focused-product decision; sampled aggregates do not prove exact conversion or retention.',
  },
  {
    id: 'profiles_revenue',
    status: 'deferred',
    explanation:
      'Identified profiles and revenue attribution are deferred, not implemented or inferred from anonymous browser recognition.',
  },
  {
    id: 'replay',
    status: 'deferred',
    explanation:
      'Clarity remains the replay and heat-map tool; App Health does not record or play session replay.',
  },
  {
    id: 'collaboration_experiments_ai',
    status: 'deferred',
    explanation:
      'Collaboration, experiments and AI analysis are deferred pending demonstrated product need.',
  },
];

export function capabilityLedger(
  app: string,
  environment: string,
  collection: CapabilityState[],
): CapabilityLedger {
  return {
    schema_version: 1,
    app_id: app,
    environment_id: environment,
    collection,
    features: FEATURES,
  };
}
