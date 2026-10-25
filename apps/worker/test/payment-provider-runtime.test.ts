import { splitMigrationSql } from './migration-sql.js';
import { URL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { createProviderConnection } from '../src/payment-provider-connections.js';
import { connectionRow } from '../src/payment-provider-store.js';
import { providerSession } from '../src/payment-provider-api.js';
import { processProviderResource } from '../src/payment-provider-process.js';
import { D1PaymentLedger } from '../src/payments-store.js';
import { providerFixture, MASTER } from './payment-provider-fixture.js';
import type { D1DatabaseLike } from '../src/d1-adapter.js';

let mf: Miniflare;
let db: D1DatabaseLike;
beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  });
  db = await mf.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    for (const statement of splitMigrationSql(sql)) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO apps(id,name,created_at) VALUES ('app','Product',1)").run();
  await db
    .prepare(
      "INSERT INTO environments(id,app_id,name,created_at) VALUES ('env','app','production',1)",
    )
    .run();
}, 30000);
afterEach(async () => mf.dispose());
it('serializes concurrent partial refunds through real workerd D1 triggers without double counting', async () => {
  const f = providerFixture();
  try {
    const runtime = { db, keyring: MASTER, fetcher: f.runtime.fetcher };
    const created = await createProviderConnection(runtime, 'legacy', f.input),
      c = await connectionRow(db, created.id);
    await processProviderResource(
      db,
      providerSession(c, f.credentials, f.runtime.fetcher),
      'payment',
      'ch_1',
    );
    f.refund.amount = 600;
    f.refunds.push({ ...f.refund, id: 're_2', amount: 600 });
    const results = await Promise.all(
      ['re_1', 're_2'].map((id) =>
        processProviderResource(
          db,
          providerSession(c, f.credentials, f.runtime.fetcher),
          'refund',
          id,
        ),
      ),
    );
    expect(results.reduce((total, result) => total + result.recorded, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.unresolved, 0)).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n,SUM(amount_minor) AS total FROM payment_facts WHERE kind='refund'",
        )
        .first(),
    ).toMatchObject({ n: 1, total: 600 });
  } finally {
    f.sqlite.close();
  }
});
it('guards the same financial transaction with the winning routing assignment, live generation and current job lease', async () => {
  const f = providerFixture();
  const created = await createProviderConnection(
    { db, keyring: MASTER, fetcher: f.runtime.fetcher },
    'legacy',
    f.input,
  );
  const c = await connectionRow(db, created.id);
  f.sqlite.close();
  await db
    .prepare("INSERT INTO payment_assignments VALUES (?,'ch_fenced','app','env',1)")
    .bind(c!.id)
    .run();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO payment_provider_jobs(id,connection_id,generation,kind,status,phase,from_time,to_time,lease_token,lease_until,created_at,updated_at) VALUES (?, ?,1,'import','running','payments',0,1,'winner',?,1,1)`,
    )
    .bind(id, c!.id, Date.now() + 60000)
    .run();
  const input = {
    schema_version: 1 as const,
    app_id: 'app',
    environment_id: 'env',
    namespace: { provider: 'stripe' as const, account_id: 'acct_test', mode: 'test' as const },
    delivery_id: 'fenced',
    fact: {
      kind: 'payment' as const,
      transaction_id: 'ch_fenced',
      occurred_at: 1,
      amount_minor: 10,
      currency: 'USD',
      attribution: {},
    },
  };
  const ledger = new D1PaymentLedger(db);
  await expect(
    ledger.record(input, { connectionId: c!.id, generation: 1, jobId: id, leaseToken: 'loser' }),
  ).rejects.toThrow('fence');
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM payment_deliveries WHERE delivery_id='fenced'")
      .first(),
  ).toMatchObject({ n: 0 });
  expect(
    await ledger.record(input, {
      connectionId: c!.id,
      generation: 1,
      jobId: id,
      leaseToken: 'winner',
    }),
  ).toBe(true);
  await db.prepare("UPDATE payment_provider_jobs SET status='cancelled' WHERE id=?").bind(id).run();
  await expect(
    ledger.record(
      { ...input, delivery_id: 'cancelled' },
      { connectionId: c!.id, generation: 1, jobId: id, leaseToken: 'winner' },
    ),
  ).rejects.toThrow('fence');
  await db.prepare('UPDATE payment_connections SET generation=2 WHERE id=?').bind(c!.id).run();
  await expect(
    ledger.record(
      { ...input, delivery_id: 'old-generation' },
      { connectionId: c!.id, generation: 1 },
    ),
  ).rejects.toThrow('fence');
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM payment_deliveries WHERE delivery_id IN ('cancelled','old-generation')",
      )
      .first(),
  ).toMatchObject({ n: 0 });
});
