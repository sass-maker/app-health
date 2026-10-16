import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { LandingPage } from '../src/LandingPage.js';

it('renders the complete public landing without browser globals or private workspace content', () => {
  const browserDocument = document;
  const browserWindow = window;
  let html: string;
  try {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('window', undefined);
    html = renderToString(<LandingPage />);
  } finally {
    vi.stubGlobal('document', browserDocument);
    vi.stubGlobal('window', browserWindow);
  }
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('see what people do.');
  expect(html).toContain('know what to improve.');
  expect(html).toContain('href="/app"');
  expect(html).toContain('id="integration"');
  expect(html).toContain('Illustrative web analytics preview');
  expect(html).not.toContain('owner key');
  expect(html).not.toContain('Switched to client rendering');
});
