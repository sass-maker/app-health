import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserBatchV1 } from '@app-health/contracts';

type Project = { app: { id: string }; environment: { id: string }; key: string; origin: string };
let server: Server;
test.afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function fixture(request: APIRequestContext, baseURL: string, attributes = '') {
  let key = '';
  server = createServer((req, res) => {
    if (req.url === '/fixture/redirect') {
      res.writeHead(302, { location: '/fixture/landing' }).end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><title>Tracker fixture</title><a href="/fixture/next">Next</a>${req.url?.startsWith('/fixture/') ? `<script src="${baseURL}/tracker.js" data-key="${key}" data-endpoint="${baseURL}/v1/browser" ${attributes}></script>` : ''}`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

// Controlled source documents: real browser link/referrer behavior, no requests to social platforms.
for (const [host, source, policy, redirect] of [
  ['www.reddit.com', 'Reddit', 'strict-origin-when-cross-origin', false],
  ['t.co', 'X', 'strict-origin-when-cross-origin', true],
  ['www.google.com', 'Google', 'strict-origin-when-cross-origin', false],
  ['www.reddit.com', 'Unknown', 'no-referrer', false],
] as const) {
  test(`untagged ${host} link with ${policy}${redirect ? ' and redirect' : ''} reaches the collector`, async ({
    page,
    context,
    request,
    baseURL,
  }) => {
    const project = await fixture(request, baseURL!);
    const batches = receipts(page);
    const origin = `http://${host}/__app_health_fixture`;
    await context.route(origin, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<a referrerpolicy="${policy}" href="${project.origin}/fixture/${redirect ? 'redirect' : 'landing'}">Visit product</a>`,
      }),
    );
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
  });
}

test('simultaneous tabs serialize identity creation and report one visitor and session', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const project = await fixture(request, baseURL!);
  // Hold the same browser-native lock so both fresh trackers contend deterministically.
  await page.goto(`${project.origin}/blank`);
  await page.evaluate((key) => {
    (window as unknown as { release: () => void }).release = () => {};
    void navigator.locks.request(
      `h:${key}:w`,
      () =>
        new Promise<void>((resolve) => {
          (window as unknown as { release: () => void }).release = resolve;
        }),
    );
  }, project.key);
  await expect
    .poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.length))
    .toBe(1);
  const tabs = await Promise.all([context.newPage(), context.newPage()]);
  const batches = tabs.map(receipts);
  await Promise.all(tabs.map((tab) => tab.goto(`${project.origin}/fixture/landing`)));
  await expect
    .poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.length))
    .toBe(2);
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await Promise.all(tabs.map(flush));
  expect(batches[0][0].visitor_id).toBeTruthy();
  expect(batches[0][0].visitor_id).toBe(batches[1][0].visitor_id);
  expect(batches[0][0].session_id).toBe(batches[1][0].session_id);
  await expect
    .poll(async () => (await report(request, project)).audience)
    .toMatchObject({ visitors: 1, new_sessions: 1, returning_sessions: 0 });
  expect((await report(request, project)).sessions).toBe(1);
  // Simulate persisted inactivity without waiting 30 minutes or changing collector time.
  await tabs[0].evaluate((key) => {
    const name = `h:${key}:w`;
    const visit = JSON.parse(localStorage.getItem(name)!);
    localStorage.setItem(name, JSON.stringify({ ...visit, last: Date.now() - 1_800_001 }));
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
