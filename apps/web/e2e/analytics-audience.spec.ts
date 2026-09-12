import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('owner analytics audience breakdowns are real, responsive, and filterable', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const evidence = resolve(import.meta.dirname, '../../../.fleet/evidence/analytics-audience');
  await mkdir(evidence, { recursive: true });
  const created = await (
    await request.post('/v1/apps', {
      data: { name: `Audience evidence ${Date.now()}`, environment: 'production' },
    })
  ).json();
  const project = {
    appId: created.app.id,
    environmentId: created.environment.id,
    name: created.app.name,
    environment: created.environment.name,
  };
  const key = await (
    await request.post('/v1/public-keys', {
      data: {
        app_id: project.appId,
        environment_id: project.environmentId,
        allowed_origins: [baseURL],
      },
    })
  ).json();
  for (let session = 0; session < 3; session++) {
    const response = await request.post('/v1/browser', {
      headers: { origin: baseURL! },
      data: {
        schema_version: 1,
        batch_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        visitor_id: crypto.randomUUID(),
        visit_type: session === 0 ? 'new' : 'returning',
        public_key: key.key,
        attribution: {
          source: session ? 'newsletter' : 'google',
          medium: 'email',
          campaign: 'spring',
          content: '',
          term: '',
          entry_path: '/checkout',
        },
        events: [
          {
            event_id: crypto.randomUUID(),
            type: 'pageview',
            timestamp: Date.now() - session * 60_000,
            path: '/checkout',
            referrer: session ? 'newsletter' : 'google.com',
          },
          {
            event_id: crypto.randomUUID(),
            type: 'pageview',
            timestamp: Date.now() - session * 60_000,
            path: '/pricing',
            referrer: '',
          },
        ],
      },
    });
    expect(response.status(), await response.text()).toBe(202);
  }
  await page.addInitScript((value) => {
    localStorage.setItem('app-health-v0-project', JSON.stringify(value));
  }, project);
  await page.goto('/app#analytics');
  await expect(page.getByText('Visitors', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Returning sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible();
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((value) => localStorage.setItem('app-health-theme', value), theme);
      await page.reload();
      await expect(page.getByText('Visitors', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: resolve(evidence, `audience-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.getByRole('tab', { name: 'Acquisition', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Technology', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
  const period = page.getByRole('combobox', { name: 'Analytics period', exact: true });
  await period.click();
  await page.getByRole('option', { name: 'Last 7 days', exact: true }).click();
  await expect(period).toHaveText('Last 7 days');
});
