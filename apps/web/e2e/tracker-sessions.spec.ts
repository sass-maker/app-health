import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { BrowserBatchV1 } from '@app-health/contracts';

type Project = { app: { id: string }; environment: { id: string }; key: string; origin: string };
let server: Server;
test.afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function fixture(
  request: APIRequestContext,
  baseURL: string,
  attributes = '',
  publicOrigin?: string,
) {
  let key = '';
  server = createServer((req, res) => {
    if (req.url === '/tracker-legacy.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(readFileSync(new URL('./fixtures/tracker-d3be57c.txt', import.meta.url)));
      return;
    }
    const tracker = req.url?.includes('version=legacy')
      ? '/tracker-legacy.js'
      : `${baseURL}/tracker.js`;
    if (req.url === '/fixture/redirect') {
      res.writeHead(302, { location: '/fixture/landing' }).end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><title>Tracker fixture</title><a href="/fixture/next">Next</a>${req.url?.startsWith('/fixture/') ? `<script src="${tracker}" data-key="${key}" data-endpoint="${baseURL}/v1/browser" ${attributes}></script>` : ''}`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = publicOrigin ?? `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const project = await (
    await request.post('/v1/apps', {
      data: { name: 'Tracker session browser test', environment: 'local' },
    })
  ).json();
  ({ key } = await (
    await request.post('/v1/public-keys', {
      data: {
        app_id: project.app.id,
        environment_id: project.environment.id,
        allowed_origins: [origin],
      },
    })
  ).json());
  return { ...project, key, origin } as Project;
}

function receipts(page: Page) {
  const batches: BrowserBatchV1[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/v1/browser') && request.method() === 'POST')
      batches.push(BrowserBatchV1.parse(JSON.parse(request.postData()!)));
  });
  return batches;
}
async function flush(page: Page) {
  await page.waitForFunction(() => !!window.appHealth);
  await page.evaluate(() => window.appHealth!.flush());
}
async function report(request: APIRequestContext, project: Project) {
  return (
    await request.get(
      `/v1/analytics/report?app_id=${project.app.id}&environment_id=${project.environment.id}&range=24h&breakdown=acquisition`,
    )
  ).json();
}

async function controlledSource(
  page: Page,
  request: APIRequestContext,
  project: Project,
  host: string,
  policy: string,
  redirect: boolean,
) {
  // Fetch interception covers every redirect hop without TLS exceptions or social traffic.
  // Playwright routing only intercepts the initial request in a redirect chain.
  const cdp = await page.context().newCDPSession(page);
  const failures: string[] = [];
  const unexpected: string[] = [];
  const remoteResponses: string[] = [];
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', ({ response }) => {
    if (response.remoteIPAddress) remoteResponses.push(response.url);
  });
  async function fulfill(
    requestId: string,
    status: number,
    contentType: string,
    body = '',
    headers: { name: string; value: string }[] = [],
  ) {
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: [{ name: 'content-type', value: contentType }, ...headers],
      body: Buffer.from(body).toString('base64'),
    });
  }
  cdp.on('Fetch.requestPaused', async ({ requestId, networkId, request: incoming }) => {
    try {
      const url = new URL(incoming.url);
      if (url.origin === `https://${host}` && url.pathname === '/__app_health_fixture')
        return await fulfill(
          requestId,
          200,
          'text/html',
          `<!doctype html><a referrerpolicy="${policy}" href="${project.origin}/fixture/${redirect ? 'redirect' : 'landing'}">Visit product</a>`,
        );
      if (url.origin === project.origin) {
        if (url.pathname === '/tracker.js') {
          const response = await request.get('/tracker.js');
          return await fulfill(
            requestId,
            response.status(),
            'text/javascript',
            await response.text(),
          );
        }
        if (url.pathname === '/v1/browser' && incoming.method === 'POST') {
          const data =
            incoming.postData ??
            (networkId &&
              (await cdp.send('Network.getRequestPostData', { requestId: networkId })).postData);
          if (!data) throw new Error('Missing local collector batch');
          const response = await request.post('/v1/browser', {
            headers: { origin: project.origin, 'content-type': 'text/plain' },
            data,
          });
          return await fulfill(
            requestId,
            response.status(),
            'application/json',
            await response.text(),
          );
        }
        if (url.pathname === '/fixture/redirect')
          return await fulfill(requestId, 302, 'text/html', '', [
            { name: 'location', value: '/fixture/landing' },
          ]);
        if (url.pathname.startsWith('/fixture/'))
          return await fulfill(
            requestId,
            200,
            'text/html',
            `<!doctype html><title>Tracker fixture</title><a href="/fixture/next">Next</a><script src="/tracker.js" data-key="${project.key}" data-endpoint="${project.origin}/v1/browser"></script>`,
          );
      }
      if (
        [project.origin, `https://${host}`].includes(url.origin) &&
        url.pathname === '/favicon.ico'
      )
        return await fulfill(requestId, 204, 'image/x-icon');
      unexpected.push(incoming.url);
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch (error) {
      failures.push(String(error));
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return { failures, unexpected, remoteResponses };
}

// Controlled source documents: real browser link/referrer behavior, no requests to social platforms.
for (const [host, source, policy, redirect] of [
  ['www.reddit.com', 'Reddit', 'strict-origin-when-cross-origin', false],
  ['t.co', 'X', 'strict-origin-when-cross-origin', true],
  ['www.google.com', 'Google', 'strict-origin-when-cross-origin', false],
  ['www.reddit.com', 'Unknown', 'no-referrer', false],
] as const) {
  test(`untagged ${host} link with ${policy}${redirect ? ' and redirect' : ''} reaches the collector`, async ({
    page,
    request,
    baseURL,
  }) => {
    const project = await fixture(request, baseURL!, '', 'https://product.app-health.invalid');
    const batches = receipts(page);
    const controlled = await controlledSource(page, request, project, host, policy, redirect);
    const origin = `https://${host}/__app_health_fixture`;
    await page.goto(origin);
    await page.getByRole('link', { name: 'Visit product' }).click();
    await flush(page);
    expect(batches[0].attribution?.source).toBe(source === 'Unknown' ? '' : host);
    expect(JSON.stringify(batches)).not.toContain('__app_health_fixture');
    await expect
      .poll(async () => (await report(request, project)).sources)
      .toEqual([{ name: source, count: 1 }]);
    await page.getByRole('link', { name: 'Next' }).click();
    await flush(page);
    expect(batches.at(-1)!.session_id).toBe(batches[0].session_id);
    await expect
      .poll(async () => (await report(request, project)).sources)
      .toEqual([{ name: source, count: 2 }]);
    await page.reload();
    await flush(page);
    expect(batches.at(-1)!.session_id).toBe(batches[0].session_id);
    expect((await report(request, project)).sessions).toBe(1);
    expect(controlled.failures).toEqual([]);
    expect(controlled.unexpected).toEqual([]);
    expect(controlled.remoteResponses).toEqual([]);
  });
}

test('simultaneous tabs serialize identity creation and report one visitor and session', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const project = await fixture(request, baseURL!);
  // Hold a real readwrite transaction so both fresh trackers contend for the same authority.
  await page.goto(`${project.origin}/blank`);
  await context.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    const state = window as unknown as { identityTransactions: number };
    state.identityTransactions = 0;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args) {
      if (this.name === 'app-health-identity' && args[1] === 'readwrite')
        state.identityTransactions++;
      return original.apply(this, args);
    };
    // Reproduce the incoherent legacy snapshot even when tabs run on one renderer.
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      return key.endsWith(':w') ? null : get.call(this, key);
    };
  });
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('app-health-identity', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('scopes');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const transaction = db.transaction('scopes', 'readwrite');
    const store = transaction.objectStore('scopes');
    let released = false;
    const pump = () => {
      if (!released) store.get('barrier').onsuccess = pump;
    };
    pump();
    const safety = setTimeout(() => {
      released = true;
    }, 10000);
    (window as unknown as { releaseIdentity: () => Promise<void> }).releaseIdentity = () => {
      released = true;
      clearTimeout(safety);
      return new Promise<void>((resolve) => {
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
      });
    };
  });
  const tabs = await Promise.all([context.newPage(), context.newPage()]);
  const batches = tabs.map(receipts);
  await Promise.all(tabs.map((tab) => tab.goto(`${project.origin}/fixture/landing`)));
  await expect
    .poll(() =>
      Promise.all(
        tabs.map((tab) =>
          tab.evaluate(
            () => (window as unknown as { identityTransactions: number }).identityTransactions,
          ),
        ),
      ),
    )
    .toEqual([1, 1]);
  await page.evaluate(() =>
    (window as unknown as { releaseIdentity: () => Promise<void> }).releaseIdentity(),
  );
  await Promise.all(tabs.map(flush));
  expect(batches[0][0].visitor_id).toBeTruthy();
  expect(batches[0][0].visitor_id).toBe(batches[1][0].visitor_id);
  expect(batches[0][0].session_id).toBe(batches[1][0].session_id);
  await expect
    .poll(async () => (await report(request, project)).audience)
    .toMatchObject({ visitors: 1, new_sessions: 1, returning_sessions: 0 });
  expect((await report(request, project)).sessions).toBe(1);
  // Simulate persisted inactivity without waiting 30 minutes or changing collector time.
  await tabs[0].evaluate(async (scope) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const opening = indexedDB.open('app-health-identity', 1);
      opening.onsuccess = () => resolve(opening.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('scopes', 'readwrite');
      const store = transaction.objectStore('scopes');
      const request = store.get(scope);
      request.onsuccess = () =>
        store.put(
          { ...request.result, visit: { ...request.result.visit, last: Date.now() - 1_800_001 } },
          scope,
        );
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, project.key);
  await tabs[0].evaluate(() => window.appHealth!.track('resumed'));
  await flush(tabs[0]);
  await flush(tabs[1]);
  expect(batches[0].at(-1)!.session_id).not.toBe(batches[0][0].session_id);
  expect(batches[1].at(-1)!.session_id).toBe(batches[0].at(-1)!.session_id);
  expect(batches[0].at(-1)!.visitor_id).toBe(batches[0][0].visitor_id);
  await expect
    .poll(async () => (await report(request, project)).audience)
    .toMatchObject({ visitors: 1, new_sessions: 1, returning_sessions: 1 });
});

test('consent and persistent own-visit exclusion gate actual collector traffic across tabs', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const project = await fixture(
    request,
    baseURL!,
    'data-consent="required" data-autotrack="true" data-vitals="true"',
  );
  const first = receipts(page);
  const optional: string[] = [];
  page.on('request', (request) => {
    if (/\/(tracker-extras|vitals)\.js/.test(request.url())) optional.push(request.url());
  });
  await page.goto(`${project.origin}/fixture/landing?ref=launch&secret=private`);
  await page.waitForFunction(() => !!window.appHealth);
  await page.evaluate(() => {
    window.appHealth!.track('pre_consent');
    history.pushState({}, '', '/fixture/current?secret=private');
  });
  await flush(page);
  expect(first).toEqual([]);
  expect(optional).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.evaluate(() => window.appHealth!.consent(true));
  await flush(page);
  expect(first[0].events.map((event) => [event.type, event.name, event.path])).toEqual([
    ['pageview', undefined, '/fixture/current'],
  ]);
  const secondPage = await context.newPage();
  const second = receipts(secondPage);
  await secondPage.goto(`${project.origin}/fixture/landing`);
  await secondPage.waitForFunction(() => !!window.appHealth);
  await page.evaluate(() => {
    window.appHealth!.track('queued_before_exclusion');
    window.appHealth!.ignore();
  });
  await secondPage.waitForFunction(() => window.appHealth?.isIgnored());
  await secondPage.evaluate(() => window.appHealth!.consent(true));
  await Promise.all([flush(page), flush(secondPage)]);
  expect(first).toHaveLength(1);
  expect(second).toEqual([]);
  expect(
    await secondPage.evaluate(() =>
      Object.keys(localStorage).filter((name) => name.endsWith(':ignore')),
    ),
  ).toEqual([`h:${project.key}:ignore`]);
  await secondPage.reload();
  await secondPage.waitForFunction(() => window.appHealth?.isIgnored());
  await secondPage.evaluate(() => window.appHealth!.ignore(false));
  await flush(secondPage);
  expect(second).toEqual([]);
  await secondPage.evaluate(() => window.appHealth!.consent(true));
  await flush(secondPage);
  expect(second[0].events).toHaveLength(1);
  expect(second[0].events[0].name).toBeUndefined();
  await page.waitForFunction(() => !window.appHealth?.isIgnored());
  await flush(page);
  expect(first).toHaveLength(2);
  expect(first[1].events.map((event) => event.name)).toEqual([undefined]);
  await secondPage.close();
});

test('persistent identity migrates an active legacy visit once across concurrent tabs', async ({
  context,
  request,
  baseURL,
}) => {
  const project = await fixture(request, baseURL!);
  const visitor = { id: crypto.randomUUID(), expires: Date.now() + 86400000 };
  const visit = {
    id: crypto.randomUUID(),
    last: Date.now(),
    visitor_id: visitor.id,
    type: 'returning',
    attribution: {
      source: 'launch',
      medium: '',
      campaign: '',
      content: '',
      term: '',
      entry_path: '/original',
    },
  };
  await context.addInitScript(
    ({ key, visitor, visit }) => {
      localStorage.setItem(`h:${key}:v`, JSON.stringify(visitor));
      localStorage.setItem(`h:${key}:w`, JSON.stringify(visit));
    },
    { key: project.key, visitor, visit },
  );
  const tabs = await Promise.all([context.newPage(), context.newPage()]);
  const batches = tabs.map(receipts);
  await Promise.all(tabs.map((tab) => tab.goto(`${project.origin}/fixture/landing`)));
  await Promise.all(tabs.map(flush));
  for (const recorded of batches) {
    expect(recorded[0]).toMatchObject({
      visitor_id: visitor.id,
      session_id: visit.id,
      visit_type: 'returning',
      attribution: visit.attribution,
    });
  }
  await expect.poll(async () => (await report(request, project)).audience.visitors).toBe(1);
  expect((await report(request, project)).sessions).toBe(1);
  await tabs[0].reload();
  await flush(tabs[0]);
  expect(batches[0].at(-1)?.session_id).toBe(visit.id);
  await Promise.all(tabs.map((tab) => tab.close()));
});

test('transactional identity aborts before commit on consent revocation and never sends stale events', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const project = await fixture(request, baseURL!);
  const visitor = { id: crypto.randomUUID(), expires: Date.now() + 86400000 };
  const visit = {
    id: crypto.randomUUID(),
    last: Date.now(),
    visitor_id: visitor.id,
    type: 'returning',
    attribution: {
      source: 'launch',
      medium: '',
      campaign: '',
      content: '',
      term: '',
      entry_path: '/original',
    },
  };
  await context.addInitScript(
    ({ key, visitor, visit }) => {
      localStorage.setItem(`h:${key}:v`, JSON.stringify(visitor));
      localStorage.setItem(`h:${key}:w`, JSON.stringify(visit));
      const put = IDBObjectStore.prototype.put;
      let revoke = true;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args) {
        const request = put.apply(this, args);
        if (revoke && this.name === 'scopes') {
          revoke = false;
          window.appHealth!.consent(false);
          (window as unknown as { revokedInTransaction: boolean }).revokedInTransaction = true;
        }
        return request;
      };
    },
    { key: project.key, visitor, visit },
  );
  const batches = receipts(page);
  await page.goto(`${project.origin}/fixture/landing`);
  await page.waitForFunction(
    () => (window as unknown as { revokedInTransaction: boolean }).revokedInTransaction,
  );
  await flush(page);
  expect(batches).toEqual([]);
  expect(
    await page.evaluate(async (scope) => {
      const opening = indexedDB.open('app-health-identity', 1);
      const db = await new Promise<IDBDatabase>((resolve) => {
        opening.onsuccess = () => resolve(opening.result);
      });
      const tx = db.transaction('scopes', 'readonly');
      const get = tx.objectStore('scopes').get(scope);
      const missing = await new Promise<boolean>((resolve) => {
        tx.oncomplete = () => resolve(get.result === undefined);
      });
      db.close();
      return missing;
    }, project.key),
  ).toBe(true);
  await page.evaluate(() => window.appHealth!.consent(true));
  await flush(page);
  expect(batches).toHaveLength(1);
  expect(batches[0].events.map((event) => event.name)).toEqual([undefined]);
  expect(batches[0]).toMatchObject({
    visitor_id: visitor.id,
    session_id: visit.id,
    visit_type: 'returning',
  });
});

test('persistent identity keeps its committed session when a later transaction fails', async ({
  page,
  request,
  baseURL,
}) => {
  const project = await fixture(request, baseURL!);
  const batches = receipts(page);
  await page.goto(`${project.origin}/fixture/landing`);
  await flush(page);
  await page.evaluate(() => {
    IDBDatabase.prototype.transaction = function () {
      throw new DOMException('Denied', 'SecurityError');
    };
    window.appHealth!.track('after_failure');
  });
  await flush(page);
  await page.evaluate(() => window.appHealth!.track('still_unidentified'));
  await flush(page);
  expect(batches).toHaveLength(3);
  expect(batches.every((batch) => batch.session_id === batches[0].session_id)).toBe(true);
  expect(batches.slice(1).every((batch) => !batch.visitor_id && !batch.visit_type)).toBe(true);
  await expect.poll(async () => (await report(request, project)).sessions).toBe(1);
  expect((await report(request, project)).audience).toMatchObject({
    new_sessions: 1,
    returning_sessions: 0,
    unidentified_sessions: 0,
  });
});

test('persistent identity falls back to unidentified memory when IndexedDB is denied', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const project = await fixture(request, baseURL!);
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException('Denied', 'SecurityError');
      },
    });
  });
  const batches = receipts(page);
  await page.goto(`${project.origin}/fixture/landing`);
  await flush(page);
  await page.evaluate(() => window.appHealth!.track('next'));
  await flush(page);
  expect(batches).toHaveLength(2);
  expect(batches[0].session_id).toBe(batches[1].session_id);
  expect(batches.every((batch) => !batch.visitor_id && !batch.visit_type)).toBe(true);
});

test('cookieless identity stays in memory and checkout metadata contains only sanitized attribution', async ({
  page,
  request,
  baseURL,
}) => {
  const project = await fixture(request, baseURL!, 'data-identity="cookieless"');
  const batches = receipts(page);
  await page.goto(
    `${project.origin}/fixture/landing?via=partner&utm_campaign=summer&secret=private`,
  );
  await flush(page);
  const first = batches[0];
  expect(first.visitor_id).toBeUndefined();
  expect(first.visit_type).toBeUndefined();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  expect(await page.evaluate(() => window.appHealth!.checkoutMetadata())).toEqual({
    app_health_source: 'partner',
    app_health_page: '/fixture/landing',
    app_health_campaign: 'summer',
  });
  await page.evaluate(() => window.appHealth!.track('action'));
  await flush(page);
  expect(batches[1].session_id).toBe(first.session_id);
  await page.reload();
  await flush(page);
  expect(batches[2].session_id).not.toBe(first.session_id);
  expect(JSON.stringify(batches)).not.toContain('private');
});

test('old and new tracker tabs plus an old-script rollback share one collector identity', async ({
  context,
  request,
  baseURL,
}) => {
  // Byte-for-byte pre-IDB tracker fixture from d3be57c; no synthetic legacy writer.
  const project = await fixture(request, baseURL!);
  const oldTab = await context.newPage();
  const newTab = await context.newPage();
  const oldBatches = receipts(oldTab);
  const newBatches = receipts(newTab);
  await oldTab.goto(`${project.origin}/fixture/landing?version=legacy`);
  await flush(oldTab);
  const original = oldBatches[0];
  expect(original.visitor_id).toBeTruthy();
  await newTab.goto(`${project.origin}/fixture/landing`);
  await flush(newTab);
  await oldTab.evaluate(() => window.appHealth!.track('old_after_migration'));
  await flush(oldTab);
  await newTab.evaluate(() => window.appHealth!.track('new_after_old'));
  await flush(newTab);
  await oldTab.reload();
  await flush(oldTab);
  for (const batch of [...oldBatches, ...newBatches]) {
    expect(batch.visitor_id).toBe(original.visitor_id);
    expect(batch.session_id).toBe(original.session_id);
  }
  const mirror = await newTab.evaluate(
    (key) => ({
      visitor: JSON.parse(localStorage.getItem(`h:${key}:v`)!),
      visit: JSON.parse(localStorage.getItem(`h:${key}:w`)!),
      marker: localStorage.getItem(`h:${key}:m`),
    }),
    project.key,
  );
  expect(mirror.visitor.id).toBe(original.visitor_id);
  expect(mirror.visit.id).toBe(original.session_id);
  expect(mirror.marker).toBe('1');
  await expect
    .poll(async () => (await report(request, project)).audience)
    .toMatchObject({
      visitors: 1,
      new_sessions: 1,
      returning_sessions: 0,
      unidentified_sessions: 0,
    });
  expect((await report(request, project)).sessions).toBe(1);
  expect(oldBatches).toHaveLength(3);
  expect(newBatches).toHaveLength(2);

  // The old tab stayed active while the canonical record aged past the inactivity limit.
  await newTab.evaluate(async (key) => {
    const opening = indexedDB.open('app-health-identity', 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      opening.onsuccess = () => resolve(opening.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('scopes', 'readwrite');
      const store = tx.objectStore('scopes');
      const get = store.get(key);
      get.onsuccess = () =>
        store.put(
          { ...get.result, visit: { ...get.result.visit, last: Date.now() - 1800001 } },
          key,
        );
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, project.key);
  await oldTab.evaluate(() => window.appHealth!.track('old_still_active'));
  await flush(oldTab);
  await newTab.evaluate(() => window.appHealth!.track('new_reconciles_old_activity'));
  await flush(newTab);
  expect(oldBatches.at(-1)!.session_id).toBe(original.session_id);
  expect(newBatches.at(-1)!.session_id).toBe(original.session_id);
  expect(newBatches.at(-1)!.visitor_id).toBe(original.visitor_id);
  expect((await report(request, project)).sessions).toBe(1);
  expect((await report(request, project)).audience.visitors).toBe(1);
  await Promise.all([oldTab.close(), newTab.close()]);
});
