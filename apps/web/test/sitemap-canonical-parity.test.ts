import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  PUBLIC_ENTRYPOINTS,
  renderPublicEntrypoint,
} from '../scripts/generate-public-entrypoints.mjs';

const SITE_ORIGIN = 'https://health.sassmaker.com';

/** Extract every <loc> URL from the committed sitemap.xml. */
function readSitemapPaths(): string[] {
  const xml = readFileSync(resolve(process.cwd(), 'public/sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
    const url = new URL(match[1].trim());
    return url.pathname;
  });
}

describe('sitemap / canonical parity', () => {
  const sitemapPaths = readSitemapPaths();
  const entrypointPaths = PUBLIC_ENTRYPOINTS.map((entry) => entry.path);

  it('lists every public entrypoint path in the sitemap', () => {
    for (const path of entrypointPaths) {
      expect(sitemapPaths).toContain(path);
    }
  });

  it('has a matching public entrypoint for every non-homepage sitemap URL', () => {
    const nonHomePaths = sitemapPaths.filter((path) => path !== '/');
    for (const path of nonHomePaths) {
      expect(entrypointPaths).toContain(path);
    }
  });

  it('gives every sitemap-listed entrypoint a self-canonical, not the homepage canonical', () => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const homepageCanonical = `${SITE_ORIGIN}/`;

    for (const entry of PUBLIC_ENTRYPOINTS) {
      const html = renderPublicEntrypoint(indexHtml, entry);
      const selfCanonical = `${SITE_ORIGIN}${entry.path}`;

      const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)" \/>/);
      expect(canonicalMatch).not.toBeNull();
      expect(canonicalMatch?.[1]).toBe(selfCanonical);
      expect(canonicalMatch?.[1]).not.toBe(homepageCanonical);

      const ogUrlMatch = html.match(/<meta property="og:url" content="([^"]+)" \/>/);
      expect(ogUrlMatch).not.toBeNull();
      expect(ogUrlMatch?.[1]).toBe(selfCanonical);
    }
  });

  it('keeps the homepage canonical on the homepage entrypoint only', () => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const canonicalMatch = indexHtml.match(/<link rel="canonical" href="([^"]+)" \/>/);
    expect(canonicalMatch?.[1]).toBe(`${SITE_ORIGIN}/`);
  });

  it('loads Clarity only in generated public entrypoints', () => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const changelogHtml = renderPublicEntrypoint(indexHtml, PUBLIC_ENTRYPOINTS[0]);

    expect(indexHtml).not.toContain('clarity.ms/tag');
    expect(changelogHtml).toContain('https://www.clarity.ms/tag/');
  });

  it('initializes the Clarity command queue before the asynchronous tag can execute', () => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const html = renderPublicEntrypoint(indexHtml, PUBLIC_ENTRYPOINTS[0]);
    const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((match) =>
      match[1].includes('https://www.clarity.ms/tag/'),
    )?.[1];
    expect(bootstrap).toBeDefined();

    const window: Record<string, unknown> = {};
    const scripts: { async?: boolean; src?: string }[] = [];
    const context = {
      window,
      document: {
        createElement: () => ({}),
        head: {
          appendChild: (script: (typeof scripts)[number]) => {
            // The real tag reads clarity.v and enqueues start immediately.
            runInNewContext('window.clarity.v; window.clarity("start", { projectId: "test" });', {
              window,
            });
            scripts.push(script);
          },
        },
      },
    };
    runInNewContext(bootstrap!, context);
    expect(scripts).toEqual([{ async: true, src: 'https://www.clarity.ms/tag/y6bveiqm8k' }]);
    expect(typeof window.clarity).toBe('function');
    const clarity = window.clarity as { q: IArguments[] };
    expect(Array.from(clarity.q[0])).toEqual(['start', { projectId: 'test' }]);
  });
});
