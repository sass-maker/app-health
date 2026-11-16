import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeSignature } from 'better-auth/crypto';
import { createHash, randomUUID } from 'node:crypto';

export const AUDIT_RUNTIME_SHA = 'a'.repeat(40);

export function auditRuntimeEntry(entryPath) {
  return `import worker from ${JSON.stringify(entryPath)};
export { WorkspacePresence, BrowserArchive } from ${JSON.stringify(entryPath)};
function measuredDatabase(db, counts, native) {
  const statement = (value) => {
    const proxy = new Proxy(value, { get(target,key) {
      const item=Reflect.get(target,key);
      if(key==='bind') return (...args)=>statement(target.bind(...args));
      if(['first','all','run','raw'].includes(key)) return (...args)=>{counts.d1_calls++;counts.d1_statements++;return Reflect.apply(item,target,args);};
      return typeof item==='function'?item.bind(target):item;
    }});
    native.set(proxy,value);return proxy;
  };
  return new Proxy(db,{get(target,key){
    const item=Reflect.get(target,key);
    if(key==='prepare') return (...args)=>statement(target.prepare(...args));
    if(key==='batch') return args=>{counts.d1_calls++;counts.d1_statements+=args.length;return target.batch(args.map(value=>native.get(value)??value));};
    if(key==='withSession') return (...args)=>measuredDatabase(target.withSession(...args),counts,native);
    if(key==='exec') return (...args)=>{counts.d1_calls++;return Reflect.apply(item,target,args);};
    return typeof item==='function'?item.bind(target):item;
  }});
}
export default {...worker,async fetch(request,env,ctx){
  if(new URL(request.url).pathname==='/__native__/archive-stage'){
    const value=await request.json();const stub=env.BROWSER_ARCHIVE.getByName(value.name);
    await stub.stage(value.batches);await stub.flush();return Response.json({staged:true});
  }
  if(!new URL(request.url).pathname.endsWith('/advance'))return worker.fetch(request,env,ctx);
  const counts={d1_calls:0,d1_statements:0,r2_gets:0,batch_lookups:0,day_lookups:0};
  const native=new WeakMap();
  const archive=new Proxy(env.BROWSER_ARCHIVE,{get(target,key){
    const item=Reflect.get(target,key);
    if(key==='getByName')return name=>{const stub=target.getByName(name);return new Proxy(stub,{get(target,key){
      const item=Reflect.get(target,key);
      if(key==='archiveSegmentForBatch'||key==='archiveSegmentsForEventDay')return (...args)=>{counts[key==='archiveSegmentForBatch'?'batch_lookups':'day_lookups']++;return Reflect.apply(item,target,args);};
      return typeof item==='function'?item.bind(target):item;
    }});};
    return typeof item==='function'?item.bind(target):item;
  }});
  const history=new Proxy(env.BROWSER_HISTORY,{get(target,key){const item=Reflect.get(target,key);if(key==='get')return (...args)=>{counts.r2_gets++;return target.get(...args);};return typeof item==='function'?item.bind(target):item;}});
  const response=await worker.fetch(request,{...env,DB:measuredDatabase(env.DB,counts,native),BROWSER_ARCHIVE:archive,BROWSER_HISTORY:history},ctx);
  const headers=new Headers(response.headers);headers.set('x-native-audit-operations',JSON.stringify(counts));
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};`;
}

const dayFor = (timestamp) => new Date(timestamp + 19_800_000).toISOString().slice(0, 10);
const shardFor = (workspace, batch) =>
  `${workspace}:browser-archive-v1:${
    createHash('sha256')
      .update(JSON.stringify([batch.app_id, batch.environment_id, batch.batch_id]))
      .digest()[0] % 16
  }`;

export async function verifyAuditAdvanceRuntime({ runtime, db, secret }) {
  const userId = 'audit-native-owner';
  const time = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)',
    )
    .bind(userId, 'Audit owner', 'audit-owner@example.com', time, time)
    .run();
  const token = randomUUID();
  await db
    .prepare(
      'INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt)VALUES(?,?,?,?,?,?)',
    )
    .bind(
      'audit-native-session',
      token,
      userId,
      new Date(Date.now() + 300_000).toISOString(),
      time,
      time,
    )
    .run();
  const signature = await makeSignature(token, secret);
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  const request = (path, body) =>
    runtime.dispatchFetch(`https://dashboard.example.com${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: globalThis.AbortSignal.timeout(15_000),
      headers: {
        cookie,
        origin: 'https://dashboard.example.com',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  for (const name of ['Audit first scope', 'Audit second scope']) {
    const created = await request('/v1/apps', { name, environment: 'production' });
    assert.equal(created.status, 201, await created.clone().text());
  }
  const account = await (await request('/v1/account')).json();
  const workspace = account.workspace.id;
  const inventory = await (await request('/v1/apps')).json();
  const scopes = inventory.apps.flatMap((row) =>
    row.environments.map((environment) => ({ app_id: row.app.id, environment_id: environment.id })),
  );
  assert(scopes.length >= 2, 'native account fixture must own multiple environment scopes');
  const scope = scopes[0];
  const timestamp = Date.now();
  const day = dayFor(timestamp);
  const origin = 'https://dashboard.example.com';
  const dispatch = (path, options = {}) =>
    runtime.dispatchFetch(origin + path, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', ...options.headers },
      body: options.body ?? '{}',
    });
  const { key } = await (
    await request('/v1/public-keys', { ...scope, allowed_origins: ['https://source.example.com'] })
  ).json();
  for (let index = 0; index < 31; index++) {
    const session = randomUUID(),
      batchId = randomUUID();
    const event = {
      event_id: randomUUID(),
      timestamp: timestamp + index,
      type: 'pageview',
      path: '/native-audit',
      referrer: '',
    };
    const ingest = await runtime.dispatchFetch('https://ingest.example.com/v1/browser', {
      method: 'POST',
      headers: {
        origin: 'https://source.example.com',
        'content-type': 'text/plain',
        'user-agent': 'Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        schema_version: 1,
        batch_id: batchId,
        session_id: session,
        public_key: key,
        events: [event],
      }),
    });
    assert.equal(ingest.status, 202, await ingest.clone().text());
    if (index === 30) continue;
    const receipt = await db
      .prepare(
        'SELECT facts_digest_version,facts_digest,expanded_facts_digest FROM browser_visitor_batch_receipts WHERE workspace_id=? AND app_id=? AND environment_id=? AND batch_id=?',
      )
      .bind(workspace, scope.app_id, scope.environment_id, batchId)
      .first();
    const collected = {
      workspace,
      ...scope,
      batch_id: batchId,
      received_at: timestamp,
      session_hash: createHash('sha256')
        .update(`${scope.app_id}\0${scope.environment_id}\0${session}`)
        .digest('hex'),
      events: [event],
      attribution: {
        source: '',
        medium: '',
        campaign: '',
        content: '',
        term: '',
        entry_path: '/native-audit',
      },
      facts_digest_version: receipt.expanded_facts_digest ? 2 : receipt.facts_digest_version,
      facts_digest: receipt.expanded_facts_digest ?? receipt.facts_digest,
    };
    const staged = await runtime.dispatchFetch(
      'https://dashboard.example.com/__native__/archive-stage',
      {
        method: 'POST',
        body: JSON.stringify({ name: shardFor(workspace, collected), batches: [collected] }),
      },
    );
    assert.equal(staged.status, 200, await staged.clone().text());
  }
  const startedResponse = await request(`/v1/browser/archive-audits?day=${day}`, {});
  assert.equal(startedResponse.status, 202, await startedResponse.clone().text());
  const started = await startedResponse.json();
  assert.equal(started.progress.expected_receipts, 31);
  const path = `/v1/browser/archive-audits/${started.job_id}/advance`;
  for (const headers of [
    { origin: '' },
    { origin: 'null' },
    { origin: 'https://other.example.com' },
    { origin: 'http://dashboard.example.com' },
  ])
    assert.equal((await dispatch(path, { headers })).status, 403);
  for (const body of ['[]', 'null', '{', '{"force":true}', ' '.repeat(65) + '{}'])
    assert.equal((await dispatch(path, { body })).status, 400);
  assert.equal((await dispatch(`${path}?count=3`)).status, 400);
  for (const permission of ['read', 'manage'])
    for (const count of [1, 2]) {
      const minted = await request('/v1/workspace/api-tokens', {
        name: `Audit denial ${permission}${count}`,
        permission,
        scopes: scopes.slice(0, count),
      });
      assert.equal(minted.status, 201, await minted.clone().text());
      const { token } = await minted.json();
      const denied = await dispatch(path, {
        headers: { cookie: '', authorization: `Bearer ${token}` },
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get('x-app-health-build-sha'), null);
    }
  const product = await dispatch(path, {
    headers: { cookie: '', authorization: 'Bearer synthetic-owner' },
  });
  assert.equal(product.status, 403);
  const otherUser = 'audit-native-other-owner';
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)',
    )
    .bind(
      otherUser,
      'Other',
      'audit-other@example.com',
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const otherWorkspace = 'audit-native-other-workspace';
  await db
    .prepare('INSERT INTO workspaces(id,owner_id,name,created_at)VALUES(?,?,?,?)')
    .bind(otherWorkspace, otherUser, 'Other workspace', timestamp)
    .run();
  for (const role of ['viewer', 'editor']) {
    await db
      .prepare(
        'INSERT INTO workspace_members(workspace_id,user_id,role,created_at)VALUES(?,?,?,?) ON CONFLICT(workspace_id,user_id)DO UPDATE SET role=excluded.role',
      )
      .bind(otherWorkspace, userId, role, timestamp)
      .run();
    assert.equal(
      (await dispatch(path, { headers: { 'x-app-health-workspace': otherWorkspace } })).status,
      403,
    );
  }
  await db
    .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND user_id=?")
    .bind(otherWorkspace, userId)
    .run();
  assert.equal(
    (await dispatch(path, { headers: { 'x-app-health-workspace': otherWorkspace } })).status,
    403,
  );
  const otherToken = randomUUID();
  await db
    .prepare(
      'INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt)VALUES(?,?,?,?,?,?)',
    )
    .bind(
      'audit-native-other-session',
      otherToken,
      otherUser,
      new Date(Date.now() + 300_000).toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const otherSignature = await makeSignature(otherToken, secret);
  const otherCookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${otherToken}.${otherSignature}`)}`;
  assert.equal(
    (
      await dispatch(path, {
        headers: { cookie: otherCookie, 'x-app-health-workspace': otherWorkspace },
      })
    ).status,
    404,
  );
  await db
    .prepare('UPDATE browser_archive_audit_jobs SET lease_token=?,lease_until=? WHERE job_id=?')
    .bind('held-native', Date.now() + 300_000, started.job_id)
    .run();
  const busy = await dispatch(path);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).lease_acquired, false);
  await db
    .prepare('UPDATE browser_archive_audit_jobs SET lease_until=0 WHERE job_id=?')
    .bind(started.job_id)
    .run();
  const before = await (await request(`/v1/browser/archive-audits/${started.job_id}`)).json();
  const start = performance.now();
  const advanced = await dispatch(path);
  const wall = performance.now() - start;
  assert.equal(advanced.status, 200, await advanced.clone().text());
  assert.equal(advanced.headers.get('x-app-health-build-sha'), AUDIT_RUNTIME_SHA);
  const operations = JSON.parse(advanced.headers.get('x-native-audit-operations'));
  const state = await advanced.json();
  assert.equal(state.complete, false);
  assert.equal(state.attempted_slices, 1);
  assert.equal(state.lease_acquired, true);
  assert.equal(state.progress.receipts_processed - before.progress.receipts_processed, 30);
  assert.equal(state.phase, 'receipts');
  const readback = await (await request(`/v1/browser/archive-audits/${started.job_id}`)).json();
  assert.deepEqual(
    readback.progress,
    state.progress,
    'readback after an ambiguous POST never repeats work',
  );
  assert.equal(operations.batch_lookups, 30);
  assert(operations.r2_gets <= 30);
  assert(operations.d1_calls < 100);
  await db
    .prepare("UPDATE browser_archive_audit_jobs SET status='finished',phase='done' WHERE job_id=?")
    .bind(started.job_id)
    .run();
  const terminal = await dispatch(path);
  assert.equal(terminal.status, 200);
  assert.equal((await terminal.json()).attempted_slices, 0);
  const report = await request('/v1/analytics');
  assert.equal(report.status, 200, await report.clone().text());
  assert.equal(report.headers.get('x-app-health-build-sha'), AUDIT_RUNTIME_SHA);
  for (const name of ['analytics_summary', 'analytics_presence', 'route_read'])
    assert(report.headers.get('server-timing').includes(`${name};dur=`));
  return {
    mode: 'actual-workerd-owner-http',
    wall_ms: wall,
    operations,
    receipts_processed: state.progress.receipts_processed,
    expected_receipts: state.progress.expected_receipts,
    complete: state.complete,
    readback_without_retry: true,
  };
}
