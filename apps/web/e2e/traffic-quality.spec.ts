import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('traffic quality keeps browser counts useful through bot loading, failures and segment filters', async ({
  page,
  request,
  baseURL,
}) => {
  const evidence = resolve(import.meta.dirname, '../test-results/traffic-quality');
  await mkdir(evidence, { recursive: true });
  const created = await (
    await request.post('/v1/apps', {
      data: { name: 'Traffic quality · browser fixture', environment: 'local' },
    })
  ).json();
  const app_id = created.app.id;
  const environment_id = created.environment.id;
  const key = await (
    await request.post('/v1/public-keys', {
      data: { app_id, environment_id, allowed_origins: [baseURL] },
    })
  ).json();
  const ingest = await request.post('/v1/browser', {
    headers: { origin: baseURL! },
    data: {
      schema_version: 1,
      batch_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      public_key: key.key,
      events: Array.from({ length: 12 }, (_, i) => ({
        event_id: crypto.randomUUID(),
        type: 'pageview',
        timestamp: Date.now() - 2000 + i,
        path: '/pricing',
        referrer: 'google.com',
      })),
    },
  });
  expect(ingest.status()).toBe(202);
  const to = Date.now();
  const local = await request.get(
    `/v1/analytics/traffic-quality?${new URLSearchParams({ app_id, environment_id, from: String(to - 3_600_000), to: String(to) })}`,
  );
  expect(local.status()).toBe(200);
  expect((await local.json()).bots).toEqual({ status: 'unknown', reason: 'local' });
  await page.addInitScript(
    (value) => localStorage.setItem('app-health-v0-project', JSON.stringify(value)),
    { appId: app_id, environmentId: environment_id, name: created.app.name, environment: 'local' },
  );
  let fail = true;
  let calls = 0;
  await page.route('**/v1/analytics/traffic-quality?**', async (route) => {
    calls++;
    if (fail) return route.fulfill({ status: 503, body: '{}' });
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      json: {
        app_id,
        environment_id,
        from: Number(params.get('from')),
        to: Number(params.get('to')),
        generated_at: Date.now(),
        time_basis: 'receipt_time',
        qa_internal: 'not_separately_identified',
        bots: {
          status: 'observed',
          pageview_attempts: 7,
          cloudflare_verified: 4,
          recognized_user_agent: 3,
          estimated: true,
          coverage: 'partial',
        },
      },
    });
  });
  await page.goto('/app#analytics');
  const card = page.getByLabel('Traffic quality', { exact: true });
  await expect(card.getByText('12', { exact: true })).toBeVisible();
  await expect(card.getByText('Bot counters could not load.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filter Top pages by /pricing' })).toBeVisible();
  fail = false;
  await card.getByRole('button', { name: 'Retry traffic quality' }).click();
  await expect(card.getByText('7', { exact: true })).toBeVisible();
  await expect(card.getByText('estimated · partial coverage')).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await card.screenshot({ path: resolve(evidence, `card-${width}.png`), animations: 'disabled' });
    await page.screenshot({
      path: resolve(evidence, `analytics-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  const beforeFilter = calls;
  await page.getByRole('button', { name: 'Filter Referral sources by Google' }).click();
  await expect(card.getByText(/unavailable for segment or named event filters/)).toBeVisible();
  await expect(card.getByText('7', { exact: true })).toHaveCount(0);
  await expect(card.getByText('12', { exact: true })).toHaveCount(0);
  expect(calls).toBe(beforeFilter);
  await expect(page.getByRole('button', { name: 'Filter Top pages by /pricing' })).toBeVisible();
  await page.getByRole('button', { name: 'clear all filters' }).click();
  await expect(card.getByText('7', { exact: true })).toBeVisible();
});
