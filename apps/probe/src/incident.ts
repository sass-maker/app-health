// Per-journey incident state with hysteresis. One failed complete response
// (timeout, incomplete body, network, HTTP or semantic failure) opens a failing
// incident at once. Slow completions open a degraded incident only after two in
// a row. Recovery needs two consecutive healthy runs. An open incident keeps one
// id until it recovers, so repeated bad runs update state without new alerts.

export type Outcome = 'ok' | 'slow' | 'failed';
type JourneyStatus = 'healthy' | 'degraded' | 'failing';

export interface JourneyState {
  status: JourneyStatus;
  bad_streak: number;
  good_streak: number;
  incident_id?: string;
  opened_at?: number;
  last_observed_at?: number;
  last_outcome?: Outcome;
}

export interface Transition {
  kind: 'opened' | 'escalated' | 'recovered';
  status: JourneyStatus;
  incident_id: string;
  opened_at: number;
}

const SLOW_RUNS_TO_OPEN = 2;
const HEALTHY_RUNS_TO_RECOVER = 2;

const HEALTHY: JourneyState = { status: 'healthy', bad_streak: 0, good_streak: 0 };

function open(
  state: JourneyState,
  status: JourneyStatus,
  now: number,
  newId: () => string,
): { state: JourneyState; transition: Transition } {
  const incidentId = state.incident_id ?? newId();
  const openedAt = state.opened_at ?? now;
  return {
    state: { ...state, status, incident_id: incidentId, opened_at: openedAt },
    transition: {
      kind: state.status === 'healthy' ? 'opened' : 'escalated',
      status,
      incident_id: incidentId,
      opened_at: openedAt,
    },
  };
}

/** Advance one journey by one observation. Pure; `newId` is called only when opening. */
export function advance(
  previous: JourneyState | undefined,
  outcome: Outcome,
  now: number,
  newId: () => string,
): { state: JourneyState; transition?: Transition } {
  const prior = previous ?? HEALTHY;
  if (outcome === 'ok') {
    const state: JourneyState = {
      ...prior,
      bad_streak: 0,
      good_streak: prior.good_streak + 1,
      last_observed_at: now,
      last_outcome: outcome,
    };
    if (prior.status === 'healthy' || state.good_streak < HEALTHY_RUNS_TO_RECOVER) return { state };
    const transition: Transition = {
      kind: 'recovered',
      status: 'healthy',
      incident_id: prior.incident_id ?? newId(),
      opened_at: prior.opened_at ?? now,
    };
    return {
      state: { ...HEALTHY, good_streak: state.good_streak, last_observed_at: now },
      transition,
    };
  }
  const state: JourneyState = {
    ...prior,
    bad_streak: prior.bad_streak + 1,
    good_streak: 0,
    last_observed_at: now,
    last_outcome: outcome,
  };
  if (outcome === 'failed')
    return prior.status === 'failing' ? { state } : open(state, 'failing', now, newId);
  if (prior.status !== 'healthy' || state.bad_streak < SLOW_RUNS_TO_OPEN) return { state };
  return open(state, 'degraded', now, newId);
}
