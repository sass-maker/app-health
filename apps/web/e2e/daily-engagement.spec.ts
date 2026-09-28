import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkReadability } from './readability';

const products = [
  { id: 'codevetter', name: 'CodeVetter', visitors: 146, feedback: 2, waitlist: 7, cta: 32 },
  { id: 'anchor', name: 'Anchor', visitors: 92, feedback: 0, waitlist: 3, cta: 18 },
  { id: 'reader', name: 'Reader', visitors: null, feedback: null, waitlist: null, cta: null },
];

for (const width of [390, 768, 1440]) {
  test(`daily engagement overview stays legible at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/v1/reports/daily-engagement?**', (route) => {
      const now = Date.now();
      const date = new Date(now + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
      return route.fulfill({
        json: {
          schema: 'app-health.daily-engagement.v1',
          schema_version: 1,
          generated_at: now,
          date,
          timezone: 'Asia/Kolkata',
          from: now - 86_400_000,
          to: now,
          product_count: products.length,
          sampled: false,
          notes: ['Missing products remain unknown until they are imported and instrumented.'],
          products: products.map((item) => ({
            catalog_id: item.id,
            app_id: `app-${item.id}`,
            name: item.name,
            browser_visitors: item.visitors,
            cta_events: item.cta === null ? [] : [{ name: 'primary_action', count: item.cta }],
            cta_status: item.cta === null ? 'unknown' : 'measured',
            feedback_submitted: item.feedback,
            newsletter_joins: null,
            waitlist_joins: item.waitlist,
            native_sessions: null,
            api_activity: null,
            freshness: { browser_last_seen: null, log_last_seen: null },
            coverage: item.visitors === null ? 'unknown' : 'partial',
          })),
        },
      });
    });
    await page.goto('/app?demo=populated#overview');
    await expect(page.getByRole('heading', { name: 'Daily engagement' })).toBeVisible();
    await expect(page.getByText('3/55 imported')).toBeVisible();
    await expect(page.getByText('CodeVetter').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading Watchtower' })).toHaveCount(0);
    await checkReadability(page);
    const evidence = new URL('../../../.fleet/evidence/daily-engagement/', import.meta.url);
    mkdirSync(evidence, { recursive: true });
    const screenshot = await page.screenshot({
      fullPage: true,
      path: fileURLToPath(new URL(`after-${width}.png`, evidence)),
    });
    await testInfo.attach('daily-engagement', {
      body: screenshot,
      contentType: 'image/png',
    });
  });
}
