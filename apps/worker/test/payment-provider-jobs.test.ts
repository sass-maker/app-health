import { describe, expect, it } from 'vitest';
import {
  drainProviderJob,
  startProviderImport,
  cancelProviderJob,
  resumeProviderJob,
} from '../src/payment-provider-jobs.js';
import { connectionRow, jobRow } from '../src/payment-provider-store.js';
import { saveRouting } from '../src/payment-provider-routing.js';
import {
  disconnectProvider,
  replaceProviderCredentials,
  verifyConnection,
} from '../src/payment-provider-connections.js';
import { processProviderResource } from '../src/payment-provider-process.js';
import { providerSession } from '../src/payment-provider-api.js';
import { providerPage, nextImportPage } from '../src/payment-provider-pages.js';
import { providerFixture } from './payment-provider-fixture.js';

async function finish(f: ReturnType<typeof providerFixture>, id: string) {
  for (let count = 0; count < 30; count++) {
    const job = await jobRow(f.db, id);
    if (['finished', 'paused', 'cancelled'].includes(job.status)) return job;
    await drainProviderJob(f.runtime, id);
  }
  throw new Error('bounded fixture did not finish');
}
describe.each(['stripe', 'polar', 'dodo'] as const)('%s imports', (provider) => {
  it('persists bounded page offsets, safely repeats a committed fact after a lost cursor write, reconciles once', async () => {
    const f = providerFixture(provider);
    try {
      const c = await f.connect();
      for (let index = 2; index <= 27; index++)
        f.payments.push({
          ...f.payment,
          ...(provider === 'dodo'
            ? { payment_id: `pay_${index}` }
            : { id: provider === 'stripe' ? `ch_${index}` : `ord_${index}` }),
        });
      const job = await startProviderImport(f.runtime, c, { from: f.time - 1, to: Date.now() });
      await drainProviderJob(f.runtime, job.id);
      const partial = await jobRow(f.db, job.id);
      expect(partial.status).toBe('queued');
      expect(partial.processed).toBeGreaterThan(0);
      expect(partial.processed).toBeLessThan(25);
      const cursor = JSON.parse(partial.cursor);
      cursor.offset = 0;
      f.sqlite
        .prepare('UPDATE payment_provider_jobs SET cursor=? WHERE id=?')
        .run(JSON.stringify(cursor), job.id);
      expect((await finish(f, job.id)).status).toBe('finished');
      expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
        n: 28,
      });
      const again = await startProviderImport(
        f.runtime,
        c,
        { from: f.time - 1, to: Date.now() },
        'reconcile',
      );
      expect((await finish(f, again.id)).recorded).toBe(0);
      expect(
        f.calls.every(
          (url) =>
            Number(url.searchParams.get('limit') ?? url.searchParams.get('page_size') ?? '1') <= 25,
        ),
      ).toBe(true);
    } finally {
      f.sqlite.close();
    }
  });
});
it('backs off a provider 429 without advancing and fences stale generation, routing and disconnect mutations', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect();
    await saveRouting(f.db, c, {
      routing: 'products',
      rules: [{ product_id: 'prod_1', app_id: 'app', environment_id: 'env' }],
    });
    const job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    f.controls.failure = 429;
    await drainProviderJob(f.runtime, job.id);
    let state = await jobRow(f.db, job.id);
    expect(state).toMatchObject({
      status: 'queued',
      processed: 0,
      cursor: '{}',
      reason: 'provider_rate_limited',
    });
    expect(state.retry_at).toBeGreaterThan(Date.now());
    f.controls.failure = 0;
    const replaced = await replaceProviderCredentials(f.runtime, c, f.credentials);
    expect(replaced.generation).toBe(2);
    const current = await connectionRow(f.db, c.id);
    const currentJob = await startProviderImport(f.runtime, current, { from: 0, to: Date.now() });
    await expect(saveRouting(f.db, c, { routing: 'exclusive', rules: [] })).rejects.toThrow(
      'changed',
    );
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_routing_rules').get()).toMatchObject(
      { n: 1 },
    );
    await expect(disconnectProvider(f.runtime, c)).rejects.toThrow('changed');
    expect(await connectionRow(f.db, c.id)).toMatchObject({ status: 'active', generation: 2 });
    expect(await jobRow(f.db, currentJob.id)).toMatchObject({ status: 'queued' });
    await disconnectProvider(f.runtime, current);
    await drainProviderJob(f.runtime, currentJob.id);
    expect(await jobRow(f.db, currentJob.id)).toMatchObject({ status: 'cancelled' });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
      n: 0,
    });
    expect((await connectionRow(f.db, c.id)).cipher).toBeNull();
    state = await jobRow(f.db, job.id);
    expect(state.status).toBe('cancelled');
  } finally {
    f.sqlite.close();
  }
});
it('does not claim verification after losing its generation update', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect();
    f.controls.before = () => {
      f.sqlite
        .prepare('UPDATE payment_connections SET generation=generation+1 WHERE id=?')
        .run(c.id);
    };
    await expect(verifyConnection(f.runtime, c)).rejects.toThrow('changed');
  } finally {
    f.sqlite.close();
  }
});
it('routes a whole cart once, leaves mixed/unmapped carts unresolved, and refunds follow immutable original assignment', async () => {
  const f = providerFixture();
  try {
    let c = await f.connect();
    await saveRouting(f.db, c, {
      routing: 'products',
      rules: [
        { product_id: 'prod_1', app_id: 'other-app', environment_id: 'other-env' },
        { product_id: 'prod_2', app_id: 'app', environment_id: 'env' },
      ],
    });
    c = await connectionRow(f.db, c.id);
    f.controls.products = ['prod_1', 'prod_2'];
    let session = providerSession(c, f.credentials, f.runtime.fetcher);
    expect(await processProviderResource(f.db, session, 'payment', 'ch_1')).toMatchObject({
      unresolved: 1,
    });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
      n: 0,
    });
    f.controls.products = ['unmapped'];
    session.requests = 0;
    expect(await processProviderResource(f.db, session, 'payment', 'ch_1')).toMatchObject({
      unresolved: 1,
    });
    f.controls.products = ['prod_1'];
    session.requests = 0;
    expect(await processProviderResource(f.db, session, 'payment', 'ch_1')).toMatchObject({
      recorded: 1,
    });
    await saveRouting(f.db, c, { routing: 'exclusive', rules: [] });
    c = await connectionRow(f.db, c.id);
    session = providerSession(c, f.credentials, f.runtime.fetcher);
    await processProviderResource(f.db, session, 'refund', 're_1');
    expect(f.sqlite.prepare('SELECT app_id,environment_id FROM payment_facts').all()).toEqual([
      expect.objectContaining({ app_id: 'other-app', environment_id: 'other-env' }),
      expect.objectContaining({ app_id: 'other-app', environment_id: 'other-env' }),
    ]);
    expect(() => f.sqlite.exec("UPDATE payment_assignments SET app_id='app'")).toThrow('immutable');
  } finally {
    f.sqlite.close();
  }
});
it('skips unrelated Dodo refund brands, filters canonical creation dates and splits dense windows', async () => {
  const f = providerFixture('dodo');
  try {
    const c = await f.connect();
    f.refund.brand_id = 'unrelated';
    const job = await startProviderImport(f.runtime, c, { from: f.time - 1, to: Date.now() });
    const result = await finish(f, job.id);
    expect(result.status).toBe('finished');
    expect(result.filtered).toBe(1);
    const session = providerSession(c, f.credentials, f.runtime.fetcher);
    expect(
      await processProviderResource(f.db, session, 'payment', 'pay_1', {
        from: f.time + 1,
        to: Date.now(),
      }),
    ).toMatchObject({ filtered: 1 });
    const row = await jobRow(f.db, job.id);
    row.phase = 'payments';
    row.from_time = 1000;
    row.to_time = 100000;
    const page = await providerPage(session, row, {
      page: 100,
      windowFrom: 1000,
      windowTo: 100000,
    });
    expect(page.windowTo).toBe(50500);
    expect(page.pendingWindows).toEqual([[50500, 100000]]);
    expect(nextImportPage('dodo', row, { ...page, more: false })).toMatchObject({
      windowFrom: 50500,
      windowTo: 100000,
      page: 0,
    });
    await expect(
      providerPage(session, row, { page: 100, windowFrom: 1000, windowTo: 1500 }),
    ).rejects.toThrow('indivisible');
  } finally {
    f.sqlite.close();
  }
});
it('allows cancelling a capped or paused job and starting a narrower replacement', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    f.sqlite.prepare('UPDATE payment_provider_jobs SET processed=100000 WHERE id=?').run(job.id);
    await drainProviderJob(f.runtime, job.id);
    const paused = await jobRow(f.db, job.id);
    expect(paused.status).toBe('paused');
    await resumeProviderJob(f.runtime, paused);
    await cancelProviderJob(f.runtime, await jobRow(f.db, job.id));
    expect(
      (await startProviderImport(f.runtime, c, { from: f.time - 1, to: Date.now() })).status,
    ).toBe('queued');
  } finally {
    f.sqlite.close();
  }
});
it('fences an in-flight provider fetch after disconnect before any financial commit', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect(),
      job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    f.controls.before = (url) => {
      if (url.pathname.endsWith('/ch_1'))
        f.sqlite
          .prepare(
            "UPDATE payment_connections SET status='disconnected',generation=generation+1,cipher=NULL WHERE id=?",
          )
          .run(c.id);
    };
    await drainProviderJob(f.runtime, job.id);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
      n: 0,
    });
  } finally {
    f.sqlite.close();
  }
});
it('cancellation during fetch cannot freeze an old routing assignment or update provider provenance', async () => {
  const f = providerFixture();
  try {
    let c = await f.connect();
    const job = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    f.controls.before = (url) => {
      if (url.pathname.endsWith('/ch_1'))
        f.sqlite
          .prepare(
            "UPDATE payment_provider_jobs SET status='cancelled',lease_token=NULL,lease_until=0 WHERE id=?",
          )
          .run(job.id);
    };
    await drainProviderJob(f.runtime, job.id);
    for (const table of ['payment_assignments', 'payment_facts', 'payment_provider_objects'])
      expect(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 });
    f.controls.before = undefined;
    await saveRouting(f.db, c, {
      routing: 'products',
      rules: [{ product_id: 'prod_1', app_id: 'other-app', environment_id: 'other-env' }],
    });
    c = await connectionRow(f.db, c.id);
    const replacement = await startProviderImport(f.runtime, c, { from: 0, to: Date.now() });
    expect((await finish(f, replacement.id)).status).toBe('finished');
    expect(f.sqlite.prepare('SELECT app_id FROM payment_assignments').get()).toMatchObject({
      app_id: 'other-app',
    });
  } finally {
    f.sqlite.close();
  }
});
it('acquires only one running webhook lease per connection under a burst and honors the workspace cap', async () => {
  const f = providerFixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const c = await f.connect();
    const now = Date.now();
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    for (const id of ids)
      f.sqlite
        .prepare(
          "INSERT INTO payment_provider_jobs(id,connection_id,generation,kind,status,phase,from_time,to_time,resource_kind,resource_id,created_at,updated_at) VALUES(?, ?,1,'webhook','queued','resource',0,0,'payment','ch_1',?,?)",
        )
        .run(id, c.id, now, now);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = f.runtime.fetcher;
    const runtime = {
      ...f.runtime,
      fetcher: async (...args: Parameters<typeof fetch>) => {
        entered();
        await blocked;
        return fetcher(...args);
      },
    };
    const pending = ids.map((id) => drainProviderJob(runtime, id));
    await started;
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS n FROM payment_provider_jobs WHERE status='running'")
        .get(),
    ).toMatchObject({ n: 1 });
    release();
    await Promise.all(pending);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
      n: 1,
    });
    // Different connections still share the bounded workspace budget.
    const columns = f.sqlite
      .prepare('PRAGMA table_info(payment_connections)')
      .all()
      .map((row) => String(row.name));
    const existing = f.sqlite.prepare('SELECT * FROM payment_connections WHERE id=?').get(c.id)!;
    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID();
      f.sqlite
        .prepare(
          `INSERT INTO payment_connections(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(
          ...columns.map((key) =>
            key === 'id' ? id : key === 'account_id' ? `busy-${i}` : existing[key],
          ),
        );
      f.sqlite
        .prepare(
          "INSERT INTO payment_provider_jobs(id,connection_id,generation,kind,status,phase,from_time,to_time,lease_token,lease_until,created_at,updated_at) VALUES(?,?,1,'webhook','running','resource',0,0,'busy',?,?,?)",
        )
        .run(crypto.randomUUID(), id, now + 60000, now, now);
    }
    const remaining = ids[1];
    const before = f.calls.length;
    await drainProviderJob(f.runtime, remaining);
    expect(f.calls).toHaveLength(before);
    expect((await jobRow(f.db, remaining)).status).toBe('queued');
  } finally {
    release?.();
    f.sqlite.close();
  }
});
it('does not assign a cart using rules replaced between target lookup and the atomic assignment', async () => {
  const f = providerFixture();
  try {
    let c = await f.connect();
    await saveRouting(f.db, c, {
      routing: 'products',
      rules: [{ product_id: 'prod_1', app_id: 'app', environment_id: 'env' }],
    });
    c = await connectionRow(f.db, c.id);
    const db = {
      ...f.db,
      prepare(sql: string) {
        if (sql.includes('INSERT OR IGNORE INTO payment_assignments'))
          f.sqlite
            .prepare(
              "UPDATE payment_routing_rules SET app_id='other-app',environment_id='other-env'",
            )
            .run();
        return f.db.prepare(sql);
      },
    };
    expect(
      await processProviderResource(
        db,
        providerSession(c, f.credentials, f.runtime.fetcher),
        'payment',
        'ch_1',
      ),
    ).toMatchObject({ unresolved: 1 });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_assignments').get()).toMatchObject({
      n: 0,
    });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
      n: 0,
    });
    expect(
      await processProviderResource(
        f.db,
        providerSession(c, f.credentials, f.runtime.fetcher),
        'payment',
        'ch_1',
      ),
    ).toMatchObject({ recorded: 1 });
    expect(f.sqlite.prepare('SELECT app_id FROM payment_assignments').get()).toMatchObject({
      app_id: 'other-app',
    });
  } finally {
    f.sqlite.close();
  }
});
