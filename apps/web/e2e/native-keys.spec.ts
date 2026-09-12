import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('native setup creates and revokes a usable scoped public key in both themes', async ({
  page,
  request,
}) => {
  const created = await (
    await request.post('/v1/apps', { data: { name: 'Swift shop', environment: 'production' } })
  ).json();
  const scope = `app_id=${created.app.id}&environment_id=${created.environment.id}`;
  await page.goto(`/app?project=${created.app.id}&environment=${created.environment.id}#settings`);
  await page.getByRole('button', { name: 'Create native public key' }).click();
  const key = await page.getByLabel('Native public key', { exact: true }).inputValue();
  expect(key).toMatch(/^ahk_native_[a-f0-9]{64}$/);
  const card = page.getByText('Swift apps', { exact: true }).locator('../..');
  const evidence = resolve(import.meta.dirname, '../../../.fleet/evidence/native');
  await mkdir(evidence, { recursive: true });
  for (const theme of ['dark', 'light']) {
    const button = page.getByRole('button', { name: `Switch to ${theme} mode` });
    if (await button.count()) await button.click();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await card.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await card.screenshot({ path: resolve(evidence, `native-keys-${theme}-${width}.png`) });
    }
  }
  expect(await page.locator('footer').count()).toBe(0);
  const body = {
    schema_version: 1,
    public_key: key,
    batch_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    active: false,
    events: [
      {
        event_id: crypto.randomUUID(),
        timestamp: Date.now(),
        name: 'native.setup',
        screen: 'welcome',
      },
    ],
    logs: [],
  };
  expect((await request.post('/v1/native', { data: body })).status()).toBe(202);
  const analytics = await (await request.get(`/v1/analytics/report?range=1h&${scope}`)).json();
  expect(analytics.events).toEqual([expect.objectContaining({ name: 'native.setup', count: 1 })]);
  await page.getByRole('button', { name: 'Revoke native key' }).click();
  await page.getByRole('button', { name: 'Revoke now' }).click();
  await expect(card.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Native public key', { exact: true })).toHaveCount(0);
  expect((await request.post('/v1/native', { data: body })).status()).toBe(403);
});
