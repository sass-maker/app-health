import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('owner analytics audience breakdowns are real, responsive, and filterable', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const evidence = resolve(import.meta.dirname, '../../../.fleet/evidence/dashboard-polish');
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
          content: 'hero-link',
          term: 'storage tools',
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
  await expect(page.getByText('visitors', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('returning sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'channels', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'countries', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Session engagement' })).toBeVisible();
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((value) => localStorage.setItem('app-health-theme', value), theme);
      await page.reload();
      await expect(page.getByText('visitors', { exact: true })).toBeVisible({ timeout: 15_000 });
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
  await page.getByRole('tab', { name: 'acquisition', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'campaigns', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'mediums', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filter Campaign content by hero-link' }).click();
  await page.getByRole('button', { name: 'Filter Mediums by email' }).click();
  await page.getByRole('button', { name: 'Filter Campaign terms by storage tools' }).click();
  await expect(
    page.getByRole('button', { name: 'Remove Campaign term: storage tools filter' }),
  ).toBeVisible();
  await expect(page.getByLabel('Page views comparison')).toContainText(
    'no activity in the previous period',
  );
  for (const theme of ['dark', 'light'])
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.getByRole('button', { name: `Switch to ${theme} mode` }).click();
      await expect(page.getByRole('button', { name: 'clear all filters' })).toHaveCSS(
        'color',
        await page.locator('body').evaluate((body) => getComputedStyle(body).color),
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: resolve(evidence, `acquisition-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.getByRole('button', { name: 'clear all filters' }).click();

  await page.getByRole('tab', { name: 'technology', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'devices', exact: true })).toBeVisible();
  const period = page.getByRole('combobox', { name: 'Analytics period', exact: true });
  await period.click();
  await page.getByRole('option', { name: 'last 7 days', exact: true }).click();
  await expect(period).toHaveText('last 7 days');
  await page.getByRole('button', { name: 'daily briefing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'daily briefing', exact: true })).toBeVisible();
  const briefingDay = page.getByRole('region').filter({ hasText: 'completed India day' });
  await expect(briefingDay.getByRole('heading', { level: 2 })).toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: 'request health and collection details' })
    .click();
  await expect(page.getByText('complete inventory', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toHaveCount(0);
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.getByRole('button', { name: `Switch to ${theme} mode` }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 1440) {
        const projectNavigation = await page
          .getByRole('button', { name: project.name, exact: true })
          .boundingBox();
        const themeButton = await page
          .getByRole('button', { name: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode` })
          .boundingBox();
        expect(projectNavigation!.x).toBeLessThan(themeButton!.x / 2);
      }
      await page.screenshot({
        path: resolve(evidence, `overview-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  await page.getByRole('button', { name: project.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'analytics', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Environment', exact: true })).toBeVisible();
  await expect(page.getByText('your projects', { exact: true })).toHaveCount(0);
});
