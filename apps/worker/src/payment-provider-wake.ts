import {
  ProviderError,
  requireProviderQueue,
  type ProviderRuntime,
  type ProviderJobWake,
  type JobRow,
} from './payment-provider-model.js';
export function isProviderWake(value: unknown): value is ProviderJobWake {
  if (!value || typeof value !== 'object') return false;
  const wake = value as Record<string, unknown>;
  const keys =
    wake.schema_version === 2
      ? 'generation,job_id,schema_version,type,wake_token'
      : 'generation,job_id,schema_version,type';
  return (
    Object.keys(wake).sort().join(',') === keys &&
    wake.type === 'payment-provider-job' &&
    (wake.schema_version === 1 || (wake.schema_version === 2 && validId(wake.wake_token))) &&
    validId(wake.job_id) &&
    Number.isSafeInteger(wake.generation) &&
    Number(wake.generation) > 0
  );
}
function validId(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
}
export async function wakeProviderJob(
  runtime: ProviderRuntime,
  job: Pick<JobRow, 'id' | 'generation' | 'status' | 'retry_at' | 'lease_until'>,
  previous: string | null = null,
) {
  if (!['queued', 'running'].includes(job.status)) return;
  if (!runtime.queue) throw new ProviderError('provider_job_queue_unavailable', 503);
  const now = Date.now();
  const delaySeconds = Math.min(
    43200,
    Math.max(1, Math.ceil((Math.max(job.retry_at, job.lease_until, now + 1000) - now) / 1000)),
  );
  const token = crypto.randomUUID();
  const reserved = await runtime.db
    .prepare(
      `UPDATE payment_provider_jobs SET wake_token=?,wake_until=?
    WHERE id=? AND generation=? AND status IN ('queued','running')
    AND (wake_token=? OR wake_token IS NULL OR wake_until<=?)
    AND EXISTS(SELECT 1 FROM payment_connections c WHERE c.id=connection_id AND c.status='active' AND c.generation=payment_provider_jobs.generation)`,
    )
    .bind(token, now + delaySeconds * 1000 + 60000, job.id, job.generation, previous, now)
    .run();
  if (!reserved.meta.changes) return;
  try {
    await runtime.queue.send(
      {
        type: 'payment-provider-job',
        schema_version: 2,
        job_id: job.id,
        generation: job.generation,
        wake_token: token,
      },
      { delaySeconds },
    );
  } catch (error) {
    // Restore the consumed delivery on failure so Queue.retry can claim it again.
    await runtime.db
      .prepare(
        `UPDATE payment_provider_jobs SET wake_token=?,wake_until=0 WHERE id=? AND generation=? AND wake_token=?`,
      )
      .bind(previous?.replace(/^processing:/, '') ?? null, job.id, job.generation, token)
      .run();
    throw error;
  }
}
/** Successful durable owner mutations stay successful if outbox publication is unavailable. */
export async function dispatchProviderJob(runtime: ProviderRuntime, job: JobRow) {
  requireProviderQueue(runtime);
  try {
    await wakeProviderJob(runtime, job);
  } catch {
    await runtime.db
      .prepare(
        `UPDATE payment_provider_jobs SET reason=COALESCE(reason,'queue_dispatch_pending') WHERE id=? AND generation=? AND status IN ('queued','running')`,
      )
      .bind(job.id, job.generation)
      .run();
  }
}
/** D1 is the durable outbox; expired reservations recover crashed producers. */
export async function pumpProviderJobs(runtime: ProviderRuntime) {
  const now = Date.now(),
    deadline = performance.now() + 5000;
  const jobs = await runtime.db
    .prepare(
      `SELECT j.* FROM payment_provider_jobs j JOIN payment_connections c ON c.id=j.connection_id
    WHERE j.status IN ('queued','running') AND j.retry_at<=? AND j.lease_until<=?
    AND (j.wake_token IS NULL OR j.wake_until<=?) AND c.status='active' AND c.generation=j.generation
    ORDER BY j.updated_at,j.id LIMIT 25`,
    )
    .bind(now, now, now)
    .all<JobRow>();
  for (const job of jobs.results) {
    if (performance.now() > deadline) break;
    await wakeProviderJob(runtime, job);
  }
}
