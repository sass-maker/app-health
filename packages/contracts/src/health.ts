// Deterministic health-state calculation shared by ingest aggregation and the
// dashboard. Thresholds are constants, not configurable alert rules.

import {
  DEGRADED_ERROR_RATE,
  DEGRADED_P95_MS,
  HEALTH_STATES,
  INSUFFICIENT_DATA_MIN_REQUESTS,
  UNHEALTHY_ERROR_RATE,
  UNHEALTHY_P95_MS,
  type HealthState,
} from './constants.js';

export interface HealthInput {
  request_count: number;
  error_rate: number;
  p95_ms: number;
  /** Lower bound for p95 when historical bins cannot resolve a threshold. */
  p95_lower_bound_ms?: number;
}

/** Compute the deterministic health state for a windowed aggregate. */
export function healthState(input: HealthInput): HealthState {
  const lower = classifyHealthState(input, input.p95_lower_bound_ms ?? input.p95_ms);
  const upper = classifyHealthState(input, input.p95_ms);
  return lower === upper ? upper : 'insufficient-data';
}

function classifyHealthState(input: HealthInput, p95Ms: number): HealthState {
  if (input.request_count < INSUFFICIENT_DATA_MIN_REQUESTS) {
    return 'insufficient-data';
  }
  if (input.error_rate >= UNHEALTHY_ERROR_RATE || p95Ms >= UNHEALTHY_P95_MS) {
    return 'unhealthy';
  }
  if (input.error_rate >= DEGRADED_ERROR_RATE || p95Ms >= DEGRADED_P95_MS) {
    return 'degraded';
  }
  return 'healthy';
}

export const HEALTH_STATES_LIST: readonly HealthState[] = HEALTH_STATES;
