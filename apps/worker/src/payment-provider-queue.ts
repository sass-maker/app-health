import { drainProviderJob } from './payment-provider-jobs.js';
import { connectionRow, jobRow } from './payment-provider-store.js';
import {
  type ProviderEnvironment,
  type ProviderRuntime,
  type ProviderJobWake,
  type JobRow,
} from './payment-provider-model.js';

import { wakeProviderJob } from './payment-provider-wake.js';
async function wakeSibling(runtime: ProviderRuntime, connection: string, exclude: string) {
  const job = await runtime.db
    .prepare(
      `SELECT * FROM payment_provider_jobs WHERE connection_id=? AND id!=? AND status IN ('queued','running') ORDER BY retry_at,created_at,id LIMIT 1`,
    )
    .bind(connection, exclude)
    .first<JobRow>();
  if (job) await wakeProviderJob(runtime, job);
}
async function wakeBlockedJob(runtime: ProviderRuntime, job: JobRow) {
  const busy = await runtime.db
    .prepare(
      `SELECT MIN(j.lease_until) AS until FROM payment_provider_jobs j JOIN payment_connections c ON c.id=j.connection_id WHERE j.status='running' AND j.lease_until>? AND c.workspace_id=(SELECT workspace_id FROM payment_connections WHERE id=?)`,
    )
    .bind(Date.now(), job.connection_id)
    .first<{ until: number | null }>();
  await wakeProviderJob(runtime, {
    ...job,
    lease_until: Math.max(job.lease_until, busy?.until ?? 0),
  });
}
async function consumeOne(runtime: ProviderRuntime, wake: ProviderJobWake, run: boolean) {
  let job = await runtime.db
    .prepare('SELECT * FROM payment_provider_jobs WHERE id=?')
    .bind(wake.job_id)
    .first<JobRow>();
  if (!job || job.generation !== wake.generation) return;
  const c = await connectionRow(runtime.db, job.connection_id);
  if (
    c.status !== 'active' ||
    c.generation !== job.generation ||
    !['queued', 'running'].includes(job.status)
  )
    return;
  if (run && job.retry_at <= Date.now() && job.lease_until <= Date.now())
    await drainProviderJob(runtime, job.id);
  job = await jobRow(runtime.db, job.id);
  if (['queued', 'running'].includes(job.status)) await wakeBlockedJob(runtime, job);
  else await wakeSibling(runtime, job.connection_id, job.id);
}
export async function consumeProviderJobs(
  messages: ReadonlyArray<Pick<Message<ProviderJobWake>, 'body' | 'ack' | 'retry'>>,
  env: ProviderEnvironment,
) {
  if (!env.DB) {
    for (const message of messages) message.retry({ delaySeconds: 30 });
    return;
  }
  const runtime: ProviderRuntime = {
    db: env.DB,
    keyring: env.PAYMENT_ENCRYPTION_KEYRING ?? '',
    queue: env.BROWSER_EVENTS,
  };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    try {
      await consumeOne(runtime, message.body, index < 4);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}
