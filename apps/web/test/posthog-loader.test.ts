import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
  'utf8',
);

describe('PostHog browser loader', () => {
  it('loads array.js from the static assets host, not the retired ingestion path', () => {
    // https://us.i.posthog.com/array.js is a 404; the queued _i init is then
    // never consumed and page_view events are silently dropped.
    expect(indexHtml).toContain('https://us-assets.i.posthog.com/static/array.js');
    expect(indexHtml).not.toContain('us.i.posthog.com/array.js');
  });
});
