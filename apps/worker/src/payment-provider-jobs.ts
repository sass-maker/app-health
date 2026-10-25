import type { PaymentImportInput } from '@app-health/contracts';
import { openProviderCredentials } from './payment-provider-crypto.js';
import { providerSession } from './payment-provider-api.js';
import { providerPage, nextImportPage, type ImportCursor } from './payment-provider-pages.js';
import { processProviderResource } from './payment-provider-process.js';
import { activeConnection, jobRow, publicJob } from './payment-provider-store.js';
import {
  ProviderError,
  type ConnectionRow,
  type JobRow,
  type ProviderRuntime,
  type ProviderSession,
} from './payment-provider-model.js';

export async function startProviderImport(
  runtime: ProviderRuntime,
  c: ConnectionRow,
  input: PaymentImportInput,
  kind: 'import' | 'reconcile' = 'import',
) {
  const id = crypto.randomUUID(),
    now = Date.now();
  const result = await runtime.db
    .prepare(
      `INSERT INTO payment_provider_jobs(id,connection_id,generation,kind,status,phase,from_time,to_time,created_at,updated_at)
    SELECT ?,?,?,?,'queued','payments',?,?,?,? WHERE EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND status='active' AND cipher IS NOT NULL)
    AND (SELECT COUNT(*) FROM payment_provider_jobs WHERE connection_id=? AND kind!='webhook' AND status IN ('queued','running','paused'))<1
    AND (SELECT COUNT(*) FROM payment_provider_jobs j JOIN payment_connections c ON c.id=j.connection_id WHERE c.workspace_id=? AND j.kind!='webhook' AND j.status IN ('queued','running','paused'))<2`,
    )
    .bind(
      id,
      c.id,
      c.generation,
      kind,
      input.from,
      input.to,
      now,
      now,
      c.id,
      c.generation,
      c.id,
      c.workspace_id,
    )
    .run();
  if (!result.meta.changes) throw new ProviderError('active_import_capacity_or_disconnected', 409);
  return publicJob(await jobRow(runtime.db, id));
}
export async function resumeProviderJob(runtime: ProviderRuntime, job: JobRow) {
  await activeConnection(runtime.db, job.connection_id, job.generation);
  await runtime.db
    .prepare(
      `UPDATE payment_provider_jobs SET status='queued',reason=NULL,retry_at=0,updated_at=? WHERE id=? AND status='paused' AND lease_until<=?`,
    )
    .bind(Date.now(), job.id, Date.now())
    .run();
  return publicJob(await jobRow(runtime.db, job.id));
}
async function persist(
  runtime: ProviderRuntime,
  job: JobRow,
  lease: string,
  patch: Partial<JobRow>,
) {
  const next = { ...job, ...patch, updated_at: Date.now() };
  const result = await runtime.db
    .prepare(
      `UPDATE payment_provider_jobs SET status=?,phase=?,cursor=?,processed=?,recorded=?,unresolved=?,filtered=?,reason=?,retry_at=?,updated_at=?
    WHERE id=? AND lease_token=? AND lease_until>? AND generation=? AND EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND status='active')`,
    )
    .bind(
      next.status,
      next.phase,
      next.cursor,
      next.processed,
      next.recorded,
      next.unresolved,
      next.filtered,
      next.reason,
      next.retry_at,
      next.updated_at,
      job.id,
      lease,
      Date.now(),
      job.generation,
      job.connection_id,
      job.generation,
    )
    .run();
  if (!result.meta.changes) throw new ProviderError('job_lease_or_generation_changed', 409);
  Object.assign(job, next);
}
async function advancePage(
  runtime: ProviderRuntime,
  job: JobRow,
  lease: string,
  cursor: ImportCursor,
  provider: ProviderSession['connection']['provider'],
) {
  const next = nextImportPage(provider, job, cursor);
  if (next) return persist(runtime, job, lease, { cursor: JSON.stringify(next) });
  return persist(runtime, job, lease, {
    phase: job.phase === 'payments' ? 'refunds' : 'done',
    cursor: '{}',
    status: job.phase === 'payments' ? 'running' : 'finished',
  });
}
async function importStep(
  runtime: ProviderRuntime,
  session: ProviderSession,
  job: JobRow,
  lease: string,
) {
  let cursor = JSON.parse(job.cursor) as ImportCursor;
  if (!cursor.ids) {
    cursor = await providerPage(session, job, cursor);
    await persist(runtime, job, lease, { cursor: JSON.stringify(cursor) });
  }
  const offset = cursor.offset ?? 0;
  if (offset >= (cursor.ids?.length ?? 0))
    return advancePage(runtime, job, lease, cursor, session.connection.provider);
  const id = cursor.ids![offset];
  const kind = job.phase === 'payments' ? 'payment' : 'refund';
  const result = await processProviderResource(runtime.db, session, kind, id, {
    from: job.from_time,
    to: job.to_time,
  });
  cursor.offset = offset + 1;
  await persist(runtime, job, lease, {
    cursor: JSON.stringify(cursor),
    processed: job.processed + 1,
    recorded: job.recorded + result.recorded,
    unresolved: job.unresolved + result.unresolved,
    filtered: job.filtered + result.filtered,
  });
}
async function runSlice(runtime: ProviderRuntime, job: JobRow, lease: string) {
  const c = await activeConnection(runtime.db, job.connection_id, job.generation);
  const credentials = await openProviderCredentials(runtime.master, c, c.cipher);
  const session = providerSession(c, credentials, runtime.fetcher);
  session.fence = { jobId: job.id, leaseToken: lease };
  const deadline = performance.now() + 18000;
  session.deadline = deadline;
  if (job.kind === 'webhook') {
    const result = await processProviderResource(
      runtime.db,
      session,
      job.resource_kind!,
      job.resource_id!,
    );
    return persist(runtime, job, lease, {
      status: 'finished',
      phase: 'done',
      processed: 1,
      recorded: result.recorded,
      unresolved: result.unresolved,
      filtered: result.filtered,
    });
  }
  for (
    let records = 0;
    records < 25 &&
    session.requests < 8 &&
    performance.now() < deadline &&
    job.status === 'running';
    records++
  ) {
    if (job.processed >= 100000)
      throw new ProviderError('import_resource_cap_choose_narrower_period', 413);
    await importStep(runtime, session, job, lease);
  }
  if (job.status === 'running') await persist(runtime, job, lease, { status: 'queued' });
}
export async function drainProviderJob(runtime: ProviderRuntime, id: string) {
  const lease = crypto.randomUUID(),
    now = Date.now();
  const result = await runtime.db
    .prepare(
      `UPDATE payment_provider_jobs SET status='running',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND
    (status='queued' OR (status='running' AND lease_until<=?)) AND retry_at<=? AND EXISTS(SELECT 1 FROM payment_connections c WHERE c.id=connection_id AND c.generation=payment_provider_jobs.generation AND c.status='active')
    AND NOT EXISTS(SELECT 1 FROM payment_provider_jobs busy WHERE busy.connection_id=payment_provider_jobs.connection_id AND busy.id!=payment_provider_jobs.id AND busy.status='running' AND busy.lease_until>?)
    AND (SELECT COUNT(*) FROM payment_provider_jobs busy JOIN payment_connections bc ON bc.id=busy.connection_id WHERE busy.status='running' AND busy.lease_until>? AND busy.id!=payment_provider_jobs.id
      AND bc.workspace_id=(SELECT workspace_id FROM payment_connections WHERE id=payment_provider_jobs.connection_id))<2 RETURNING *`,
    )
    .bind(lease, now + 30000, now, id, now, now, now, now)
    .all<JobRow>();
  const job = result.results[0];
  if (!job) return;
  try {
    await runSlice(runtime, job, lease);
  } catch (error) {
    const reason = error instanceof ProviderError ? error.code : 'provider_job_failed_retryable';
    const retry = error instanceof ProviderError ? error.retryAt : Date.now() + 60000;
    const status = reason === 'slice_request_budget' || retry > 0 ? 'queued' : 'paused';
    await persist(runtime, job, lease, { status, reason, retry_at: retry }).catch(() => {});
  } finally {
    await runtime.db
      .prepare(
        'UPDATE payment_provider_jobs SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?',
      )
      .bind(id, lease)
      .run();
  }
}
export async function drainProviderJobs(runtime: ProviderRuntime) {
  const rows = await runtime.db
    .prepare(
      `SELECT id FROM payment_provider_jobs WHERE (status='queued' OR (status='running' AND lease_until<=?)) AND retry_at<=? AND NOT EXISTS(SELECT 1 FROM payment_provider_jobs busy WHERE busy.connection_id=payment_provider_jobs.connection_id AND busy.status='running' AND busy.lease_until>?) ORDER BY updated_at,id LIMIT 1`,
    )
    .bind(Date.now(), Date.now(), Date.now())
    .all<{ id: string }>();
  for (const row of rows.results) await drainProviderJob(runtime, row.id);
}

export async function cancelProviderJob(runtime: ProviderRuntime, job: JobRow) {
  await runtime.db
    .prepare(
      `UPDATE payment_provider_jobs SET status='cancelled',reason='cancelled_by_owner',lease_token=NULL,lease_until=0,updated_at=? WHERE id=? AND status!='finished'`,
    )
    .bind(Date.now(), job.id)
    .run();
  return publicJob(await jobRow(runtime.db, job.id));
}

export async function cleanupProviderJobs(runtime: ProviderRuntime) {
  await runtime.db
    .prepare(
      `DELETE FROM payment_provider_jobs WHERE rowid IN (SELECT rowid FROM payment_provider_jobs WHERE status IN ('finished','cancelled') AND updated_at<? ORDER BY updated_at LIMIT 1000)`,
    )
    .bind(Date.now() - 31 * 86400000)
    .run();
}
