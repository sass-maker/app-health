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

function fixtureInsights(report: ReturnType<typeof fixtureReport>) {
  return {
    date: report.date,
    timezone: 'Asia/Kolkata',
    generated_at: Date.now(),
    comparison_note: 'QA fixture: illustrative comparable gains, not live telemetry.',
    filter_note: 'QA fixture: source attribution is illustrative.',
    sources: [
      { name: 'Google', pageviews: 240, share: 0.6 },
      { name: 'github.com', pageviews: 100, share: 0.25 },
      { name: 'No referrer', pageviews: 60, share: 0.15 },
    ],
    products: report.products.map((product, index) => ({
      app_id: product.app_id,
      catalog_id: product.catalog_id,
      name: product.name,
      pageviews: product.browser_visitors === null ? null : product.browser_visitors * 2,
      top_sources: product.browser_visitors
        ? [{ name: 'Google', pageviews: product.browser_visitors * 2, share: 1 }]
        : [],
      sources_status:
        product.browser_visitors !== null
          ? 'measured'
          : product.browser_visitors_applicability === 'not_applicable'
            ? 'not_applicable'
            : 'unknown',
      source_estimated: false,
      previous_browser_visitors:
        product.browser_visitors === null ? null : Math.max(0, product.browser_visitors - 12),
      browser_change: product.browser_visitors === null ? null : 12,
      breakout: index > 18 && index < 22 && product.browser_visitors !== null,
      comparison_reason: 'QA fixture: illustrative comparison.',
    })),
  };
}

for (const width of [390, 768, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`two-minute briefing has truthful totals and all 55 projects at ${width}px ${theme}`, async ({
      page,
    }) => {
      const daily = fixtureReport();
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (selectedTheme) => localStorage.setItem('app-health-theme', selectedTheme),
        theme,
      );
      await page.route('**/v1/reports/daily-engagement?**', (route) =>
        route.fulfill({ json: daily }),
      );
      await page.route('**/v1/reports/portfolio-briefing?**', (route) =>
        route.fulfill({ json: fixtureInsights(daily) }),
      );
      await page.goto('/app?demo=populated#overview');
      // Explicit QA label stays in the screenshot; fixtures are never presented as production evidence.
      await expect(
        page.getByRole('heading', { name: 'Daily briefing', exact: true }),
      ).toBeVisible();
      const report = page.locator('#daily-engagement');
      await expect(report.getByRole('heading', { name: 'Where traffic came from' })).toBeVisible();
      await expect(report.getByRole('heading', { name: 'What moved' })).toBeVisible();
      const browserTotal = daily.products.reduce(
        (sum, product) => sum + (product.browser_visitors ?? 0),
        0,
      );
      await expect(
        report.getByText('Known browser counts', { exact: true }).locator('..'),
      ).toContainText(browserTotal.toLocaleString());
      await expect(
        report.getByText('Confirmed responses', { exact: true }).locator('..'),
      ).toContainText('9');
      await expect(
        report.getByText('Measured health issues', { exact: true }).locator('..'),
      ).toContainText('latest 24 hours');
      await expect(report.locator('tbody tr')).toHaveCount(55);
      const mobileProducts = report.locator('ul[aria-label="Portfolio project ledger"] > li');
      await expect(mobileProducts).toHaveCount(55);
      const actionProduct = daily.products.find((product) => product.cta_events.length > 0)!;
      const visibleRows = width < 1024 ? mobileProducts : report.locator('tbody tr');
      const actionRow = visibleRows.filter({
        has: page.getByText(actionProduct.catalog_id, { exact: true }),
      });
      const actionDisclosure = actionRow
        .locator('summary')
        .filter({ hasText: 'Actions and browsers' });
      await actionDisclosure.focus();
      await page.keyboard.press('Enter');
      for (const event of actionProduct.cta_events) {
        const browsers =
          event.unique_browsers === null
            ? 'Browser count unavailable'
            : `${event.unique_browsers} ${event.unique_browsers === 1 ? 'browser' : 'browsers'}`;
        await expect(
          actionRow.getByText(
            `${event.estimated ? 'Approx. ' : ''}${event.count} events · ${browsers}`,
            { exact: true },
          ),
        ).toBeVisible();
      }
      await page.keyboard.press('Enter');
      await expect(report.getByText('No referrer', { exact: true }).first()).toBeVisible();
      await report.evaluate((content) => {
        const notice = document.createElement('p');
        notice.setAttribute('role', 'note');
        notice.className = 'border-b px-5 py-2 text-xs text-amber-700 dark:text-amber-300';
        notice.textContent = 'QA preview · fixture counts for layout review, not live telemetry';
        content.prepend(notice);
      });
      if (width < 1024) {
        await mobileProducts.last().scrollIntoViewIfNeeded();
        await expect(mobileProducts.last()).toBeInViewport();
        await page.evaluate(() => window.scrollTo(0, 0));
      } else {
        const overflow = await report
          .locator('[data-slot="table-container"]')
          .evaluate((node) => node.scrollWidth - node.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
      }
      await checkReadability(page);
      const evidence = new URL('../../../.fleet/evidence/cta-browsers-20261002/', import.meta.url);
      mkdirSync(fileURLToPath(evidence), { recursive: true });
      await page.screenshot({
        fullPage: false,
        type: 'jpeg',
        quality: 88,
        path: fileURLToPath(new URL(`briefing-after-${width}-${theme}.jpg`, evidence)),
      });
      const sources = report
        .getByRole('heading', { name: 'Where traffic came from' })
        .locator('..')
        .locator('..')
        .locator('..');
      await sources
        .getByRole('button', { name: `Filter projects by Google source for ${daily.date}` })
        .click();
      await expect(report.getByText(/Showing projects where/)).toBeVisible();
      await expect(report.locator('tbody tr')).toHaveCount(
        daily.products.filter((product) => Boolean(product.browser_visitors)).length,
      );
      await report.getByRole('button', { name: 'Clear source filter' }).click();
      await expect(report.locator('tbody tr')).toHaveCount(55);
      await report.getByRole('button', { name: 'Show all 3 breakouts' }).click();
      await expect(report.getByText('Growth', { exact: true })).toHaveCount(3);
      await report.getByRole('button', { name: 'Show the top two' }).click();
      await expect(report.getByText('Growth', { exact: true })).toHaveCount(2);
      const search = report.getByRole('textbox', { name: /Search projects/ });
      await search.fill(daily.products[0].catalog_id);
      await expect(report.locator('tbody tr')).toHaveCount(1);
      await search.fill('');
      await expect(report.locator('tbody tr')).toHaveCount(55);
    });
  }
}
