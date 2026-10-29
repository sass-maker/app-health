import { expect, test } from '@playwright/test';

test.describe('dashboard with JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false });
  for (const width of [390, 768, 1440]) {
    test(`explains the requirement without a permanent busy state at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/app');
      await expect(page.getByText('JavaScript is required to open App Health.')).toBeVisible();
      await expect(page.getByText('JavaScript is required to open App Health.')).toBeInViewport();
      await expect(page.locator('main[aria-busy="true"]')).toHaveCount(1);
      await expect(page.locator('[aria-busy="true"]')).toBeHidden();
      await expect(page.getByRole('link', { name: 'App Health home', exact: true })).toBeVisible();
    });
  }
});

for (const width of [390, 768, 1440]) {
  test(`dashboard document shows a useful placeholder without JavaScript at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    let documentRequestId = '';
    const dataEvents: { requestId: string; timestamp: number; dataLength: number }[] = [];
    cdp.on('Network.responseReceived', (event) => {
      if (event.type === 'Document') documentRequestId = event.requestId;
    });
    cdp.on('Network.dataReceived', (event) => dataEvents.push(event));
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 562.5,
      downloadThroughput: (1474.56 * 1024) / 8,
      uploadThroughput: (675 * 1024) / 8,
      connectionType: 'cellular4g',
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.route('**/*', (route) =>
      ['script', 'stylesheet'].includes(route.request().resourceType())
        ? route.abort()
        : route.continue(),
    );
    await page.goto('/app');
    const placeholder = page.getByRole('main', { name: 'Loading workspace project', exact: true });
    await expect(placeholder).toBeVisible();
    await expect(page.getByRole('link', { name: 'App Health home', exact: true })).toBeVisible();
    await expect(placeholder.getByRole('status')).toHaveText('loading the workspace');
    const geometry = await placeholder.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      return {
        width: rectangle.width,
        height: rectangle.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        placeholders: element.querySelectorAll('[aria-hidden="true"]').length,
      };
    });
    expect(geometry.width).toBeGreaterThan(width * 0.8);
    expect(geometry.height).toBeGreaterThan(150);
    expect(geometry.overflow).toBe(false);
    expect(geometry.placeholders).toBeGreaterThanOrEqual(3);
    await expect
      .poll(() =>
        page.evaluate(() => performance.getEntriesByName('first-contentful-paint').length),
      )
      .toBe(1);
    const timing = await page.evaluate(() => {
      const navigation = performance.getEntriesByType(
        'navigation',
      )[0] as PerformanceNavigationTiming;
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      return {
        responseStart: navigation.responseStart,
        responseEnd: navigation.responseEnd,
        firstContentfulPaint: paint.startTime,
        afterResponseStart: paint.startTime - navigation.responseStart,
        afterCompleteHtml: paint.startTime - navigation.responseEnd,
      };
    });
    const metrics = await cdp.send('Performance.getMetrics');
    const navigationStart = metrics.metrics.find(
      (metric) => metric.name === 'NavigationStart',
    )!.value;
    const firstData = dataEvents.find(
      (event) => event.requestId === documentRequestId && event.dataLength > 0,
    );
    expect(firstData).toBeDefined();
    const firstHtmlData = (firstData!.timestamp - navigationStart) * 1000;
    const afterFirstHtmlData = timing.firstContentfulPaint - firstHtmlData;
    await testInfo.attach('loading-timing', {
      body: JSON.stringify({
        width,
        cpuMultiplier: 4,
        requestLatencyMs: 562.5,
        cacheDisabled: true,
        firstHtmlData,
        afterFirstHtmlData,
        ...timing,
      }),
      contentType: 'application/json',
    });
    expect(afterFirstHtmlData).toBeGreaterThanOrEqual(-1);
    expect(afterFirstHtmlData).toBeLessThanOrEqual(300);
    await page.screenshot({ path: testInfo.outputPath('initial-placeholder.png') });
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`dashboard stylesheet ${outcome} preserves a useful startup state`, async ({ page }) => {
    let shouldFail = outcome === 'failure';
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    let developmentDocument = false;
    let sessionReads = 0;
    await page.route('**/v1/apps', (route) => {
      sessionReads += 1;
      return route.fulfill({ status: 401, json: { error: 'sign in required' } });
    });
    await page.route('**/v1/account/config', (route) => route.fulfill({ json: { google: true } }));
    await page.route('**/dashboard-startup.css', async (route) => {
      requested = true;
      await hold;
      if (shouldFail) return route.abort();
      return route.fulfill({ contentType: 'text/css', body: 'body { --dashboard-ready: 1; }' });
    });
    await page.route('**/app?**', async (route) => {
      const response = await route.fetch();
      const document = await response.text();
      developmentDocument = document.includes('/src/main.tsx');
      const html = document.replace(
        '</head>',
        '<link data-dashboard-style rel="stylesheet" media="print" href="/dashboard-startup.css" onload="this.media=\'all\'" onerror="this.dataset.dashboardStyleError=\'true\'" /></head>',
      );
      await route.fulfill({ response, body: html });
    });
    await page.goto('/app?project=startup-fixture#backend', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => requested).toBe(true);
    await expect(
      page.getByRole('main', { name: 'Loading workspace project', exact: true }),
    ).toBeVisible();
    expect(sessionReads).toBe(0);
    async function expectReady() {
      // Vite's local-owner mode intentionally bypasses the production sign-in screen.
      if (developmentDocument) {
        await expect(page.getByText('project link unavailable', { exact: true })).toBeVisible();
        expect(sessionReads).toBeGreaterThanOrEqual(1);
      } else {
        await expect(
          page.getByRole('button', { name: 'continue with Google', exact: true }),
        ).toBeVisible();
        expect(sessionReads).toBe(1);
      }
      await expect(page.locator('[data-initial-dashboard-shell]')).toHaveCount(0);
    }
    release();
    if (outcome === 'success') {
      await expectReady();
    } else {
      await expect(page.getByRole('status')).toHaveText('could not load the workspace. try again.');
      await expect(page.getByRole('button', { name: 'try again', exact: true })).toBeVisible();
      await expect(
        page.getByRole('main', { name: 'Loading workspace project', exact: true }),
      ).toHaveAttribute('aria-busy', 'false');
      expect(sessionReads).toBe(0);
      shouldFail = false;
      await page.getByRole('button', { name: 'try again', exact: true }).click();
      await expect(page).toHaveURL(/\/app\?project=startup-fixture#backend$/);
      await expectReady();
    }
  });
}
