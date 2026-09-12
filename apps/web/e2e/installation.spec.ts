import { expect, test } from '@playwright/test';
import { checkReadability } from './readability';

for (const theme of ['dark', 'light']) {
  for (const width of [390, 1440]) {
    test(`project, tracker and revoke confirmation ${theme} ${width}px`, async ({ page }) => {
      const warnings: string[] = [];
      page.on('pageerror', (error) => warnings.push(error.message));
      page.on('console', (message) => {
        if (/Function components cannot|validateDOMNesting|React has detected/.test(message.text()))
          warnings.push(message.text());
      });
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript((value) => localStorage.setItem('app-health-theme', value), theme);
      await page.goto('/app');
      await expect(
        page.locator('script[src*="project-strip.js"], script[src*="ai-chat-footer.js"]'),
      ).toHaveCount(0);
      await page.getByLabel('Application name').fill(`Theme check ${theme} ${width} ${Date.now()}`);
      await checkReadability(page);
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Copy key', exact: true })).toBeVisible();
      await checkReadability(page);
      await expect(page.getByRole('tabpanel')).toHaveCount(1);
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }),
      );
      await page.getByRole('button', { name: 'Copy key', exact: true }).click();
      await expect(page.getByText('Automatic copy unavailable')).toBeVisible();
      await checkReadability(page);
      await page.getByRole('button', { name: 'Save key and choose capabilities' }).click();
      await page.getByRole('button', { name: 'Open setup', exact: true }).first().click();
      await expect(page.getByText('Install web analytics', { exact: true })).toBeVisible();
      await page.getByLabel('Allowed origins').fill('http://127.0.0.1:5194');
      await page.getByRole('button', { name: 'Create browser key', exact: true }).click();
      await expect(page.getByText('Copy this key now; it is shown once.')).toBeVisible();
      await checkReadability(page);
      const snippet = await page.locator('pre').filter({ hasText: '/tracker.js' }).innerText();
      const key = snippet.match(/data-key="([^"]+)"/)?.[1];
      expect(key).toBeTruthy();
      const accepted = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/v1/browser' && r.status() === 202,
      );
      await page.evaluate(
        (publicKey) =>
          new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/tracker.js';
            script.dataset.key = publicKey;
            script.dataset.endpoint = '/v1/browser';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Tracker did not load'));
            document.head.append(script);
          }),
        key!,
      );
      await accepted;
      await expect(page.getByText('Waiting for the first valid web analytics event')).toHaveCount(
        0,
        { timeout: 12000 },
      );
      await expect(page.getByText('First valid data', { exact: false })).toBeVisible();
      await page.goto('/app#settings');
      await expect(
        page.getByRole('heading', { name: 'Project settings', exact: true }),
      ).toBeVisible();
      const revoke = page.getByRole('button', { name: /Revoke browser key/ });
      await revoke.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await checkReadability(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(revoke).toBeFocused();
      await revoke.click();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(revoke).toBeFocused();
      await revoke.click();
      await dialog.getByRole('button', { name: 'Revoke key', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(/revoked .*ago/)).toBeVisible();
      await expect(revoke).toHaveCount(0);
      await expect(page.locator('footer')).toHaveCount(0);
      expect(warnings).toEqual([]);
    });
  }
}
