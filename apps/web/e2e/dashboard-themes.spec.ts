import { expect, test } from '@playwright/test';
import { checkReadability } from './readability';
import { receivedFixture } from './received-fixture';

for (const theme of ['dark', 'light']) {
  for (const width of [390, 768, 1440]) {
    for (const view of ['endpoints', 'logs', 'data']) {
      for (const state of ['populated', 'empty', 'error']) {
        test(`${view} ${state} ${theme} ${width}px`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width, height: 1000 });
          await page.addInitScript(
            (value) => localStorage.setItem('app-health-theme', value),
            theme,
          );
          await receivedFixture(page, view === 'logs' ? 'logs' : 'endpoints');
          const path = view === 'data' ? 'failures' : view;
          await page.route(`**/v1/${path}?**`, async (route) => {
            if (state === 'error')
              return route.fulfill({ status: 503, json: { error: 'Synthetic outage' } });
            if (view === 'endpoints' && state === 'populated') return route.continue();
            const now = Date.now();
            const logs = ['debug', 'info', 'warn', 'error'].map((level, i) => ({
              log_id: `00000000-0000-4000-a000-00000000010${i}`,
              timestamp: now,
              event: `review.${level}`,
              level,
              source: i % 2 ? 'browser' : 'server',
              title: 'Theme verification',
              description: 'A readable diagnostic message.',
              props: { release: 'review', attempt: i },
            }));
            const failures = [
              {
                failure_id: '00000000-0000-4000-a000-000000000001',
                method: 'POST',
                route: '/orders/:id',
                status_code: 503,
                duration_ms: 812,
                occurred_at: now,
                release: 'review',
              },
            ];
            return route.fulfill({
              json: {
                refreshed_at: now,
                window: '15m',
                retention_hours: 24,
                retention_days: 30,
                level: 'debug',
                limit: 100,
                [path]: state === 'empty' ? [] : view === 'logs' ? logs : failures,
              },
            });
          });
          const loaded = page.waitForResponse(
            (response) => new URL(response.url()).pathname === `/v1/${path}`,
          );
          await page.goto(
            `/app?demo=populated#${({ endpoints: 'backend', logs: 'backend/logs', data: 'backend/diagnostics' } as Record<string, string>)[view] ?? view}`,
          );
          await loaded;
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          if (state === 'error') await expect(page.getByRole('alert').first()).toBeVisible();
          else if (state === 'empty')
            await expect(
              page.getByText(/no endpoints observed yet|no retained failures in|no logs match/),
            ).toBeVisible();
          else if (view === 'logs' && state === 'populated')
            await expect(page.getByText('review.error', { exact: true })).toBeVisible();
          else if (view === 'data' && state === 'populated') {
            const details = page.getByRole('button', {
              name: 'View details for POST /orders/:id 503',
            });
            await expect(details).toBeVisible();
            await details.click();
          } else if (view === 'endpoints' && state === 'populated')
            await expect(
              page.getByText('/health', { exact: true }).filter({ visible: true }),
            ).toBeVisible();
          await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
          await checkReadability(page);
          await expect(page.locator('footer')).toHaveCount(0);
          await testInfo.attach('rendered-view', {
            body: await page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
        });
      }
    }
  }
}

for (const path of ['/', '/app?demo=populated']) {
  test(`defaults to dark despite a light system preference at ${path}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => localStorage.removeItem('app-health-theme'));
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
    await expect(
      page.getByRole('button', { name: 'Switch to dark mode', exact: true }),
    ).toBeVisible();
  });
}
