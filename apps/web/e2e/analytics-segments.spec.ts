import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('real collected traffic supports stacked source and device filters with clear recovery', async ({
  page,
  request,
  baseURL,
}) => {
  const evidence = resolve(import.meta.dirname, '../../../.fleet/evidence/analytics-segments');
  await mkdir(evidence, { recursive: true });
  const created = await (
    await request.post('/v1/apps', {
      data: { name: 'Segment explorer · local collector', environment: 'local' },
    })
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
  for (const [source, ua, path, count] of [
    ['www.reddit.com', 'Mozilla/5.0 (iPhone) Mobile Safari/605.1', '/stories', 2],
    ['old.reddit.com', 'Mozilla/5.0 Chrome/130.0', '/desktop', 1],
    ['google.com', 'Mozilla/5.0 (iPhone) Mobile Safari/605.1', '/search', 1],
  ] as const) {
    const response = await request.post('/v1/browser', {
      headers: { origin: baseURL!, 'user-agent': ua },
      data: {
        schema_version: 1,
        batch_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        public_key: key.key,
        events: Array.from({ length: count }, (_, i) => ({
          event_id: crypto.randomUUID(),
          type: 'pageview',
          timestamp: Date.now() - 2000 + i,
          path,
          referrer: source,
        })),
      },
    });
    expect(response.status(), await response.text()).toBe(202);
  }
  await page.addInitScript(
    (value) => localStorage.setItem('app-health-v0-project', JSON.stringify(value)),
    {
      appId: created.app.id,
      environmentId: created.environment.id,
      name: created.app.name,
      environment: 'local',
    },
  );
  await page.goto('/app#analytics');
  await page.getByRole('button', { name: 'Filter Referral sources by Reddit' }).click();
  await expect(page.getByRole('button', { name: 'Remove Source: Reddit filter' })).toBeVisible();
  await page.getByRole('tab', { name: 'Technology', exact: true }).click();
  await page.getByRole('button', { name: 'Filter Devices by Mobile' }).click();
  await expect(page.getByRole('button', { name: 'Remove Device: Mobile filter' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filter Top pages by /stories' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filter Top pages by /desktop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Filter Top pages by /search' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Session engagement' })).toHaveCount(0);
  await expect(page.getByText('All project sessions · not filtered')).toBeVisible();
  const api = await request.get(
    `/v1/analytics/report?app_id=${created.app.id}&environment_id=${created.environment.id}&source=Reddit&device=Mobile`,
  );
  const report = await api.json();
  expect(report.pages).toEqual([{ name: '/stories', count: 2 }]);
  expect(report.engagement).toBeUndefined();
  await page.getByRole('combobox', { name: 'Analytics period' }).click();
  await page.getByRole('option', { name: 'Last 7 days' }).click();
  await expect(page.getByRole('button', { name: 'Filter Top pages by /stories' })).toBeVisible();
  for (const theme of ['dark', 'light'])
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page.getByRole('button', { name: `Switch to ${theme} mode` }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('button', { name: 'Clear all filters' })).toHaveCSS(
        'color',
        theme === 'light' ? 'rgb(24, 24, 27)' : 'rgb(250, 250, 250)',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: resolve(evidence, `segments-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.getByRole('button', { name: 'Remove Device: Mobile filter' }).click();
  await expect(page.getByRole('button', { name: 'Filter Top pages by /desktop' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all filters' }).click();
  await expect(page.getByRole('button', { name: 'Filter Top pages by /search' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Session engagement' })).toBeVisible();
});
