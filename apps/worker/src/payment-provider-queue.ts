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
async function wakeBlockedJob(runtime: ProviderRuntime, job: JobRow, token: string) {
  const busy = await runtime.db
    .prepare(
      `SELECT MIN(j.lease_until) AS until FROM payment_provider_jobs j JOIN payment_connections c ON c.id=j.connection_id WHERE j.status='running' AND j.lease_until>? AND c.workspace_id=(SELECT workspace_id FROM payment_connections WHERE id=?)`,
    )
    .bind(Date.now(), job.connection_id)
    .first<{ until: number | null }>();
  await wakeProviderJob(
    runtime,
    {
      ...job,
      lease_until: Math.max(job.lease_until, busy?.until ?? 0),
    },
    token,
  );
}
async function consumeOne(runtime: ProviderRuntime, wake: ProviderJobWake, run: boolean) {
  let job = await runtime.db
    .prepare('SELECT * FROM payment_provider_jobs WHERE id=?')
    .bind(wake.job_id)
    .first<JobRow>();
  if (!job || job.generation !== wake.generation) return;
  if (wake.schema_version === 1) {
    await wakeProviderJob(runtime, job);
    return;
  }
  const token = 'processing:' + wake.wake_token;
  const claimed = await runtime.db
    .prepare(
      `UPDATE payment_provider_jobs SET wake_token=?,wake_until=?
    WHERE id=? AND generation=? AND (wake_token=? OR (wake_token=? AND wake_until<=?)) AND status IN ('queued','running')
    AND EXISTS(SELECT 1 FROM payment_connections c WHERE c.id=connection_id AND c.status='active' AND c.generation=payment_provider_jobs.generation)`,
    )
    .bind(token, Date.now() + 60000, job.id, job.generation, wake.wake_token, token, Date.now())
    .run();
  if (!claimed.meta.changes) {
    const current = await jobRow(runtime.db, job.id);
    if (
      current.generation === wake.generation &&
      current.wake_token === token &&
      current.wake_until > Date.now()
    )
      return { retry: Math.max(1, Math.ceil((current.wake_until - Date.now()) / 1000)) };
    return;
  }
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
  if (['queued', 'running'].includes(job.status)) await wakeBlockedJob(runtime, job, token);
  else {
    await runtime.db
      .prepare(
        'UPDATE payment_provider_jobs SET wake_token=NULL,wake_until=0 WHERE id=? AND wake_token=?',
      )
      .bind(job.id, token)
      .run();
    await wakeSibling(runtime, job.connection_id, job.id);
  }
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
      const outcome = await consumeOne(runtime, message.body, index < 4);
      if (outcome) {
        message.retry({ delaySeconds: outcome.retry });
        continue;
      }
      message.ack();
    } catch {
      if (message.body.wake_token)
        await runtime.db
          .prepare(
            `UPDATE payment_provider_jobs SET wake_token=?,wake_until=0 WHERE id=? AND generation=? AND wake_token=?`,
          )
          .bind(
            message.body.wake_token,
            message.body.job_id,
            message.body.generation,
            'processing:' + message.body.wake_token,
          )
          .run();
      message.retry({ delaySeconds: 30 });
    }
  }
}
