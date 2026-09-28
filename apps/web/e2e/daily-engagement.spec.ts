import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkReadability } from './readability';

interface BriefingProduct {
  catalog_id: string;
  name: string;
  browser_applicable: boolean;
  native_applicable: boolean;
  server_requests_applicable: boolean;
  newsletter_applicable: boolean;
  waitlist_applicable: boolean;
  cta_event: string | null;
  cta_measured: boolean;
  cta_not_applicable: boolean;
}

const catalogFixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/daily-briefing-catalog-2026-09-29.json', import.meta.url),
    'utf8',
  ),
) as { snapshot_date: string; products: BriefingProduct[] };

const asiaOffset = 330 * 60_000;

function latestCompletedIndiaDay() {
  return new Date(Date.now() + asiaOffset - 86_400_000).toISOString().slice(0, 10);
}

function fixtureReport() {
  const date = latestCompletedIndiaDay();
  const from = Date.parse(`${date}T00:00:00.000+05:30`);
  const measuredVisitors = new Set(
    catalogFixture.products.filter((item) => item.browser_applicable).slice(0, 32),
  );
  const measuredActions = new Set(
    catalogFixture.products.filter((item) => item.cta_measured).slice(0, 35),
  );
  let feedbackReceipts = 0;
  let newsletterReceipt = false;

  return {
    schema: 'app-health.daily-engagement.v1',
    schema_version: 1,
    generated_at: Date.now(),
    date,
    timezone: 'Asia/Kolkata',
    from,
    to: from + 86_400_000,
    product_count: 55,
    sampled: false,
    notes: [
      'QA preview fixture: counts are synthetic for responsive layout review, not live App Health telemetry.',
    ],
    products: catalogFixture.products.map((item, index) => {
      const hasVisitorEvidence = measuredVisitors.has(item);
      const hasActionEvidence = measuredActions.has(item);
      const hasFeedbackReceipt = feedbackReceipts < 8;
      const hasNewsletterReceipt = !newsletterReceipt && item.newsletter_applicable;
      feedbackReceipts += Number(hasFeedbackReceipt);
      newsletterReceipt ||= hasNewsletterReceipt;
      const firstBrowserSource = hasVisitorEvidence
        ? [...measuredVisitors].findIndex((candidate) => candidate.catalog_id === item.catalog_id)
        : -1;

      return {
        catalog_id: item.catalog_id,
        app_id: `qa-${item.catalog_id}`,
        name: item.name,
        browser_visitors: hasVisitorEvidence ? (firstBrowserSource === 0 ? 0 : index + 2) : null,
        browser_visitors_applicability: item.browser_applicable ? 'applicable' : 'not_applicable',
        browser_visitors_unknown_reason:
          !hasVisitorEvidence && item.browser_applicable
            ? 'no_qualifying_analytics_receipt'
            : undefined,
        cta_events:
          hasActionEvidence && item.cta_event
            ? [
                {
                  name: item.cta_event,
                  count: index % 5 === 0 ? 0 : (index % 4) + 1,
                  unique_browsers: index % 5 === 0 ? 0 : null,
                  estimated: index % 5 !== 0,
                },
              ]
            : [],
        cta_status: hasActionEvidence
          ? 'measured'
          : item.cta_not_applicable
            ? 'not_applicable'
            : 'unknown',
        feedback_submitted: hasFeedbackReceipt ? 1 : null,
        newsletter_joins: hasNewsletterReceipt ? 1 : null,
        newsletter_applicability: item.newsletter_applicable ? 'applicable' : 'not_applicable',
        waitlist_joins: item.waitlist_applicable ? null : 0,
        waitlist_applicability: item.waitlist_applicable ? 'applicable' : 'not_applicable',
        native_sessions: null,
        native_sessions_applicability: item.native_applicable ? 'applicable' : 'not_applicable',
        api_activity: null,
        server_requests_applicability: item.server_requests_applicable
          ? 'applicable'
          : 'not_applicable',
        freshness: {
          browser_last_seen: hasVisitorEvidence ? from + 60_000 : null,
          log_last_seen: hasFeedbackReceipt || hasNewsletterReceipt ? from + 120_000 : null,
        },
        coverage:
          hasVisitorEvidence || hasActionEvidence || hasFeedbackReceipt || hasNewsletterReceipt
            ? 'partial'
            : 'unknown',
      };
    }),
  };
}

for (const width of [390, 768, 1440]) {
  test(`daily briefing evidence and 55-product inventory fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/v1/reports/daily-engagement?**', (route) =>
      route.fulfill({ json: fixtureReport() }),
    );
    await page.goto('/app?demo=populated#overview');

    await expect(page.getByRole('heading', { name: 'Daily briefing', exact: true })).toBeVisible();
    await expect(page.getByText('55/55 imported')).toBeVisible();
    const report = page.locator('#daily-engagement');
    await expect(
      report.getByRole('button', { name: /Visited 32 products with browser visitor evidence/ }),
    ).toBeVisible();
    await expect(
      report.getByRole('button', {
        name: /Chose an action 35 products with measured primary actions/,
      }),
    ).toBeVisible();
    await expect(report.getByText('Feedback: 8')).toBeVisible();
    await expect(report.getByText('Newsletter joins: 1')).toBeVisible();
    await expect(report.getByText('Not applicable').first()).toBeVisible();

    await report.locator('[data-slot="card-content"]').evaluate((content) => {
      const notice = document.createElement('p');
      notice.setAttribute('role', 'note');
      notice.className =
        'rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300';
      notice.textContent = 'QA preview · fixture counts for layout review, not live telemetry';
      content.prepend(notice);
    });
    await expect(page.getByRole('note')).toContainText('not live telemetry');
    await expect(report.locator('tbody tr')).toHaveCount(55);
    const mobileProducts = report.locator('ul[aria-label="Daily engagement products"] > li');
    await expect(mobileProducts).toHaveCount(55);
    if (width < 1280) {
      const firstMeasuredVisitor = catalogFixture.products.find((item) => item.browser_applicable)!;
      const unknownVisitor = catalogFixture.products
        .filter((item) => item.browser_applicable)
        .slice(32)[0];
      const zeroCard = mobileProducts.filter({ hasText: firstMeasuredVisitor.catalog_id });
      await expect(zeroCard.locator('dd').filter({ hasText: /^0$/ }).first()).toBeVisible();
      if (unknownVisitor) {
        const unknownCard = mobileProducts.filter({ hasText: unknownVisitor.catalog_id });
        await expect(unknownCard.getByText('Unknown', { exact: true }).first()).toBeVisible();
      }
      const lastCard = mobileProducts.last();
      await lastCard.scrollIntoViewIfNeeded();
      await expect(lastCard).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    if (width === 1440) {
      const table = report.locator('[data-slot="table-container"]');
      const tableWidth = await table.evaluate((node) => ({
        content: node.scrollWidth,
        visible: node.clientWidth,
      }));
      expect(tableWidth.content).toBeGreaterThan(tableWidth.visible);
      await table.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      await expect(report.getByRole('columnheader', { name: 'Server requests' })).toBeVisible();
      const serverHeaderIsInView = await report
        .getByRole('columnheader', { name: 'Server requests' })
        .evaluate((header) => {
          const headerBounds = header.getBoundingClientRect();
          const containerBounds = header
            .closest('[data-slot="table-container"]')!
            .getBoundingClientRect();
          return (
            headerBounds.left >= containerBounds.left && headerBounds.right <= containerBounds.right
          );
        });
      expect(serverHeaderIsInView).toBe(true);
      await table.evaluate((node) => {
        node.scrollLeft = 0;
      });
    }
    await checkReadability(page);

    const evidence = new URL(
      '../../../.fleet/evidence/daily-briefing-2026-09-29/',
      import.meta.url,
    );
    mkdirSync(fileURLToPath(evidence), { recursive: true });
    await page.screenshot({
      fullPage: false,
      type: 'jpeg',
      quality: 88,
      path: fileURLToPath(new URL(`after-${width}.jpg`, evidence)),
    });

    await report.getByRole('button', { name: /Chose an action/ }).click();
    await expect(
      report.getByText(/Showing 35 of 55 products with measured primary actions/),
    ).toBeVisible();
    await expect(report.getByText(/Unknown sources remain in the full inventory/)).toBeVisible();
    await report.getByRole('button', { name: 'Show all products' }).click();
    await expect(report.locator('tbody tr')).toHaveCount(55);
  });
}
