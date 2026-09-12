import { expect, type Page } from '@playwright/test';

/** Check actual browser-composited text colors; jsdom cannot detect CSS regressions. */
export async function checkReadability(page: Page) {
  const failures = await page
    .locator('main,[role="dialog"],[role="alertdialog"]')
    .evaluateAll((mains) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      const rgba = (color: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].map((n, i) => (i === 3 ? n / 255 : n));
      };
      const over = (fg: number[], bg: number[]) => [
        ...fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])),
        1,
      ];
      const luminance = (rgb: number[]) =>
        rgb.slice(0, 3).reduce((sum, n, i) => {
          const c = n / 255;
          return (
            sum +
            (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
          );
        }, 0);
      const issues: { text: string; ratio: number; color: string; background: number[] }[] = [];
      for (const main of mains) {
        for (const el of main.querySelectorAll(
          'h1,h2,h3,p,span,strong,small,td,th,label,button,a,code,dt,dd',
        )) {
          const style = getComputedStyle(el);
          if (
            !el.getClientRects().length ||
            style.visibility !== 'visible' ||
            el.matches(':disabled')
          )
            continue;
          if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) continue;
          const parents: Element[] = [];
          for (let p: Element | null = el; p; p = p.parentElement) parents.unshift(p);
          if (parents.some((p) => Number(getComputedStyle(p).opacity) < 0.9)) continue;
          const bg = parents.reduce(
            (color, p) => over(rgba(getComputedStyle(p).backgroundColor), color),
            [255, 255, 255, 1],
          );
          const fg = over(rgba(style.color), bg);
          const light = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
          const ratio = (light[0] + 0.05) / (light[1] + 0.05);
          const large =
            parseFloat(style.fontSize) >= 24 ||
            (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
          if (ratio + 0.02 < (large ? 3 : 4.5))
            issues.push({
              text: el.textContent!.trim().slice(0, 80),
              ratio: Math.round(ratio * 100) / 100,
              color: style.color,
              background: bg,
            });
        }
      }
      return issues;
    });
  expect(failures, 'Visible main content must meet text contrast in the rendered theme').toEqual(
    [],
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
