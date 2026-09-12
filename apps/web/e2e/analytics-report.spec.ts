import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('public breakdowns require owner opt-in and render a responsive report', async ({
  page,
  request,
  baseURL,
}) => {
  const evidence = resolve(import.meta.dirname, '../../../.fleet/evidence/analytics-report');
  await mkdir(evidence, { recursive: true });
  const created = await (
    await request.post('/v1/apps', {
      data: { name: 'Highsignal · local verification', environment: 'production' },
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
  for (let session = 0; session < 4; session++) {
    const response = await request.post('/v1/browser', {
      headers: { origin: baseURL! },
      data: {
        schema_version: 1,
        batch_id: crypto.randomUUID(),
        session_id: crypto.randomUUID(),
        public_key: key.key,
        events: Array.from({ length: 12 }, (_, i) => ({
          event_id: crypto.randomUUID(),
          type: i % 4 === 0 ? 'event' : 'pageview',
          timestamp: Date.now() - (i * 300_000 + session * 60_000),
          path: ['/', '/signals', '/pricing'][i % 3],
          referrer: session % 2 ? 'news.ycombinator.com' : '',
          ...(i % 4 === 0 ? { name: 'signal.opened' } : {}),
        })),
      },
    });
    expect(response.status(), await response.text()).toBe(202);
  }
  const share = await (await request.post(`/v1/analytics/shares?${scope}`)).json();
  const link = `/live#token=${share.token}`;
  const headers = { authorization: `Bearer ${share.token}` };
  expect(
    (await (await request.get('/v1/shared/analytics', { headers })).json()).breakdowns,
  ).toBeUndefined();
  const enable = await request.patch(`/v1/analytics/shares?${scope}&id=${share.share.id}`, {
    data: { include_breakdowns: true },
  });
  expect(enable.status()).toBe(200);
  const report = await (await request.get('/v1/shared/analytics', { headers })).json();
  expect(report.breakdowns.sessions).toBe(4);
  expect(report.breakdowns.events).toBe(12);
  expect(report.traffic.pageviews).toBe(36);
  expect(JSON.stringify(report)).not.toContain('signal.opened');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/v1/shared/analytics', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(link);
  await expect(page.getByRole('status', { name: 'Loading shared analytics' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: resolve(evidence, 'loading-dark-1440.png'), fullPage: true });
  release();
  await expect(page.getByRole('heading', { name: 'Top routes' })).toBeVisible();
  await page.unroute('**/v1/shared/analytics');
  for (const theme of ['dark', 'light'])
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/live?theme=${theme}#token=${share.token}`);
      await expect(page.getByRole('heading', { name: 'Top sources' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(page.getByText('news.ycombinator.com', { exact: true })).toBeVisible();
      await page.screenshot({
        path: resolve(evidence, `report-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  await page.goto(`/live?embed=1#token=${share.token}`);
  await expect(page.getByRole('heading', { name: 'Top routes' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'About App Health' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(share.token);
  await page.screenshot({ path: resolve(evidence, 'embed-1440.png'), fullPage: true });
  await request.patch(`/v1/analytics/shares?${scope}&id=${share.share.id}`, {
    data: { include_breakdowns: false },
  });
  await page.reload();
  await expect(page.getByText('Page views', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top routes' })).toHaveCount(0);
});
