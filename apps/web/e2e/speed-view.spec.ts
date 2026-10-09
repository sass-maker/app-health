import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SpeedReportV1 } from '@app-health/contracts';
import { speedFixture } from '../test/speed-fixture.js';
import { checkReadability } from './readability';

for (const width of [390, 768, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`workspace speed at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript((value) => localStorage.setItem('app-health-theme', value), theme);
      await page.route('**/v1/reports/speed?**', (route) => {
        const report = speedFixture();
        const query = new URL(route.request().url()).searchParams;
        report.range = query.get('range') as typeof report.range;
        report.class = query.get('class') as typeof report.class;
        if (report.class === 'api') report.budgets.vitals = null;
        expect(SpeedReportV1.safeParse(report).success).toBe(true);
        return route.fulfill({ json: report });
      });
      await page.goto('/app?demo=populated#speed');
      await expect(page.getByRole('heading', { name: 'Speed', exact: true })).toBeVisible();
      await expect(page.getByRole('tablist', { name: 'Project reports' })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Environment' })).toHaveCount(0);
      const report = page.locator('#speed-view');
      const table = report.getByRole('table', { name: 'Product speed', exact: true });
      await expect(table.locator('tbody > tr')).toHaveCount(4);
      await expect(report.getByText(/Samples, not total traffic/)).toContainText(
        'Rejected events: 3',
      );
      await report.evaluate((content) => {
        const notice = document.createElement('p');
        notice.setAttribute('role', 'note');
        notice.className = 'border-b pb-3 text-xs text-muted-foreground';
        notice.textContent = 'QA preview · fixture samples for layout review, not live telemetry';
        content.prepend(notice);
      });
      await checkReadability(page);
      if (width >= 1440) {
        const overflow = await table
          .locator('..')
          .evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
      }
      const evidence = new URL('../../../.fleet/evidence/speed-view/', import.meta.url);
      mkdirSync(fileURLToPath(evidence), { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: fileURLToPath(new URL(`speed-${width}-${theme}.png`, evidence)),
      });
      const atlas = table.getByRole('button', { name: /routes for Atlas$/ });
      await atlas.focus();
      await page.keyboard.press('Enter');
      await expect(atlas).toHaveAttribute('aria-expanded', 'true');
      const routes = report.getByRole('table', { name: 'Atlas server routes' });
      await expect(routes.getByText('/api/articles/:id')).toBeVisible();
      await expect(routes.getByText('HIT: 18')).toBeVisible();
      await checkReadability(page);
      await page.screenshot({
        fullPage: true,
        path: fileURLToPath(new URL(`routes-${width}-${theme}.png`, evidence)),
      });
      await atlas.press('Enter');
      const sorter = table.getByRole('button', { name: 'Sort by LCP p75' });
      await sorter.click();
      await expect(sorter.locator('..')).toHaveAttribute('aria-sort', 'ascending');
      await expect(table.locator('tbody > tr').first()).toContainText('Beacon');
      await sorter.click();
      await expect(sorter.locator('..')).toHaveAttribute('aria-sort', 'descending');
      await expect(table.locator('tbody > tr').last()).toContainText('Drift');
      await report.getByRole('textbox', { name: 'Search products' }).fill('Atlas');
      await expect(table.locator('tbody > tr')).toHaveCount(1);
      await report.getByRole('textbox', { name: 'Search products' }).fill('');
      await report.getByRole('combobox', { name: 'Speed state' }).click();
      await page.getByRole('option', { name: 'Insufficient', exact: true }).click();
      await expect(table.locator('tbody > tr')).toHaveCount(1);
      await expect(table.locator('tbody > tr')).toContainText('Cedar');
      await report.getByRole('combobox', { name: 'Performance class' }).click();
      await page.getByRole('option', { name: 'API', exact: true }).click();
      await expect(report.getByText(/Samples, not total traffic/)).toContainText(
        'Budgets (api): no Web Vitals budget',
      );
      if (width >= 1440) {
        await page.getByRole('button', { name: 'Daily briefing', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: 'Daily briefing', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Speed', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Speed', exact: true })).toBeVisible();
      }
    });
  }
}
