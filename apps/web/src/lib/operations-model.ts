export type OperationsHealth =
  'healthy' | 'failing' | 'degraded' | 'unknown' | 'running' | 'attention' | 'unavailable';
export type OperationsFreshness = 'current' | 'stale' | 'missing';
export interface OperationsProject {
  id: string;
  name: string;
  audience: 'public' | 'internal';
  kind: 'product' | 'experiment' | 'platform';
}
export interface OperationsFamily {
  id: string;
  name: string;
  producer: string;
  collector: string;
  connected: boolean;
  limitations: string;
}
export interface OperationsFeed {
  id: string;
  familyId: string;
  name: string;
  projectIds: string[];
  producer: string;
  collector: string;
  collectedAt: string | null;
  observedAt: string | null;
  freshness: OperationsFreshness;
  health: OperationsHealth;
  summary: string;
  limitations: string;
  evidenceUrl?: string;
  maximumAgeMs?: number;
}
export interface OperationsObservation {
  id: string;
  feedId: string;
  projectId: string | null;
  scope: string;
  severity: 'error' | 'warning' | 'info';
  status: 'open' | 'running' | 'resolved' | 'unknown';
  title: string;
  detail: string;
  observedAt: string | null;
  evidenceUrl?: string;
}
export interface OperationsSnapshot {
  schemaVersion: 'operations.v1';
  generatedAt: string;
  projects: OperationsProject[];
  families: OperationsFamily[];
  feeds: OperationsFeed[];
  observations: OperationsObservation[];
}

const health = ['healthy', 'failing', 'degraded', 'unknown', 'running', 'attention', 'unavailable'];
const freshness = ['current', 'stale', 'missing'];
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 2000 &&
  !/\/(?:Users|home|private|tmp)\/[^\s]/.test(value);
const date = (value: unknown) =>
  value === null || (text(value) && Number.isFinite(Date.parse(value)));
const textFields = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => text(value[key]));
function safeUrl(value: unknown): boolean {
  if (value === undefined) return true;
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some((key) =>
        /token|secret|password|key|authorization/i.test(key),
      )
    );
  } catch {
    return false;
  }
}
function validProject(value: unknown): value is OperationsProject {
  return (
    record(value) &&
    textFields(value, ['id', 'name']) &&
    ['public', 'internal'].includes(String(value.audience)) &&
    ['product', 'experiment', 'platform'].includes(String(value.kind))
  );
}
function validFamily(value: unknown): value is OperationsFamily {
  return (
    record(value) &&
    textFields(value, ['id', 'name', 'producer', 'collector', 'limitations']) &&
    typeof value.connected === 'boolean'
  );
}
function validFeed(value: unknown): value is OperationsFeed {
  return (
    record(value) &&
    textFields(value, [
      'id',
      'familyId',
      'name',
      'producer',
      'collector',
      'summary',
      'limitations',
    ]) &&
    Array.isArray(value.projectIds) &&
    value.projectIds.every(text) &&
    date(value.collectedAt) &&
    date(value.observedAt) &&
    health.includes(String(value.health)) &&
    freshness.includes(String(value.freshness)) &&
    safeUrl(value.evidenceUrl) &&
    (value.maximumAgeMs === undefined ||
      (typeof value.maximumAgeMs === 'number' &&
        value.maximumAgeMs >= 60_000 &&
        value.maximumAgeMs <= 365 * 86_400_000))
  );
}
function validObservation(value: unknown): value is OperationsObservation {
  return (
    record(value) &&
    textFields(value, ['id', 'feedId', 'scope', 'title', 'detail']) &&
    (value.projectId === null || text(value.projectId)) &&
    date(value.observedAt) &&
    ['error', 'warning', 'info'].includes(String(value.severity)) &&
    ['open', 'running', 'resolved', 'unknown'].includes(String(value.status)) &&
    safeUrl(value.evidenceUrl)
  );
}
function uniqueIds(values: { id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}
function boundedArray(
  value: unknown,
  maximum: number,
  validate: (value: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.length <= maximum && value.every(validate);
}
function validEnvelope(value: unknown): value is OperationsSnapshot {
  if (!record(value)) return false;
  return (
    value.schemaVersion === 'operations.v1' &&
    text(value.generatedAt) &&
    Number.isFinite(Date.parse(value.generatedAt)) &&
    boundedArray(value.projects, 500, validProject) &&
    boundedArray(value.families, 100, validFamily) &&
    boundedArray(value.feeds, 5000, validFeed) &&
    boundedArray(value.observations, 10000, validObservation)
  );
}
function validRelationships(snapshot: OperationsSnapshot): boolean {
  const projects = new Set(snapshot.projects.map((entry) => entry.id));
  const families = new Set(snapshot.families.map((entry) => entry.id));
  const feeds = new Set(snapshot.feeds.map((entry) => entry.id));
  const validFeedScope = (feed: OperationsFeed) =>
    families.has(feed.familyId) && feed.projectIds.every((id) => projects.has(id));
  const validObservationScope = (entry: OperationsObservation) =>
    feeds.has(entry.feedId) && (entry.projectId === null || projects.has(entry.projectId));
  return (
    [snapshot.projects, snapshot.families, snapshot.feeds, snapshot.observations].every(
      uniqueIds,
    ) &&
    snapshot.feeds.every(validFeedScope) &&
    snapshot.observations.every(validObservationScope)
  );
}
function publicFeed(feed: OperationsFeed): OperationsFeed {
  const {
    id,
    familyId,
    name,
    projectIds,
    producer,
    collector,
    collectedAt,
    observedAt,
    freshness,
    health,
    summary,
    limitations,
    evidenceUrl,
    maximumAgeMs,
  } = feed;
  return {
    id,
    familyId,
    name,
    projectIds,
    producer,
    collector,
    collectedAt,
    observedAt,
    freshness,
    health,
    summary,
    limitations,
    ...(evidenceUrl ? { evidenceUrl } : {}),
    ...(maximumAgeMs ? { maximumAgeMs } : {}),
  };
}
function publicObservation(entry: OperationsObservation): OperationsObservation {
  const { id, feedId, projectId, scope, severity, status, title, detail, observedAt, evidenceUrl } =
    entry;
  return {
    id,
    feedId,
    projectId,
    scope,
    severity,
    status,
    title,
    detail,
    observedAt,
    ...(evidenceUrl ? { evidenceUrl } : {}),
  };
}
export function readOperationsSnapshot(value: unknown): OperationsSnapshot {
  if (!validEnvelope(value)) throw new Error('Invalid operations snapshot');
  if (!validRelationships(value)) throw new Error('Invalid operations relationships');
  return {
    schemaVersion: 'operations.v1',
    generatedAt: value.generatedAt,
    projects: value.projects.map(({ id, name, audience, kind }) => ({ id, name, audience, kind })),
    families: value.families.map(({ id, name, producer, collector, connected, limitations }) => ({
      id,
      name,
      producer,
      collector,
      connected,
      limitations,
    })),
    feeds: value.feeds.map(publicFeed),
    observations: value.observations.map(publicObservation),
  };
}

export function currentOperationsSnapshot(
  snapshot: OperationsSnapshot,
  now = Date.now(),
): OperationsSnapshot {
  const collectionBased = new Set([
    'github-ci',
    'github-schedules',
    'github-security',
    'deployments',
    'runners',
  ]);
  return {
    ...snapshot,
    feeds: snapshot.feeds.map((feed) => {
      const timestamp = collectionBased.has(feed.familyId) ? feed.collectedAt : feed.observedAt;
      const maximum =
        feed.maximumAgeMs ??
        (['usage', 'deployments', 'runners'].includes(feed.familyId) ? 86_400_000 : 3_600_000);
      const freshness =
        feed.freshness === 'missing' || !timestamp
          ? 'missing'
          : now - Date.parse(timestamp) > maximum || Date.parse(timestamp) > now + 300_000
            ? 'stale'
            : feed.freshness;
      return { ...feed, freshness };
    }),
  };
}
