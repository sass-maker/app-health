import { expect, test } from '@playwright/test';
import { checkReadability } from './readability';
import { receivedFixture } from './received-fixture';

for (const theme of ['dark', 'light']) {
  for (const width of [390, 1440]) {
    for (const surface of ['landing', 'changelog', 'analytics', 'events']) {
      test(`${surface} rendered ${theme} ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((value) => localStorage.setItem('app-health-theme', value), theme);
        const url =
          surface === 'landing'
            ? '/'
            : surface === 'changelog'
              ? '/changelog'
              : `/app?demo=populated#${surface}`;
        if (['analytics', 'events'].includes(surface)) await receivedFixture(page, 'analytics');
        const report = ['analytics', 'events'].includes(surface)
          ? page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === '/v1/analytics/report' && response.ok(),
            )
          : Promise.resolve();
        await page.goto(url);
        await report;
        if (surface !== 'landing')
          await expect(
            page.locator('script[src*="project-strip.js"], script[src*="ai-chat-footer.js"]'),
          ).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
        await checkReadability(page);
        await expect(page.locator('footer')).toHaveCount(surface === 'landing' ? 1 : 0);
        await testInfo.attach('rendered-view', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      });
    }
  }
}
