// App Health log events for probe results. Incidents travel as explicit,
// owner-authored `/v1/logs` events (the existing alert-feed path), attributed to
// the catalog project through `props.project`. Props are a fixed allowlist of
// ids, numeric timings and failure classes: no URLs, bodies, headers or values.

import type { Journey } from './spec.ts';
import type { Transition } from './incident.ts';
import type { FailureKind, Phases } from './measure.ts';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type PropValue = string | number | boolean | null;

export interface ProbeLog {
  log_id: string;
  timestamp: number;
  event: string;
  level: LogLevel;
  title: string;
  props: Record<string, PropValue>;
}

export interface Observation {
  journey: Journey;
  outcome: 'ok' | 'slow' | 'failed';
  failure?: FailureKind;
  status?: number;
  phases: Phases;
  warmTotalMs?: number;
  assetTotalMs?: number;
  serverMs?: number;
  edge?: string;
}

const PROBE_VERSION = 1;
export const DEFAULT_LOGS_URL = 'https://ingest.sassmaker.com/v1/logs';

function definedProps(props: Record<string, PropValue | undefined>): Record<string, PropValue> {
  return Object.fromEntries(
    Object.entries(props).filter((entry): entry is [string, PropValue] => entry[1] !== undefined),
  );
}

const EVENT_FOR: Record<Transition['status'], { event: string; level: LogLevel; verb: string }> = {
  failing: { event: 'journey.failed', level: 'error', verb: 'failing' },
  degraded: { event: 'journey.degraded', level: 'warn', verb: 'slow' },
  healthy: { event: 'journey.recovered', level: 'info', verb: 'recovered' },
};

/** One incident transition as a log event. */
export function transitionLog(
  transition: Transition,
  observation: Observation,
  location: string,
  context: { now: number; uuid: () => string },
): ProbeLog {
  const { journey, phases } = observation;
  const shape = EVENT_FOR[transition.status];
  return {
    log_id: context.uuid(),
    timestamp: context.now,
    event: shape.event,
    level: shape.level,
    title: `${journey.project} ${journey.journey} ${shape.verb} from ${location}`,
    props: definedProps({
      project: journey.project,
      journey: journey.journey,
      incident_id: transition.incident_id,
      transition: transition.kind,
      opened_at: transition.opened_at,
      location,
      synthetic: true,
      probe_version: PROBE_VERSION,
      outcome: observation.outcome,
      failure: observation.failure,
      http_status: observation.status,
      budget_ms: journey.budget_ms,
      total_ms: phases.total_ms,
      dns_ms: phases.dns_ms,
      connect_ms: phases.connect_ms,
      tls_ms: phases.tls_ms,
      headers_ms: phases.headers_ms,
      body_ms: phases.body_ms,
      warm_total_ms: observation.warmTotalMs,
      asset_total_ms: observation.assetTotalMs,
      server_ms: observation.serverMs,
      edge: observation.edge,
    }),
  };
}

export interface HeartbeatCounts {
  journeys: number;
  healthy: number;
  degraded: number;
  failing: number;
  vantage_offline: boolean;
  pending_logs: number;
}

/**
 * One debug-level heartbeat per run. Debug keeps it out of default Slack routes;
 * the owner feed reads it to mark a probe location fresh or stale.
 */
export function heartbeatLog(
  location: string,
  intervalSeconds: number,
  counts: HeartbeatCounts,
  context: { now: number; uuid: () => string },
): ProbeLog {
  return {
    log_id: context.uuid(),
    timestamp: context.now,
    event: 'probe.heartbeat',
    level: 'debug',
    title: `Journey probe run from ${location}`,
    props: {
      location,
      interval_seconds: intervalSeconds,
      synthetic: true,
      probe_version: PROBE_VERSION,
      ...counts,
    },
  };
}

export interface DeliveryConfig {
  key: string;
  url: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export type Deliver = (logs: ProbeLog[]) => Promise<boolean>;

/** POST one LogBatchV1 to App Health. Resolves false on any failure; never throws. */
export function createDeliver(config: DeliveryConfig, uuid: () => string): Deliver {
  return async (logs) => {
    if (logs.length === 0) return true;
    const fetchImpl = config.fetch ?? fetch;
    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
        body: JSON.stringify({
          batch_id: uuid(),
          schema_version: 'v1',
          environment: 'production',
          logs,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}
