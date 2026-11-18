export type AnalyticsQueryStage =
  | 'analyticsTrendMs'
  | 'analyticsPagesMs'
  | 'analyticsSourcesMs'
  | 'analyticsEventsMs'
  | 'analyticsAudiencePreviousMs'
  | 'analyticsDimensionMaxMs'
  | 'analyticsEngagementMs'
  | 'analyticsExitsMs'
  | 'analyticsJointMs';
type AnalyticsReportTimings = {
  analyticsQueryWaitMs?: number;
  analyticsReportAssemblyMs?: number;
  analyticsJointAttempts?: number;
  analyticsJointFallbacks?: number;
} & Partial<Record<AnalyticsQueryStage, number>>;
export type QueryOptions = {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
  appIds?: readonly string[];
  timings?: AnalyticsReportTimings;
  signal?: AbortSignal;
  deadlineAt?: number;
};

export interface QueryRow extends Record<string, unknown> {
  period?: number | string;
  name?: string;
  count?: number | string;
  last_seen?: number | string;
  bucket?: number | string;
  pageviews?: number | string;
  events?: number | string;
  sessions?: number | string;
  visitors?: number | string;
  new_sessions?: number | string;
  returning_sessions?: number | string;
  unidentified_sessions?: number | string;
  bounced_sessions?: number | string;
  pageview_sessions?: number | string;
  average_session_duration_ms?: number | string;
  sample_interval: number | string;
}
