// One scheduled probe run: measure every journey, advance incident state, and
// deliver transitions plus a heartbeat. If every journey fails at the network
// layer the vantage itself is offline: no product incident is opened, because
// one local outage must not read as every product being down. Undelivered
// transitions stay queued (bounded) and retry with the same log ids, which the
// collector deduplicates.

import { advance, type JourneyState } from './incident.ts';
import {
  heartbeatLog,
  transitionLog,
  type Deliver,
  type Observation,
  type ProbeLog,
} from './emit.ts';
import type { FailureKind, HttpResult, Measure } from './measure.ts';
import { journeyKey, type Journey, type ProbeSpec } from './spec.ts';
import { firstPartyAsset, validateResponse } from './validate.ts';

export interface ProbeState {
  schema_version: 1;
  journeys: Record<string, JourneyState>;
  pending: ProbeLog[];
}

export interface RunOptions {
  location: string;
  intervalSeconds: number;
  userAgent: string;
}

export interface RunDeps {
  measure: Measure;
  deliver: Deliver;
  now: () => number;
  uuid: () => string;
}

export interface RunSummary {
  location: string;
  started_at: number;
  vantage_offline: boolean;
  delivered: boolean;
  pending_logs: number;
  journeys: Array<{
    key: string;
    outcome: Observation['outcome'];
    status: JourneyState['status'];
    failure?: FailureKind;
    detail?: string;
    headers_ms?: number;
    total_ms: number;
  }>;
}

export const MAX_PENDING_LOGS = 90;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const NETWORK_FAILURES = new Set<FailureKind | undefined>(['dns', 'connect', 'network']);

export function emptyState(): ProbeState {
  return { schema_version: 1, journeys: {}, pending: [] };
}

interface Measured {
  observation: Observation;
  detail?: string;
}

async function fetchAsset(
  journey: Journey,
  main: HttpResult,
  measure: Measure,
  userAgent: string,
): Promise<{ result?: HttpResult; missing: boolean }> {
  const assetUrl = firstPartyAsset(main.body?.toString('utf8') ?? '', journey.url);
  if (!assetUrl) return { missing: true };
  const result = await measure({
    url: assetUrl,
    method: 'GET',
    timeoutMs: journey.timeout_ms,
    maxBytes: MAX_BODY_BYTES * 4,
    userAgent,
  });
  return { result, missing: false };
}

function judge(journey: Journey, totals: number[], failure?: FailureKind): Observation['outcome'] {
  if (failure) return 'failed';
  return totals.some((total) => total > journey.budget_ms) ? 'slow' : 'ok';
}

async function measureJourney(
  journey: Journey,
  deps: RunDeps,
  userAgent: string,
): Promise<Measured> {
  const request = {
    url: journey.url,
    method: journey.method,
    body: journey.body,
    timeoutMs: journey.timeout_ms,
    maxBytes: MAX_BODY_BYTES,
    userAgent,
  };
  const main = await deps.measure(request);
  let verdict = validateResponse(main, journey.expect);
  let assetTotalMs: number | undefined;
  if (!verdict.failure && journey.expect.first_party_asset) {
    const asset = await fetchAsset(journey, main, deps.measure, userAgent);
    assetTotalMs = asset.result?.phases.total_ms;
    const assetFailed = asset.missing || asset.result?.failure || asset.result?.status !== 200;
    if (assetFailed)
      verdict = {
        failure: 'asset',
        detail: asset.missing ? 'no first-party asset' : 'asset failed',
      };
  }
  let warmTotalMs: number | undefined;
  if (!verdict.failure && journey.warm_check) {
    const warm = await deps.measure(request);
    warmTotalMs = warm.phases.total_ms;
    verdict = validateResponse(warm, journey.expect);
  }
  const totals = [main.phases.total_ms, assetTotalMs ?? 0, warmTotalMs ?? 0];
  return {
    detail: verdict.detail,
    observation: {
      journey,
      outcome: judge(journey, totals, verdict.failure),
      failure: verdict.failure,
      status: main.status,
      phases: main.phases,
      warmTotalMs,
      assetTotalMs,
      serverMs: main.serverMs,
      edge: main.edge,
    },
  };
}

function countStatuses(journeys: Record<string, JourneyState>, keys: string[]) {
  const statuses = keys.map((key) => journeys[key]?.status ?? 'healthy');
  return {
    healthy: statuses.filter((status) => status === 'healthy').length,
    degraded: statuses.filter((status) => status === 'degraded').length,
    failing: statuses.filter((status) => status === 'failing').length,
  };
}

/** Execute one run. Returns the next state to persist and a printable summary. */
export async function runProbes(
  spec: ProbeSpec,
  previous: ProbeState,
  options: RunOptions,
  deps: RunDeps,
): Promise<{ state: ProbeState; summary: RunSummary }> {
  const startedAt = deps.now();
  const measured: Measured[] = [];
  for (const journey of spec.journeys)
    measured.push(await measureJourney(journey, deps, options.userAgent));
  const vantageOffline = measured.every((item) => NETWORK_FAILURES.has(item.observation.failure));
  const journeys = { ...previous.journeys };
  const logs: ProbeLog[] = [];
  const context = { now: startedAt, uuid: deps.uuid };
  for (const { observation } of vantageOffline ? [] : measured) {
    const key = journeyKey(observation.journey);
    const next = advance(journeys[key], observation.outcome, startedAt, deps.uuid);
    journeys[key] = next.state;
    if (next.transition)
      logs.push(transitionLog(next.transition, observation, options.location, context));
  }
  const keys = spec.journeys.map(journeyKey);
  const queued = [...previous.pending, ...logs].slice(-MAX_PENDING_LOGS);
  const heartbeat = heartbeatLog(
    options.location,
    options.intervalSeconds,
    {
      journeys: keys.length,
      ...countStatuses(journeys, keys),
      vantage_offline: vantageOffline,
      pending_logs: queued.length,
    },
    context,
  );
  const delivered = await deps.deliver([...queued, heartbeat]);
  const pending = delivered ? [] : queued;
  return {
    state: { schema_version: 1, journeys, pending },
    summary: {
      location: options.location,
      started_at: startedAt,
      vantage_offline: vantageOffline,
      delivered,
      pending_logs: pending.length,
      journeys: measured.map(({ observation, detail }) => ({
        key: journeyKey(observation.journey),
        outcome: observation.outcome,
        status: journeys[journeyKey(observation.journey)]?.status ?? 'healthy',
        failure: observation.failure,
        detail,
        headers_ms: observation.phases.headers_ms,
        total_ms: observation.phases.total_ms,
      })),
    },
  };
}
