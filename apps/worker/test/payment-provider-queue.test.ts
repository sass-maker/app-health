import { afterEach, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import entry from '../src/analytics-entry.js';
import {
  startProviderImport,
  drainProviderJob,
  cancelProviderJob,
} from '../src/payment-provider-jobs.js';
import { jobRow, connectionRow } from '../src/payment-provider-store.js';
import { isProviderWake, pumpProviderJobs, wakeProviderJob } from '../src/payment-provider-wake.js';
import {
  replaceProviderCredentials,
  disconnectProvider,
} from '../src/payment-provider-connections.js';
import {
  openProviderCredentials,
  sealProviderCredentials,
} from '../src/payment-provider-crypto.js';
import { processProviderResource } from '../src/payment-provider-process.js';
import { providerSession } from '../src/payment-provider-api.js';
import { providerRevenueReport } from '../src/payment-provider-report.js';
import { providerFixture, MASTER } from './payment-provider-fixture.js';
import type { ProviderJobWake } from '../src/payment-provider-model.js';
import type { Env } from '../src/index.js';
afterEach(() => vi.unstubAllGlobals());

function queueFixture(f: ReturnType<typeof providerFixture>) {
  const pending: ProviderJobWake[] = [],
    delays: number[] = [];
  const send = vi.fn(async (wake: ProviderJobWake, options?: { delaySeconds: number }) => {
    pending.push(wake);
    delays.push(options?.delaySeconds ?? 0);
  });
  const queue = { send };
  const runtime = { ...f.runtime, queue };
  const env = { DB: f.db, PAYMENT_ENCRYPTION_KEYRING: MASTER, BROWSER_EVENTS: queue } as Env;
  vi.stubGlobal('fetch', f.runtime.fetcher);
  return { pending, delays, send, runtime, env };
}
async function deliver(wake: ProviderJobWake, env: Env) {
  const ack = vi.fn(),
    retry = vi.fn();
  await entry.queue(
    { messages: [{ body: wake, ack, retry }] } as unknown as MessageBatch<ProviderJobWake>,
    env,
  );
  return { ack, retry };
}
it('finishes200resources unattended through actual queue entry dispatch using fresh continuations beyond retry budgets', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      q = queueFixture(f);
    for (let i = 2; i <= 200; i++) f.payments.push({ ...f.payment, id: 'ch_' + i });
    const job = await startProviderImport(q.runtime, c, { from: 0, to: Date.now() });
    await wakeProviderJob(q.runtime, await jobRow(f.db, job.id));
    let delivered = 0;
    while (q.pending.length && delivered < 100) {
      const result = await deliver(q.pending.shift()!, q.env);
      expect(result.ack).toHaveBeenCalledOnce();
      expect(result.retry).not.toHaveBeenCalled();
      delivered++;
    }
    expect(delivered).toBeGreaterThan(3);
    expect(delivered).toBeLessThan(100);
    expect(await jobRow(f.db, job.id)).toMatchObject({
      status: 'finished',
      reason: null,
      retry_at: 0,
    });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
      n: 201,
    });
  } finally {
    f.sqlite.close();
  }
});
it('retains queued work when publication fails, recovers via cron outbox and delays429without advancing', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      q = queueFixture(f),
      job = await startProviderImport(q.runtime, c, { from: 0, to: Date.now() });
    q.send.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(wakeProviderJob(q.runtime, await jobRow(f.db, job.id))).rejects.toThrow(
      'queue unavailable',
    );
    await pumpProviderJobs(q.runtime);
    expect(q.pending).toHaveLength(1);
    f.controls.failure = 429;
    const wake = q.pending.shift()!,
      result = await deliver(wake, q.env);
    expect(result.ack).toHaveBeenCalledOnce();
    expect(result.retry).not.toHaveBeenCalled();
    expect(await jobRow(f.db, job.id)).toMatchObject({
      status: 'queued',
      processed: 0,
      cursor: '{}',
      reason: 'provider_rate_limited',
    });
    expect(q.delays.at(-1)).toBeGreaterThanOrEqual(1);
    q.send.mockRejectedValueOnce(new Error('successor unavailable'));
    const failed = await deliver(q.pending.shift()!, q.env);
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(failed.ack).not.toHaveBeenCalled();
    await cancelProviderJob(q.runtime, await jobRow(f.db, job.id));
    const calls = f.calls.length;
    expect((await deliver(wake, q.env)).ack).toHaveBeenCalledOnce();
    expect(f.calls).toHaveLength(calls);
    expect(isProviderWake({ ...wake, unexpected: 'data' })).toBe(false);
  } finally {
    f.sqlite.close();
  }
});
it('rotates independent encryption keys while retaining old decryption keys and rejects missing or tampered key IDs', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect();
    const old = JSON.parse(MASTER),
      ring = JSON.stringify({
        v: 1,
        active: 'next',
        keys: [...old.keys, { id: 'next', key: btoa('b'.repeat(32)) }],
      });
    expect(await openProviderCredentials(ring, c, c.cipher)).toEqual(f.credentials);
    const cipher = await sealProviderCredentials(ring, c, f.credentials);
    expect(JSON.parse(cipher).key_id).toBe('next');
    await expect(openProviderCredentials(MASTER, c, cipher)).rejects.toThrow('unavailable');
    await expect(
      openProviderCredentials(ring, c, cipher.replace('"next"', '"test-key"')),
    ).rejects.toThrow('unavailable');
    await expect(
      sealProviderCredentials('owner-token-must-never-be-used-as-encryption', c, f.credentials),
    ).rejects.toThrow('keyring');
    // Reporting has no dependency on encryption keys.
    expect(
      (
        await providerRevenueReport(f.db, {
          app_id: 'app',
          environment_id: 'env',
          from: 0,
          to: Date.now(),
          breakdown: 'source',
        })
      ).totals,
    ).toEqual([]);
  } finally {
    f.sqlite.close();
  }
});
it('recovers acknowledged unfinished webhooks after replace/reconnect and preserves owner cancellation against stale replacement', async () => {
  const f = providerFixture();
  try {
    let c = await f.connect();
    const q = queueFixture(f),
      ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids)
      f.sqlite
        .prepare(
          `INSERT INTO payment_provider_jobs(id,connection_id,generation,kind,status,phase,from_time,to_time,resource_kind,resource_id,delivery_id,body_digest,created_at,updated_at) VALUES(?,?,1,'webhook','queued','resource',0,0,'payment','ch_1',?,'digest',1,1)`,
        )
        .run(id, c.id, id);
    await cancelProviderJob(q.runtime, await jobRow(f.db, ids[1]));
    await replaceProviderCredentials(q.runtime, c, f.credentials);
    expect(await jobRow(f.db, ids[0])).toMatchObject({
      generation: 2,
      status: 'queued',
      lease_token: null,
      retry_at: 0,
      reason: null,
    });
    expect(await jobRow(f.db, ids[1])).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled_by_owner',
    });
    await expect(replaceProviderCredentials(q.runtime, c, f.credentials)).rejects.toThrow(
      'changed',
    );
    expect(await jobRow(f.db, ids[0])).toMatchObject({ generation: 2, status: 'queued' });
    c = await connectionRow(f.db, c.id);
    await disconnectProvider(q.runtime, c);
    c = await connectionRow(f.db, c.id);
    expect(await jobRow(f.db, ids[0])).toMatchObject({
      status: 'cancelled',
      reason: 'connection_disconnected',
    });
    await replaceProviderCredentials(q.runtime, c, f.credentials);
    const recovered = await jobRow(f.db, ids[0]);
    expect(recovered).toMatchObject({ generation: 4, status: 'queued' });
    const stale = await deliver(
      { type: 'payment-provider-job', schema_version: 1, job_id: ids[0], generation: 2 },
      q.env,
    );
    expect(stale.ack).toHaveBeenCalledOnce();
    await drainProviderJob(q.runtime, ids[0]);
    expect(await jobRow(f.db, ids[0])).toMatchObject({ status: 'finished', recorded: 1 });
  } finally {
    f.sqlite.close();
  }
});
it('advances past permanent malformed resources without fabricating financial dates and retries product/original hydration429', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect();
    f.refund.charge = null;
    const job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    for (let i = 0; i < 10; i++) {
      await drainProviderJob(f.runtime, job.id);
      if ((await jobRow(f.db, job.id)).status === 'finished') break;
    }
    expect(await jobRow(f.db, job.id)).toMatchObject({ status: 'finished', unresolved: 1 });
    const issue = f.sqlite.prepare('SELECT * FROM payment_provider_issues').get()!;
    expect(issue).toMatchObject({ resource_id: 're_1', kind: 'refund' });
    expect(issue).not.toHaveProperty('transaction_id');
    expect(issue).not.toHaveProperty('resource_created_at');
    f.refund.charge = 'ch_1';
    const session = providerSession(c, f.credentials, f.runtime.fetcher);
    await processProviderResource(f.db, session, 'refund', 're_1');
    expect(
      f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_provider_issues').get(),
    ).toMatchObject({ n: 0 });
    f.controls.before = (url) => {
      if (url.pathname.endsWith('/ch_1')) f.controls.failure = 429;
    };
    session.requests = 0;
    await expect(processProviderResource(f.db, session, 'refund', 're_1')).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryAt: expect.any(Number),
    });
  } finally {
    f.sqlite.close();
  }
});

it('prefilters newest-first Polar refund history at exclusive bounds before individual fetch and exposes ordering violations', async () => {
  const f = providerFixture('polar');
  try {
    const c = await f.connect();
    const before = f.time - 10000,
      after = f.time + 10000;
    for (let i = 0; i < 30; i++)
      f.refunds.push({
        ...f.refund,
        id: 'new_' + i,
        created_at: new Date(after + 1000 + i).toISOString(),
      });
    f.refunds.push({ ...f.refund, id: 'old', created_at: new Date(before - 1).toISOString() });
    const job = await startProviderImport(f.runtime, c, { from: before, to: after });
    for (let i = 0; i < 20; i++) {
      await drainProviderJob(f.runtime, job.id);
      if ((await jobRow(f.db, job.id)).status === 'finished') break;
    }
    expect(await jobRow(f.db, job.id)).toMatchObject({
      status: 'finished',
      processed: 2,
      recorded: 2,
    });
    const refundCalls = f.calls.filter((url) => url.pathname.endsWith('/refunds/'));
    expect(
      refundCalls
        .filter((url) => url.searchParams.has('id'))
        .map((url) => url.searchParams.get('id')),
    ).toEqual(['ref_1']);
    expect(
      refundCalls
        .filter((url) => !url.searchParams.has('id'))
        .every((url) => url.searchParams.get('sorting') === '-created_at'),
    ).toBe(true);
    expect(f.calls.some((url) => url.searchParams.get('id')?.startsWith('new_'))).toBe(false);
  } finally {
    f.sqlite.close();
  }
});

it('does not consume hydration429as a permanent resource issue or advance a product-routing cursor', async () => {
  const f = providerFixture();
  try {
    let c = await f.connect();
    const { saveRouting } = await import('../src/payment-provider-routing.js');
    await saveRouting(f.db, c, {
      routing: 'products',
      rules: [{ product_id: 'prod_1', app_id: 'app', environment_id: 'env' }],
    });
    c = await connectionRow(f.db, c.id);
    const job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    f.controls.before = (url) => {
      if (url.pathname.includes('/line_items')) f.controls.failure = 429;
    };
    await drainProviderJob(f.runtime, job.id);
    const state = await jobRow(f.db, job.id);
    expect(state).toMatchObject({
      status: 'queued',
      processed: 0,
      reason: 'provider_rate_limited',
    });
    expect(JSON.parse(state.cursor).offset).toBe(0);
    expect(
      f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_provider_objects').get(),
    ).toMatchObject({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_provider_issues').get(),
    ).toMatchObject({ n: 0 });
  } finally {
    f.sqlite.close();
  }
});
it('strictly partitions mixed browser and malformed provider wakes before browser sharding', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      q = queueFixture(f),
      order: string[] = [];
    const stage = vi.fn(async () => {
      order.push('browser');
      return { accepted: 1, duplicates: 0 };
    });
    const job = await startProviderImport(q.runtime, c, { from: 0, to: Date.now() });
    await wakeProviderJob(q.runtime, await jobRow(f.db, job.id));
    f.controls.before = () => {
      order.push('provider');
    };
    const browser = {
      workspace: 'ws',
      app_id: 'app',
      environment_id: 'env',
      batch_id: crypto.randomUUID(),
      received_at: Date.now(),
      events: [],
    };
    const ackBrowser = vi.fn(),
      ackInvalid = vi.fn(),
      retry = vi.fn();
    await entry.queue(
      {
        messages: [
          { body: q.pending.shift()!, ack: vi.fn(), retry },
          { body: browser, ack: ackBrowser, retry },
          {
            body: { type: 'payment-provider-job', schema_version: 1, job_id: 'bad', generation: 1 },
            ack: ackInvalid,
            retry,
          },
        ],
      } as unknown as MessageBatch<ProviderJobWake>,
      { ...q.env, BROWSER_ARCHIVE: { getByName: () => ({ stage }) } } as unknown as Env,
    );
    expect(order[0]).toBe('browser');
    expect(order).toContain('provider');
    expect(stage).toHaveBeenCalledWith([browser]);
    expect(ackBrowser).toHaveBeenCalledOnce();
    expect(ackInvalid).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  } finally {
    f.sqlite.close();
  }
});

it('surfaces non-monotonic Polar history and bounded scanning explicitly', async () => {
  const f = providerFixture('polar');
  try {
    const c = await f.connect(),
      job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    const { providerPage } = await import('../src/payment-provider-pages.js');
    const row = { ...(await jobRow(f.db, job.id)), phase: 'refunds' as const };
    const session = providerSession(c, f.credentials, async () =>
      Response.json({
        items: [
          { id: 'one', created_at: new Date(f.time).toISOString() },
          { id: 'two', created_at: new Date(f.time + 1000).toISOString() },
        ],
      }),
    );
    await expect(providerPage(session, row, {})).rejects.toThrow('ordering_unverified');
    await expect(providerPage(session, row, { scannedPages: 4000 })).rejects.toThrow(
      'history_scan_limit',
    );
  } finally {
    f.sqlite.close();
  }
});
