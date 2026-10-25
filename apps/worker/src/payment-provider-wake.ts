import {
  ProviderError,
  type ProviderRuntime,
  type ProviderJobWake,
  type JobRow,
} from './payment-provider-model.js';
export function isProviderWake(value: unknown): value is ProviderJobWake {
  if (!value || typeof value !== 'object') return false;
  const wake = value as Record<string, unknown>;
  return (
    Object.keys(wake).sort().join(',') === 'generation,job_id,schema_version,type' &&
    wake.type === 'payment-provider-job' &&
    wake.schema_version === 1 &&
    typeof wake.job_id === 'string' &&
    /^[a-f0-9-]{36}$/.test(wake.job_id) &&
    Number.isSafeInteger(wake.generation) &&
    Number(wake.generation) > 0
  );
}
export async function wakeProviderJob(
  runtime: ProviderRuntime,
  job: Pick<JobRow, 'id' | 'generation' | 'status' | 'retry_at' | 'lease_until'>,
) {
  if (!['queued', 'running'].includes(job.status)) return;
  if (!runtime.queue) throw new ProviderError('provider_job_queue_unavailable', 503);
  const delaySeconds = Math.min(
    43200,
    Math.max(
      1,
      Math.ceil((Math.max(job.retry_at, job.lease_until, Date.now() + 1000) - Date.now()) / 1000),
    ),
  );
  await runtime.queue.send(
    { type: 'payment-provider-job', schema_version: 1, job_id: job.id, generation: job.generation },
    { delaySeconds },
  );
}
/** D1 acts as a bounded durable outbox if a producer crashes before Queue.send. */
export async function pumpProviderJobs(runtime: ProviderRuntime) {
  const now = Date.now(),
    deadline = performance.now() + 5000;
  const jobs = await runtime.db
    .prepare(
      `SELECT j.* FROM payment_provider_jobs j JOIN payment_connections c ON c.id=j.connection_id WHERE j.status IN ('queued','running') AND j.retry_at<=? AND j.lease_until<=? AND c.status='active' AND c.generation=j.generation ORDER BY j.updated_at,j.id LIMIT 25`,
    )
    .bind(now, now)
    .all<JobRow>();
  for (const job of jobs.results) {
    if (performance.now() > deadline) break;
    await wakeProviderJob(runtime, job);
  }
}
