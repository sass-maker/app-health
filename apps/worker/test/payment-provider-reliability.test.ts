import { expect, it, vi, afterEach } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import entry from '../src/analytics-entry.js';
import { providerFixture } from './payment-provider-fixture.js';
import { pumpProviderJobs, dispatchProviderJob } from '../src/payment-provider-wake.js';
import {
  startProviderImport,
  cleanupProviderJobs,
  drainProviderJob,
} from '../src/payment-provider-jobs.js';
import { jobRow } from '../src/payment-provider-store.js';
import { rememberProviderIssue } from '../src/payment-provider-issues.js';
import { ProviderError, type ProviderJobWake } from '../src/payment-provider-model.js';
import { providerRevenueReport } from '../src/payment-provider-report.js';
import { providerPage, nextImportPage } from '../src/payment-provider-pages.js';
import type { Env } from '../src/index.js';
afterEach(() => vi.unstubAllGlobals());
it('deduplicates pump and delivery chains while failed owner dispatch remains durably recoverable', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      pending: ProviderJobWake[] = [];
    const send = vi.fn(async (wake: ProviderJobWake) => {
      pending.push(wake);
    });
    for (let i = 2; i <= 80; i++) f.payments.push({ ...f.payment, id: 'ch_' + i });
    const runtime = { ...f.runtime, queue: { send } };
    const job = await startProviderImport(runtime, c, { from: 0, to: Date.now() });
    send.mockRejectedValueOnce(new Error('offline'));
    await dispatchProviderJob(runtime, await jobRow(f.db, job.id));
    expect(await jobRow(f.db, job.id)).toMatchObject({
      status: 'queued',
      reason: 'queue_dispatch_pending',
    });
    await Promise.all([
      pumpProviderJobs(runtime),
      pumpProviderJobs(runtime),
      pumpProviderJobs(runtime),
    ]);
    expect(pending).toHaveLength(1);
    vi.stubGlobal('fetch', f.runtime.fetcher);
    const env = {
      DB: f.db,
      PAYMENT_ENCRYPTION_KEYRING: runtime.keyring,
      BROWSER_EVENTS: runtime.queue,
    } as Env;
    const first = pending.shift()!;
    const deliver = async (body: ProviderJobWake) => {
      const ack = vi.fn(),
        retry = vi.fn();
      await entry.queue(
        { messages: [{ body, ack, retry }] } as unknown as MessageBatch<ProviderJobWake>,
        env,
      );
      expect(retry).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledOnce();
    };
    await deliver(first);
    const count = send.mock.calls.length;
    await Promise.all([deliver(first), deliver(first), pumpProviderJobs(runtime)]);
    expect(send).toHaveBeenCalledTimes(count);
    let slices = 1;
    while (pending.length) {
      const wake = pending.shift()!;
      await deliver(wake);
      const published = send.mock.calls.length;
      await Promise.all([deliver(wake), pumpProviderJobs(runtime)]);
      expect(send).toHaveBeenCalledTimes(published);
      expect(pending.length).toBeLessThanOrEqual(1);
      expect(++slices).toBeLessThan(100);
    }
    expect(slices).toBeGreaterThan(3);
    expect(await jobRow(f.db, job.id)).toMatchObject({ status: 'finished' });
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM payment_facts').get()).toMatchObject({ n: 81 });
  } finally {
    f.sqlite.close();
  }
});
it('keeps saturated diagnostics bounded without poisoning progress and expires only bounded observations', async () => {
  const f = providerFixture();
  try {
    const session = await f.session(),
      error = new ProviderError('invalid_provider_amount');
    const insert = f.sqlite.prepare('INSERT INTO payment_provider_issues VALUES(?,?,?,?,?)');
    for (let i = 0; i < 1000; i++)
      insert.run(session.connection.id, 'payment', 'bad_' + i, error.code, 0);
    await rememberProviderIssue(f.db, session, 'payment', 'omitted', error);
    await rememberProviderIssue(f.db, session, 'payment', 'omitted', error);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM payment_provider_issues').get()).toMatchObject({
      n: 1000,
    });
    let report = await providerRevenueReport(f.db, {
      app_id: 'app',
      environment_id: 'env',
      from: 0,
      to: Date.now() + 1,
      breakdown: 'source',
    });
    expect(report.diagnostics_truncated).toBe(true);
    f.payment.amount_captured = -1;
    const job = await startProviderImport(f.runtime, session.connection, {
      from: 0,
      to: Date.now(),
    });
    for (let i = 0; i < 4; i++) await drainProviderJob(f.runtime, job.id);
    expect(await jobRow(f.db, job.id)).toMatchObject({ status: 'finished' });
    report = await providerRevenueReport(f.db, {
      app_id: 'app',
      environment_id: 'env',
      from: 0,
      to: Date.now() + 1,
      breakdown: 'source',
    });
    expect(
      report.unresolved
        .filter((row) => row.reason.startsWith('unknown_resource_time_'))
        .reduce((n, row) => n + row.count, 0),
    ).toBe(1000);
    await cleanupProviderJobs(f.runtime);
    expect(
      f.sqlite.prepare('SELECT COUNT(*) n FROM payment_provider_issues WHERE observed_at=0').get(),
    ).toMatchObject({ n: 0 });
    report = await providerRevenueReport(f.db, {
      app_id: 'app',
      environment_id: 'env',
      from: 0,
      to: Date.now() + 1,
      breakdown: 'source',
    });
    expect(
      report.unresolved.filter((row) => row.reason.startsWith('unknown_resource_time_')),
    ).toEqual([]);
    expect(report.unresolved.reduce((n, row) => n + row.count, 0)).toBe(2);
    await rememberProviderIssue(f.db, session, 'payment', 'new', error);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM payment_provider_issues').get()).toMatchObject({
      n: 1,
    });
  } finally {
    f.sqlite.close();
  }
});
it('accepts Polar page overlap caused by new refunds while retaining within-page ordering validation', async () => {
  const f = providerFixture('polar');
  try {
    const session = await f.session();
    for (let i = 2; i <= 30; i++)
      f.refunds.push({
        ...f.refund,
        id: 'ref_' + i,
        created_at: new Date(f.time + i * 1000).toISOString(),
      });
    const job = await startProviderImport(f.runtime, session.connection, {
      from: f.time - 1,
      to: Date.now(),
    });
    const row = { ...(await jobRow(f.db, job.id)), phase: 'refunds' as const };
    const first = await providerPage(session, row, {});
    f.refunds.push(
      { ...f.refund, id: 'new_1', created_at: new Date(f.time + 31000).toISOString() },
      { ...f.refund, id: 'new_2', created_at: new Date(f.time + 32000).toISOString() },
    );
    const second = await providerPage(session, row, nextImportPage('polar', row, first)!);
    expect(second.ids!.some((id) => first.ids!.includes(id))).toBe(true);
    expect(new Set([...first.ids!, ...second.ids!]).size).toBe(30);
    expect(second.more).toBe(false);
  } finally {
    f.sqlite.close();
  }
});

it('rejects missing Queue configuration before import/resume/replace writes or provider verification', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      runtime = { ...f.runtime, queue: undefined };
    const calls = f.calls.length;
    await expect(startProviderImport(runtime, c, { from: 0, to: Date.now() })).rejects.toThrow(
      'queue_unavailable',
    );
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM payment_provider_jobs').get()).toMatchObject({
      n: 0,
    });
    const { replaceProviderCredentials } = await import('../src/payment-provider-connections.js');
    await expect(replaceProviderCredentials(runtime, c, f.credentials)).rejects.toThrow(
      'queue_unavailable',
    );
    expect(f.calls).toHaveLength(calls);
    expect(f.sqlite.prepare('SELECT generation FROM payment_connections').get()).toMatchObject({
      generation: 1,
    });
    const job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    f.sqlite.prepare("UPDATE payment_provider_jobs SET status='paused' WHERE id=?").run(job.id);
    const { resumeProviderJob } = await import('../src/payment-provider-jobs.js');
    await expect(resumeProviderJob(runtime, await jobRow(f.db, job.id))).rejects.toThrow(
      'queue_unavailable',
    );
    expect(await jobRow(f.db, job.id)).toMatchObject({ status: 'paused' });
  } finally {
    f.sqlite.close();
  }
});
it('retries live own processing-token redeliveries without stealing and reclaims them after a crashed lease expires', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() }),
      token = crypto.randomUUID();
    f.sqlite
      .prepare('UPDATE payment_provider_jobs SET wake_token=?,wake_until=? WHERE id=?')
      .run('processing:' + token, Date.now() + 60000, job.id);
    vi.stubGlobal('fetch', f.runtime.fetcher);
    const env = {
      DB: f.db,
      PAYMENT_ENCRYPTION_KEYRING: f.runtime.keyring,
      BROWSER_EVENTS: f.runtime.queue,
    } as Env;
    const body = {
        type: 'payment-provider-job',
        schema_version: 2,
        job_id: job.id,
        generation: 1,
        wake_token: token,
      },
      ack = vi.fn(),
      retry = vi.fn();
    await entry.queue(
      { messages: [{ body, ack, retry }] } as unknown as MessageBatch<ProviderJobWake>,
      env,
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(await jobRow(f.db, job.id)).toMatchObject({
      processed: 0,
      wake_token: 'processing:' + token,
    });
    f.sqlite.prepare('UPDATE payment_provider_jobs SET wake_until=0 WHERE id=?').run(job.id);
    const nextAck = vi.fn(),
      nextRetry = vi.fn();
    await entry.queue(
      {
        messages: [{ body, ack: nextAck, retry: nextRetry }],
      } as unknown as MessageBatch<ProviderJobWake>,
      env,
    );
    expect(nextAck).toHaveBeenCalledOnce();
    expect(nextRetry).not.toHaveBeenCalled();
    expect((await jobRow(f.db, job.id)).processed).toBeGreaterThan(0);
  } finally {
    f.sqlite.close();
  }
});
it('qualifies bounded omission flags by observation window and retains conservative historical coverage after diagnostic expiry', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      now = Date.now();
    f.sqlite
      .prepare('INSERT INTO payment_provider_issue_state VALUES(?,1,?,?)')
      .run(c.id, now - 10000, now - 5000);
    const query = {
      app_id: 'app',
      environment_id: 'env',
      from: now - 20000,
      to: now - 1000,
      breakdown: 'source' as const,
    };
    expect((await providerRevenueReport(f.db, query)).diagnostics_truncated).toBe(true);
    expect(
      (await providerRevenueReport(f.db, { ...query, from: now, to: now + 1000 }))
        .diagnostics_truncated,
    ).toBe(false);
    expect(
      (await providerRevenueReport(f.db, { ...query, from: now - 50000, to: now - 30000 }))
        .diagnostics_truncated,
    ).toBe(false);
    f.sqlite
      .prepare('UPDATE payment_connections SET created_at=? WHERE id=?')
      .run(now - 40 * 86400000, c.id);
    f.sqlite
      .prepare('UPDATE payment_provider_issue_state SET first_omitted_at=?,last_omitted_at=?')
      .run(now - 40 * 86400000, now - 35 * 86400000);
    await cleanupProviderJobs(f.runtime);
    expect(
      f.sqlite.prepare('SELECT COUNT(*) n FROM payment_provider_issue_state').get(),
    ).toMatchObject({ n: 0 });
    expect(
      (
        await providerRevenueReport(f.db, {
          ...query,
          from: now - 39 * 86400000,
          to: now - 32 * 86400000,
        })
      ).diagnostics_truncated,
    ).toBe(true);
    expect(
      (await providerRevenueReport(f.db, { ...query, from: now - 1000, to: now + 1000 }))
        .diagnostics_truncated,
    ).toBe(false);
  } finally {
    f.sqlite.close();
  }
});
