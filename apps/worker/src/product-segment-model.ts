import type { ProductScope } from './product-event-model.js';
export type ProductSegment = {
  id: string;
  workspace_id: string;
  app_id: string;
  environment_id: string;
  channel: ProductScope['channel'];
  event_day: number;
  level: number;
  format: 1 | 2;
  reservation: string | null;
  batch_id: string | null;
  object_key: string;
  object_hash: string;
  object_bytes: number;
  event_count: number;
  min_time: number;
  max_time: number;
  received_at: number;
  active: number;
  cleanup_at: number;
};
export type CompactionJob = {
  workspace_id: string;
  app_id: string;
  environment_id: string;
  channel: ProductScope['channel'];
  event_day: number;
  epoch: number;
  dirty: number;
  closed: number;
  lease_token: string | null;
  lease_until: number;
  retry_at: number;
  error_code: string | null;
};
export const jobIdentity = (
  scope: Pick<
    CompactionJob,
    'workspace_id' | 'app_id' | 'environment_id' | 'channel' | 'event_day'
  >,
) => [scope.workspace_id, scope.app_id, scope.environment_id, scope.channel, scope.event_day];
export const JOB_WHERE =
  'workspace_id=? AND app_id=? AND environment_id=? AND channel=? AND event_day=?';
