import {
  normalizeAnalyticsSource,
  type AnalysisQuery,
  type AnalysisRecord,
  type AnalysisReport,
  type AnalysisStep,
  type BrowserSegmentFilter,
} from '@app-health/contracts';
import type { CollectedBrowserBatch } from './browser-analytics.js';
import { serializeBrowserEventFacts } from './browser-facts-digest.js';

type Fact = { event: CollectedBrowserBatch['events'][number]; batch: CollectedBrowserBatch };
const keyOf = (fact: Fact) =>
  JSON.stringify([fact.batch.app_id, fact.batch.environment_id, fact.event.event_id]);
const factSignature = (fact: Fact) =>
  serializeBrowserEventFacts({ ...fact.batch, batch_id: 'event', events: [fact.event] }, 2);

function factsInWindow(
  batches: Iterable<CollectedBrowserBatch>,
  query: AnalysisQuery,
  from: number,
  to: number,
): { facts: Fact[]; conflicts: number } {
  const facts = new Map<string, Fact>();
  const conflicts = new Set<string>();
  for (const batch of batches) {
    if (batch.app_id !== query.app_id || batch.environment_id !== query.environment_id) continue;
    for (const event of batch.events) {
      if (event.timestamp < from || event.timestamp >= to) continue;
      const fact = { event, batch };
      const key = keyOf(fact);
      if (conflicts.has(key)) continue;
      const saved = facts.get(key);
      if (saved && factSignature(saved) !== factSignature(fact)) {
        facts.delete(key);
        conflicts.add(key);
        continue;
      }
      if (!saved) facts.set(key, fact);
      if (facts.size + conflicts.size > 50000)
        throw new Error('Conversion event limit exceeded; choose a shorter period.');
    }
  }
  return {
    conflicts: conflicts.size,
    facts: [...facts.values()].sort(
      (a, b) =>
        a.event.timestamp - b.event.timestamp || a.event.event_id.localeCompare(b.event.event_id),
    ),
  };
}

function factDimensions(fact: Fact) {
  const { batch, event } = fact;
  return {
    path: event.path,
    source: normalizeAnalyticsSource(batch.attribution?.source ?? event.referrer),
    ...technologyDimensions(batch),
    ...acquisitionDimensions(batch),
  };
}
function technologyDimensions(batch: CollectedBrowserBatch) {
  return {
    country: batch.metadata?.country || 'Unknown',
    device: batch.metadata?.device || 'Unknown',
    browser: batch.metadata?.browser || 'Unknown',
    channel: batch.metadata?.channel || 'Unknown',
  };
}
function acquisitionDimensions(batch: CollectedBrowserBatch) {
  return {
    entry_path: batch.attribution?.entry_path ?? '',
    campaign: batch.attribution?.campaign ?? '',
    medium: batch.attribution?.medium ?? '',
    content: batch.attribution?.content ?? '',
    term: batch.attribution?.term ?? '',
  };
}
function segmentMatches(fact: Fact, filters: BrowserSegmentFilter = {}): boolean {
  const dimensions = factDimensions(fact);
  return Object.entries(filters).every(
    ([key, value]) =>
      dimensions[key as keyof typeof dimensions] ===
      (key === 'source' && value !== 'Unknown' ? normalizeAnalyticsSource(value) : value),
  );
}

function stepMatches(fact: Fact, step: AnalysisStep): boolean {
  const { event } = fact;
  if (step.type === 'page') {
    if (event.type !== 'pageview') return false;
    const prefix = step.target.endsWith('/*') ? step.target.slice(0, -2) : null;
    return prefix !== null
      ? event.path === prefix || event.path.startsWith(`${prefix}/`)
      : event.path === step.target;
  }
  return (
    event.type === 'event' &&
    event.name === step.target &&
    (step.property === undefined || event.properties?.[step.property] === step.equals)
  );
}

function sessionGroups(facts: Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (!fact.batch.session_hash) continue;
    const key = fact.batch.session_hash;
    const events = groups.get(key) ?? [];
    events.push(fact);
    groups.set(key, events);
  }
  return groups;
}

function goalResult(
  record: AnalysisRecord,
  facts: Fact[],
  denominator: number,
): AnalysisReport['goals'][number] {
  if (record.definition.kind !== 'goal') throw new Error('Expected goal');
  const step = record.definition.step;
  const matched = facts.filter((fact) => stepMatches(fact, step));
  const visitors = new Set(
    matched.flatMap(({ batch }) => (batch.visitor_hash ? [batch.visitor_hash] : [])),
  );
  return {
    id: record.id,
    name: record.definition.name,
    occurrences: matched.length,
    visitors: visitors.size,
    sessions: sessionGroups(matched).size,
    conversion_rate: denominator ? visitors.size / denominator : null,
    value: matched.reduce((sum, fact) => sum + (fact.event.value ?? 0), 0),
  };
}

type Progress = { start: number; last: number } | undefined;
function eligibleProgress(
  fact: Fact,
  step: number,
  prior: Progress,
  definition: Extract<AnalysisRecord['definition'], { kind: 'funnel' }>,
  filters: BrowserSegmentFilter,
) {
  if (step === 0) return segmentMatches(fact, filters) && segmentMatches(fact, definition.segment);
  return prior !== undefined && fact.event.timestamp - prior.start <= definition.window_ms;
}
function sessionProgress(
  events: Fact[],
  definition: Extract<AnalysisRecord['definition'], { kind: 'funnel' }>,
  filters: BrowserSegmentFilter,
) {
  const states: Progress[] = definition.steps.map(() => undefined);
  const reached = definition.steps.map(() => false);
  let elapsed: number | null = null;
  let timestamp = -1;
  let previous = [...states];
  for (const fact of events) {
    if (fact.event.timestamp !== timestamp) {
      previous = [...states];
      timestamp = fact.event.timestamp;
    }
    for (let step = definition.steps.length - 1; step >= 0; step--) {
      if (!stepMatches(fact, definition.steps[step])) continue;
      const prior = previous[step - 1];
      if (!eligibleProgress(fact, step, prior, definition, filters)) continue;
      const start = step === 0 ? timestamp : prior!.start;
      if (!states[step] || states[step]!.start <= start) states[step] = { start, last: timestamp };
      reached[step] = true;
      if (step === definition.steps.length - 1)
        elapsed = Math.min(elapsed ?? Infinity, timestamp - start);
    }
  }
  return { reached, elapsed };
}

function funnelResult(
  record: AnalysisRecord,
  groups: Map<string, Fact[]>,
  filters: BrowserSegmentFilter,
): AnalysisReport['funnels'][number] {
  if (record.definition.kind !== 'funnel') throw new Error('Expected funnel');
  const definition = record.definition;
  const counts = definition.steps.map(() => 0);
  const durations: number[] = [];
  for (const facts of groups.values()) {
    const result = sessionProgress(facts, definition, filters);
    result.reached.forEach((reached, index) => {
      if (reached) counts[index]++;
    });
    if (result.elapsed !== null) durations.push(result.elapsed);
  }
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length
    ? Math.round((durations[middle] + durations[Math.floor((durations.length - 1) / 2)]) / 2)
    : null;
  return {
    id: record.id,
    name: definition.name,
    steps: definition.steps.map((step, index) => ({
      target: step.target,
      sessions: counts[index],
      dropoff: index ? counts[index - 1] - counts[index] : 0,
      conversion_rate: index
        ? counts[index - 1]
          ? counts[index] / counts[index - 1]
          : null
        : counts[0]
          ? 1
          : null,
    })),
    conversion_rate: counts[0] ? counts.at(-1)! / counts[0] : null,
    median_conversion_ms: median,
  };
}

type PropertyCounts = Map<string, Map<string, { value: string | number | boolean; count: number }>>;
function addEventProperties(
  detail: { counts: PropertyCounts; totalBuckets: number; omitted: number },
  event: Fact['event'],
) {
  const properties = detail.counts;
  for (const [key, value] of Object.entries(event.properties ?? {})) {
    const counts = properties.get(key) ?? new Map();
    if (!properties.has(key) && properties.size >= 100) {
      detail.omitted++;
      continue;
    }
    const encoded = JSON.stringify(value);
    const existing = counts.get(encoded);
    if (!existing && counts.size >= 100) {
      detail.omitted++;
      continue;
    }
    if (!existing && detail.totalBuckets >= 1000) {
      detail.omitted++;
      continue;
    }
    if (!existing) detail.totalBuckets++;
    counts.set(encoded, { value, count: (existing?.count ?? 0) + 1 });
    properties.set(key, counts);
  }
}
function eventDetails(facts: Fact[], eventName: string | undefined) {
  const values = new Map<string, { name: string; occurrences: number; value: number }>();
  const detail = { counts: new Map() as PropertyCounts, totalBuckets: 0, omitted: 0 };
  for (const { event } of facts) {
    if (!event.name || (eventName && event.name !== eventName)) continue;
    const row = values.get(event.name) ?? { name: event.name, occurrences: 0, value: 0 };
    row.occurrences++;
    row.value += event.value ?? 0;
    values.set(event.name, row);
    if (!eventName) continue;
    addEventProperties(detail, event);
  }
  return {
    property_detail: { truncated: detail.omitted > 0, omitted_occurrences: detail.omitted },
    values: [...values.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, 100),
    properties: [...detail.counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => ({
        key,
        values: [...rows.values()].sort((a, b) => b.count - a.count),
      })),
  };
}

/** Exact computation over supplied archive facts; source completeness is supplied separately. */
export function evaluateConversions(input: {
  batches: Iterable<CollectedBrowserBatch>;
  query: AnalysisQuery;
  definitions: AnalysisRecord[];
  from: number;
  to: number;
  source: 'local' | 'archive';
  complete: boolean;
  coverage_note: string;
}): AnalysisReport {
  const observed = factsInWindow(input.batches, input.query, input.from, input.to);
  const all = observed.facts;
  const facts = all.filter((fact) => segmentMatches(fact, input.query.filters));
  const visitors = new Set(
    facts.flatMap(({ batch }) => (batch.visitor_hash ? [batch.visitor_hash] : [])),
  );
  const groups = sessionGroups(facts);
  const unidentified = [...groups.values()].filter(
    (rows) => !rows.some(({ batch }) => batch.visitor_hash),
  ).length;
  const allGroups = sessionGroups(all);
  return {
    from: input.from,
    to: input.to,
    source: input.source,
    complete: input.complete && observed.conflicts === 0,
    conflicting_events: observed.conflicts,
    coverage_note: observed.conflicts
      ? `${input.coverage_note.slice(0, 390)} ${observed.conflicts} conflicting event identities were excluded entirely. Unaffected observations remain available.`
      : input.coverage_note,
    events: facts.filter(({ event }) => event.type === 'event').length,
    sessions: groups.size,
    visitors: visitors.size,
    unidentified_sessions: unidentified,
    ...eventDetails(facts, input.query.event),
    goals: input.definitions
      .filter((row) => row.definition.kind === 'goal')
      .map((row) => goalResult(row, facts, visitors.size)),
    funnels: input.definitions
      .filter((row) => row.definition.kind === 'funnel')
      .map((row) => funnelResult(row, allGroups, input.query.filters ?? {})),
  };
}
