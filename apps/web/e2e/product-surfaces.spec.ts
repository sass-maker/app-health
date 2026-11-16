import { expect, test } from '@playwright/test';
import { checkReadability } from './readability';
import { receivedFixture } from './received-fixture';

for (const theme of ['dark', 'light']) {
  test(`late footer styles preserve tablet geometry ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1000 });
    await page.addInitScript((value) => localStorage.setItem('app-health-theme', value), theme);
    let releaseFooter!: () => void;
    const footerReady = new Promise<void>((resolve) => {
      releaseFooter = resolve;
    });
    await page.route('**/footer.css', async (route) => {
      await footerReady;
      await route.continue();
    });
    const loaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/footer.css' && response.ok(),
    );
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    await expect
      .poll(() =>
        heading.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      )
      .toBeGreaterThan(32);
    await heading.evaluate(async (element) => {
      const style = getComputedStyle(element);
      await document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`);
    });
    const before = await heading.boundingBox();
    releaseFooter();
    await loaded;
    await expect
      .poll(() =>
        page
          .locator('link[href="/footer.css"]')
          .evaluate((link) => Boolean((link as HTMLLinkElement).sheet)),
      )
      .toBe(true);
    await expect.poll(() => heading.boundingBox()).toEqual(before);
    const subscribe = page.getByRole('button', { name: /^subscribe$/i });
    await expect(subscribe).toBeVisible();
    await expect
      .poll(() =>
        subscribe.evaluate(
          (button) =>
            button.getBoundingClientRect().right -
            button.closest('form')!.getBoundingClientRect().right,
        ),
      )
      .toBeLessThanOrEqual(1);
    const footer = page.locator('studio-footer');
    const styles = await footer.evaluate((element) => {
      const mode = element.getAttribute('data-mode');
      const parent = element.parentElement!;
      const font = parent.style.getPropertyValue('font-family');
      const priority = parent.style.getPropertyPriority('font-family');
      const pageStyle = () => {
        const style = getComputedStyle(document.documentElement);
        return { color: style.color, background: style.backgroundColor, font: style.fontFamily };
      };
      const reading = () => {
        const style = getComputedStyle(element);
        return { background: style.getPropertyValue('--background'), color: style.color };
      };
      const beforePage = pageStyle();
      const beforeFont = getComputedStyle(element).fontFamily;
      try {
        element.setAttribute('data-mode', 'light');
        const light = reading();
        element.setAttribute('data-mode', 'dark');
        const dark = reading();
        parent.style.setProperty('font-family', '"Courier New", monospace', 'important');
        return {
          light,
          dark,
          beforePage,
          afterPage: pageStyle(),
          beforeFont,
          isolatedFont: getComputedStyle(element).fontFamily,
          parentFont: getComputedStyle(parent).fontFamily,
        };
      } finally {
        if (mode === null) element.removeAttribute('data-mode');
        else element.setAttribute('data-mode', mode);
        if (font) parent.style.setProperty('font-family', font, priority);
        else parent.style.removeProperty('font-family');
      }
    });
    expect(styles.dark.background).not.toBe(styles.light.background);
    expect(styles.dark.color).not.toBe(styles.light.color);
    expect(styles.afterPage).toEqual(styles.beforePage);
    expect(styles.beforeFont).toContain('Inter');
    expect(styles.parentFont).toContain('Courier New');
    expect(styles.isolatedFont).toBe(styles.beforeFont);
    await expect.poll(() => heading.boundingBox()).toEqual(before);
  });
}

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
        const footerStyle =
          surface === 'landing'
            ? page.waitForResponse(
                (response) => new URL(response.url()).pathname === '/footer.css' && response.ok(),
              )
            : Promise.resolve();
        await page.goto(url);
        await report;
        await footerStyle;
        if (surface !== 'landing')
          await expect(
            page.locator('script[src*="project-strip.js"], script[src*="ai-chat-footer.js"]'),
          ).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
        await checkReadability(page);
        await expect(page.locator('footer')).toHaveCount(surface === 'landing' ? 1 : 0);
        if (surface === 'landing') {
          const navigation = page.getByRole('navigation', { name: 'Main navigation' });
          const dashboardLink = page.getByRole('link', { name: 'open dashboard', exact: true });
          if (width >= 768) {
            await expect(navigation).toBeVisible();
            await expect(dashboardLink).toBeVisible();
          } else {
            await expect(navigation).toBeHidden();
            await expect(dashboardLink).toBeHidden();
          }
        }
        await testInfo.attach('rendered-view', {
          body: await page.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      });
    }
  }
}
