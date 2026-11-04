import type { TrafficQuality } from '@app-health/contracts';

export interface TrafficQualityTarget {
  context: string;
  key: string;
  from: number;
  to: number;
}
export type TrafficQualityState = { context: string; key: string } & (
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unavailable' }
  | { status: 'ready' | 'refreshing' | 'refresh_error'; report: TrafficQuality }
);

function retainedReading(state: TrafficQualityState, target: TrafficQualityTarget) {
  if (!('report' in state) || state.context !== target.context) return undefined;
  const report = state.report;
  return report.from <= target.from &&
    report.to <= target.to &&
    report.to - report.from === target.to - target.from
    ? report
    : undefined;
}

export function loadingTrafficQuality(
  state: TrafficQualityState,
  target: TrafficQualityTarget,
): TrafficQualityState {
  const report = retainedReading(state, target);
  return report ? { ...target, status: 'refreshing', report } : { ...target, status: 'loading' };
}

export function failedTrafficQuality(
  state: TrafficQualityState,
  target: TrafficQualityTarget,
): TrafficQualityState {
  const report = retainedReading(state, target);
  return report ? { ...target, status: 'refresh_error', report } : { ...target, status: 'error' };
}
