import { expect, test } from '@playwright/test';
import { checkReadability } from './readability';

for (const theme of ['dark', 'light']) {
  for (const width of [390, 768, 1440]) {
    for (const surface of ['settings', 'analytics', 'endpoints', 'logs']) {
      test(`capability setup ${surface} ${theme} ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((value) => localStorage.setItem('app-health-theme', value), theme);
        await page.route('**/v1/capabilities?**', async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.capabilities = body.capabilities.map((state: { id: string }) => ({
            ...state,
            enabled: true,
            first_received_at: null,
            last_received_at: null,
          }));
          await route.fulfill({ response, json: body });
        });
        await page.goto(`/app?demo=populated#${surface}`);
        if (surface === 'settings')
          await expect(
            page.getByText('Capabilities in this environment', { exact: true }),
          ).toBeVisible();
        else
          await expect(
            page.getByText('Waiting for the first valid', { exact: false }),
          ).toBeVisible();
        await checkReadability(page);
        await expect(page.locator('footer')).toHaveCount(0);
        await expect(
          page.locator('script[src*="project-strip.js"],script[src*="ai-chat-footer.js"]'),
        ).toHaveCount(0);
        await info.attach('setup-surface', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      });
    }
  }
}
