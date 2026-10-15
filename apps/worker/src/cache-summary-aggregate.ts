import { LOG_RETENTION_DAYS } from '@app-health/contracts';

export const CACHE_SUMMARY_EVENT = 'web.cache.summary';
export const MAX_CACHE_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;
const COHORTS = ['unknown', 'declared_publisher', 'declared_diagnostic'] as const;
export type Cohort = (typeof COHORTS)[number];
type CountKey = 'hits' | 'misses' | 'bypasses' | 'eligible';
export type Counts = Record<CountKey, number>;

export interface CacheSummaryRow {
  log_id: string;
  timestamp: number;
  source: string;
  props: unknown;
}

export interface Bucket extends Counts {
  rows: number;
  eligible_hit_percent: number | null;
}

export interface VersionBucket extends Bucket {
  version: string;
  version_source: string;
  cohorts: Record<Cohort, Bucket>;
}

const counts = (): Counts => ({ hits: 0, misses: 0, bypasses: 0, eligible: 0 });
const bucket = (): Bucket => ({ ...counts(), rows: 0, eligible_hit_percent: null });
const cohortBuckets = (): Record<Cohort, Bucket> => ({
  unknown: bucket(),
  declared_publisher: bucket(),
  declared_diagnostic: bucket(),
});
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const VERSION =
  /^(?:[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|v?\d{1,8}\.\d{1,8}\.\d{1,8}(?:[-.][a-z0-9.-]{1,64})?)$/i;
function publicVersion(value: string, source: string) {
  if (source === 'unknown') return 'unknown';
  const valid =
    source === 'cache_build' ? /^[A-Za-z0-9._-]{1,128}$/.test(value) : VERSION.test(value);
  return valid ? value : 'other';
}

function readCounts(props: Record<string, unknown>, prefix = ''): Counts | null {
  const values = [
    props[`${prefix}hits`],
    props[`${prefix}misses`],
    props[`${prefix}bypasses`],
    props[`${prefix}eligible`],
  ];
  if (!values.every(integer)) return null;
  return {
    hits: values[0] as number,
    misses: values[1] as number,
    bypasses: values[2] as number,
    eligible: values[3] as number,
  };
}

function add(target: Bucket, value: Counts) {
  for (const key of ['hits', 'misses', 'bypasses', 'eligible'] as const) {
    const next = target[key] + value[key];
    if (!Number.isSafeInteger(next))
      throw new Error('Cache summary aggregate exceeds safe integer range');
    target[key] = next;
  }
}

function finish(target: Bucket) {
  target.eligible_hit_percent = target.eligible ? (100 * target.hits) / target.eligible : null;
}

/** Accumulate retained rows without returning owner-authored log properties. */
export class CacheSummaryAggregate {
  private readonly seen = new Set<string>();
  private readonly versions = new Map<string, VersionBucket>();
  private readonly total = bucket();
  private readonly cohorts = cohortBuckets();
  private malformed = 0;
  private crossBoundary = 0;
  private otherSource = 0;
  private duplicates = 0;
  private earliest: number | null = null;
  private latest: number | null = null;

  constructor(
    readonly start: number,
    readonly end: number,
    readonly now: number,
  ) {}

  add(row: CacheSummaryRow) {
    if (this.seen.has(row.log_id)) {
      this.duplicates += 1;
      return;
    }
    this.seen.add(row.log_id);
    if (row.source !== 'server') {
      this.otherSource += 1;
      return;
    }
    let props: unknown = row.props;
    if (typeof props === 'string') {
      try {
        props = JSON.parse(props);
      } catch {
        this.malformed += 1;
        return;
      }
    }
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      this.malformed += 1;
      return;
    }
    const value = props as Record<string, unknown>;
    const overall = readCounts(value);
    const byCohort = COHORTS.map((cohort) => readCounts(value, `${cohort}_`));
    const versionSource = value.version_source;
    if (
      value.scope !== 'worker_executed' ||
      !integer(value.started_at) ||
      !integer(value.ended_at) ||
      value.started_at > value.ended_at ||
      !overall ||
      byCohort.some((entry) => !entry) ||
      typeof value.version !== 'string' ||
      value.version.length > 128 ||
      typeof versionSource !== 'string' ||
      !['app_health_release', 'reader_source', 'cache_build', 'unknown'].includes(versionSource) ||
      (['hits', 'misses', 'bypasses', 'eligible'] as const).some(
        (key) => byCohort.reduce((sum, entry) => sum + (entry?.[key] ?? 0), 0) !== overall[key],
      )
    ) {
      this.malformed += 1;
      return;
    }
    if (value.started_at < this.start || value.ended_at > this.end) {
      this.crossBoundary += 1;
      return;
    }
    add(this.total, overall);
    this.total.rows += 1;
    this.earliest =
      this.earliest === null ? value.started_at : Math.min(this.earliest, value.started_at);
    this.latest = this.latest === null ? value.ended_at : Math.max(this.latest, value.ended_at);
    const versionLabel = publicVersion(value.version, versionSource);
    const versionKey = `${value.version_source}\u0000${versionLabel}`;
    let version = this.versions.get(versionKey);
    if (!version) {
      version = {
        ...bucket(),
        version: versionLabel,
        version_source: versionSource,
        cohorts: cohortBuckets(),
      };
      this.versions.set(versionKey, version);
    }
    add(version, overall);
    version.rows += 1;
    for (let i = 0; i < COHORTS.length; i += 1) {
      const cohort = COHORTS[i];
      const cohortCounts = byCohort[i] as Counts;
      add(this.cohorts[cohort], cohortCounts);
      add(version.cohorts[cohort], cohortCounts);
      if (Object.values(cohortCounts).some((count) => count > 0)) {
        this.cohorts[cohort].rows += 1;
        version.cohorts[cohort].rows += 1;
      }
    }
  }

  result() {
    finish(this.total);
    for (const cohort of COHORTS) finish(this.cohorts[cohort]);
    const versions = [...this.versions.values()].sort(
      (a, b) =>
        a.version_source.localeCompare(b.version_source) || a.version.localeCompare(b.version),
    );
    for (const version of versions) {
      finish(version);
      for (const cohort of COHORTS) finish(version.cohorts[cohort]);
    }
    return {
      refreshed_at: this.now,
      window: { start: this.start, end: this.end, semantics: '[start,end)' as const },
      retention: {
        days: LOG_RETENTION_DAYS,
        retained_from: this.now - LOG_RETENTION_DAYS * 86_400_000,
      },
      coverage: {
        basis: 'retained_server_logs_at_refresh' as const,
        complete_within_retention: this.start >= this.now - LOG_RETENTION_DAYS * 86_400_000,
        late_arrivals_possible: true,
      },
      contributing_rows: this.total.rows,
      earliest_started_at: this.earliest,
      latest_ended_at: this.latest,
      excluded: {
        malformed: this.malformed,
        cross_boundary: this.crossBoundary,
        other_source: this.otherSource,
        duplicate_ids: this.duplicates,
      },
      totals: this.total,
      cohorts: this.cohorts,
      versions,
    };
  }
}

export type CacheSummaryAggregateResult = ReturnType<CacheSummaryAggregate['result']>;
