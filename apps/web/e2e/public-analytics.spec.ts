import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('public link and embedded live analytics remain scoped and revoke while open', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  const evidence = resolve(import.meta.dirname, '../../../.fleet/evidence/public-analytics');
  await mkdir(evidence, { recursive: true });
  const created = await (
    await request.post('/v1/apps', {
      data: { name: 'Northstar public storefront', environment: 'production' },
    })
  ).json();
  const scope = `app_id=${created.app.id}&environment_id=${created.environment.id}`;
  const key = await (
    await request.post('/v1/public-keys', {
      data: {
        app_id: created.app.id,
        environment_id: created.environment.id,
        allowed_origins: [baseURL],
      },
    })
  ).json();
  await request.post('/v1/browser', {
    headers: { origin: baseURL! },
    data: {
      schema_version: 1,
      batch_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      public_key: key.key,
      events: [
        {
          event_id: crypto.randomUUID(),
          type: 'pageview',
          timestamp: Date.now(),
          path: '/private-route-name',
          referrer: '',
        },
        {
          event_id: crypto.randomUUID(),
          type: 'event',
          timestamp: Date.now(),
          path: '/private-route-name',
          referrer: '',
          name: 'private.event.name',
        },
      ],
    },
  });
  await page.goto(`/app?project=${created.app.id}&environment=${created.environment.id}#settings`);
  await page.getByRole('button', { name: 'Create public link', exact: true }).click();
  const linkField = page.getByLabel('Public page', { exact: true });
  await expect(linkField).toHaveValue(/\/live#token=ahs_/);
  const link = await linkField.inputValue();
  const embed = await page.getByLabel('Embed on your product', { exact: true }).inputValue();
  expect(embed).toContain('referrerpolicy="no-referrer"');
  expect(embed.includes(created.key.key)).toBe(false);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('#public-analytics-sharing').screenshot({
      path: resolve(evidence, `sharing-${width}.png`),
    });
  }
  const anonymous = await browser.newContext({ reducedMotion: 'reduce' });
  const publicPage = await anonymous.newPage();
  await publicPage.goto(link);
  await expect(
    publicPage.getByRole('heading', { name: 'Northstar public storefront', exact: true }),
  ).toBeVisible();
  await expect(publicPage.getByText('private.event.name')).toHaveCount(0);
  await expect(publicPage.getByText('/private-route-name')).toHaveCount(0);
  const body = await (
    await request.get('/v1/shared/analytics', { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(body.traffic.pageviews).toBe(1);
  expect(body.live.active).toBe(1);
  expect(Object.keys(body).sort()).toEqual([
    'live',
    'project',
    'sampled',
    'source',
    'traffic',
    'updated_at',
  ]);
  for (const theme of ['dark', 'light'])
    for (const width of [390, 768, 1440]) {
      await publicPage.setViewportSize({ width, height: 1000 });
      await publicPage.goto(link.replace('/live#', `/live?theme=${theme}#`));
      await expect(
        publicPage.getByRole('heading', { name: 'Northstar public storefront', exact: true }),
      ).toBeVisible();
      expect(
        await publicPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await publicPage.screenshot({
        path: resolve(evidence, `public-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  const host = await anonymous.newPage();
  const alternate = new URL(baseURL!);
  alternate.hostname = 'localhost';
  await host.goto(alternate.href);
  await host.setContent(embed);
  const frame = host.frameLocator('iframe');
  await expect(
    frame.getByRole('heading', { name: 'Northstar public storefront', exact: true }),
  ).toBeVisible();
  await expect(frame.getByRole('navigation')).toHaveCount(0);
  await host.screenshot({ path: resolve(evidence, 'embedded-product.png'), fullPage: true });
  const list = await (await request.get(`/v1/analytics/shares?${scope}`)).json();
  const id = list.shares[0].id;
  await page.getByRole('button', { name: `Revoke link ${id.slice(0, 8)}`, exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  expect(
    (
      await request.get('/v1/shared/analytics', { headers: { authorization: `Bearer ${token}` } })
    ).status(),
  ).toBe(404);
  await expect(
    frame.getByRole('heading', { name: 'This analytics link is unavailable', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    frame.getByRole('heading', { name: 'Northstar public storefront', exact: true }),
  ).toHaveCount(0);
  await anonymous.close();
});
