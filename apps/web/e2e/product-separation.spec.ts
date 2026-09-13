import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkReadability } from './readability';
import { receivedFixture } from './received-fixture';

const evidence = resolve(import.meta.dirname, '../../../.fleet/evidence/product-separation');

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
});

for (const theme of ['dark', 'light']) {
  for (const width of [390, 768, 1440]) {
    for (const surface of ['events', 'endpoints'] as const) {
      test(`${surface} is distinct at ${width}px in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((value) => localStorage.setItem('app-health-theme', value), theme);
        await receivedFixture(page, surface === 'events' ? 'analytics' : 'endpoints');
        if (surface === 'events') {
          const now = Date.now();
          await page.route('**/v1/analytics/report?**', (route) =>
            route.fulfill({
              json: {
                from: now - 86_400_000,
                to: now,
                source: 'local',
                sampled: false,
                series: [
                  { timestamp: now - 10_800_000, pageviews: 28, events: 3 },
                  { timestamp: now - 7_200_000, pageviews: 34, events: 7 },
                  { timestamp: now - 3_600_000, pageviews: 41, events: 11 },
                  { timestamp: now, pageviews: 38, events: 8 },
                ],
                pages: [{ name: '/signup', count: 18 }],
                sources: [{ name: 'reddit.com', count: 9 }],
                events: [
                  { name: 'signup.completed', count: 14, last_seen: now },
                  { name: 'project.created', count: 9, last_seen: now - 300_000 },
                  { name: 'share_link.created', count: 6, last_seen: now - 900_000 },
                ],
                sessions: 22,
              },
            }),
          );
        }

        const response = page.waitForResponse((candidate) => {
          const path = new URL(candidate.url()).pathname;
          return (
            candidate.ok() &&
            (surface === 'events' ? path === '/v1/analytics/report' : path === '/v1/endpoints')
          );
        });
        await page.goto(
          `/app?demo=populated#${({ endpoints: 'backend', logs: 'backend/logs', data: 'backend/diagnostics' } as Record<string, string>)[surface] ?? surface}`,
        );
        await response;

        if (surface === 'events') {
          await expect(page.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'Product events over time' }),
          ).toBeVisible();
          await expect(page.getByRole('heading', { name: 'Top pages' })).toHaveCount(0);
          await expect(page.getByRole('tab', { name: 'Audience' })).toHaveCount(0);
        } else {
          await expect(page.getByRole('heading', { level: 1, name: 'Backend' })).toBeVisible();
          await expect(page.getByRole('tab', { name: 'API monitoring' })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          await expect(
            page.getByText('/health', { exact: true }).filter({ visible: true }),
          ).toBeVisible();
        }

        await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
        await checkReadability(page);
        await page.screenshot({
          path: resolve(evidence, `${surface}-${theme}-${width}.png`),
          fullPage: true,
        });
      });
    }
  }
}
