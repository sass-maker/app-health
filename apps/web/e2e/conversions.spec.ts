import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('real collected rich events drive goals, ordered funnels, properties and saved segments', async ({
  page,
  request,
  baseURL,
}) => {
  const created = await (
    await request.post('/v1/apps', { data: { name: 'Conversion proof', environment: 'local' } })
  ).json();
  const key = await (
    await request.post('/v1/public-keys', {
      data: {
        app_id: created.app.id,
        environment_id: created.environment.id,
        allowed_origins: [baseURL],
      },
    })
  ).json();
  const timestamp = Date.now() - 6000;
  for (let index = 0; index < 2; index++) {
    const events = [
      {
        event_id: crypto.randomUUID(),
        type: 'pageview',
        timestamp,
        path: index ? '/' : '/pricing',
        referrer: 'reddit.com',
      },
      ...(!index
        ? [
            {
              event_id: crypto.randomUUID(),
              type: 'event',
              timestamp: timestamp + 1000,
              path: '/account',
              referrer: 'reddit.com',
              name: 'signup.completed',
              properties: { plan: 'pro', seats: 2 },
              value: 29,
            },
          ]
        : []),
    ];
    const response = await request.post('/v1/browser', {
      headers: { origin: baseURL! },
      data: {
        schema_version: 1,
        public_key: key.key,
        batch_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        visitor_id: crypto.randomUUID(),
        visit_type: 'new',
        events,
      },
    });
    expect(response.status(), await response.text()).toBe(202);
  }
  await page.addInitScript(
    (project) => localStorage.setItem('app-health-v0-project', JSON.stringify(project)),
    {
      appId: created.app.id,
      environmentId: created.environment.id,
      name: created.app.name,
      environment: 'local',
    },
  );
  await page.goto('/app#events');
  await page.getByRole('button', { name: 'explore conversions', exact: true }).click();
  await page.getByRole('button', { name: 'new goal or funnel' }).click();
  await page.getByRole('textbox', { name: 'Conversion name' }).fill('Pricing visitors');
  await page.getByRole('textbox', { name: 'Step 1 target' }).fill('/pricing');
  await page.getByRole('button', { name: 'create goal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pricing visitors' })).toBeVisible();
  await expect(page.getByText('50.0%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Pricing visitors', exact: true }).click();
  await page.getByRole('textbox', { name: 'Conversion name' }).fill('Pricing conversions');
  await page.getByRole('button', { name: 'save goal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pricing conversions' })).toBeVisible();
  await page.getByRole('button', { name: 'new goal or funnel' }).click();
  await page.getByRole('combobox', { name: 'Conversion type' }).click();
  await page.getByRole('option', { name: 'ordered funnel' }).click();
  await page.getByRole('textbox', { name: 'Conversion name' }).fill('Pricing to signup');
  await page.getByRole('textbox', { name: 'Step 1 target' }).fill('/pricing');
  await page.getByRole('button', { name: 'create funnel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pricing to signup' })).toBeVisible();
  await expect(
    page.getByText('100.0% of starting sessions completed', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Explore signup.completed' }).click();
  await expect(page.getByRole('heading', { name: 'event properties & values' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'plan', exact: true })).toBeVisible();
  await expect(page.getByText('signup.completed: 1 occurrences · value 29')).toBeVisible();
  const scope = `app_id=${created.app.id}&environment_id=${created.environment.id}`;
  const segment = await request.post(`/v1/analytics/definitions?${scope}`, {
    data: { kind: 'segment', name: 'Reddit audience', filters: { source: 'Reddit' } },
  });
  expect(segment.status()).toBe(201);
  await page.getByRole('button', { name: 'saved segments', exact: true }).click();
  await page.getByRole('button', { name: 'Reddit audience', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Source: Reddit filter' })).toBeVisible();
  const transaction = crypto.randomUUID();
  const payment = {
    schema_version: 1,
    app_id: created.app.id,
    environment_id: created.environment.id,
    namespace: { provider: 'custom', account_id: 'merchant', mode: 'live' },
    delivery_id: `delivery-${transaction}`,
    fact: {
      kind: 'payment',
      transaction_id: transaction,
      occurred_at: timestamp,
      amount_minor: 2900,
      currency: 'USD',
      attribution: { source: 'Reddit', page: '/pricing' },
    },
  };
  const sendPayment = (data: unknown) =>
    request.post('/v1/payments', { headers: { authorization: `Bearer ${created.key.key}` }, data });
  expect((await sendPayment(payment)).status()).toBe(202);
  expect(await (await sendPayment(payment)).json()).toMatchObject({ duplicate: true });
  expect(
    (
      await sendPayment({
        ...payment,
        delivery_id: 'partial-refund',
        fact: {
          kind: 'refund',
          transaction_id: transaction,
          refund_id: 'partial-refund',
          occurred_at: timestamp + 1000,
          amount_minor: 900,
          currency: 'USD',
        },
      })
    ).status(),
  ).toBe(202);
  expect(
    (
      await sendPayment({
        ...payment,
        delivery_id: 'yen-payment',
        fact: {
          ...payment.fact,
          transaction_id: 'yen-payment',
          currency: 'JPY',
          amount_minor: 1200,
          attribution: { source: 'Google' },
        },
      })
    ).status(),
  ).toBe(202);
  expect(
    (
      await sendPayment({
        ...payment,
        delivery_id: 'test-payment',
        namespace: { ...payment.namespace, mode: 'test' },
        fact: { ...payment.fact, transaction_id: 'test-payment', amount_minor: 99900 },
      })
    ).status(),
  ).toBe(202);
  await page.getByRole('button', { name: 'explore revenue', exact: true }).click();
  await expect(page.locator('p').filter({ hasText: /^\$20\.00$/ })).toBeVisible();
  await expect(page.locator('p').filter({ hasText: /^¥1,200$/ })).toBeVisible();
  await expect(page.locator('p').filter({ hasText: /^\$999\.00$/ })).toHaveCount(0);
  const evidence = resolve(
    import.meta.dirname,
    '../../../.fleet-local/analytics-parity/conversions',
  );
  await mkdir(evidence, { recursive: true });
  for (const theme of ['dark', 'light'])
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.getByRole('button', { name: `Switch to ${theme} mode` }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: resolve(evidence, `conversions-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.getByRole('button', { name: 'Delete Pricing conversions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pricing conversions' })).toHaveCount(0);
});
