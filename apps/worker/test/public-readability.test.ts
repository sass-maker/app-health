import { expect, it } from 'vitest';
import worker from '../src/index.js';
import { handleAgentEdge } from '../src/agent-edge.mjs';
import { publicPages, publicRoutes, publicHtmlResponse } from '../src/public-site.mjs';
import copy from '../../web/src/public-copy.json';

const origin = 'https://health.sassmaker.com';
it('serves complete public source content without any telemetry or owner bindings', async () => {
  for (const route of publicRoutes) {
    for (const [path, accept] of [
      [new URL(route.md).pathname, '*/*'],
      [`/api/md${route.path}`, '*/*'],
      [route.path, 'text/markdown'],
    ]) {
      const response = await worker.fetch(
        new Request(`${origin}${path}?account=private-sentinel`, {
          headers: {
            accept,
            cookie: 'owner=private-sentinel',
            authorization: 'Bearer private-sentinel',
          },
        }),
        {},
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(publicPages[route.path]);
      expect(response.headers.get('Content-Location')).toBe(route.url);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
      const head = await worker.fetch(
        new Request(origin + path, { method: 'HEAD', headers: { accept } }),
        {},
      );
      expect(await head.text()).toBe('');
      expect(head.headers.get('X-Markdown-Tokens')).toBe(response.headers.get('X-Markdown-Tokens'));
    }
  }
  for (const field of [
    Object.values(copy.hero),
    Object.values(copy.preview),
    Object.values(copy.productSection),
    Object.values(copy.integration),
    Object.values(copy.status),
  ].flat())
    expect(publicPages['/']).toContain(field.trim());
  for (const [title, description] of copy.privacy.sections) {
    expect(publicPages['/privacy']).toContain(title);
    expect(publicPages['/privacy']).toContain(description);
  }
  expect(publicPages['/']).toContain('illustrative data');
  expect(publicPages['/']).toContain(copy.integrationSnippet);
  for (const feature of copy.features) expect(publicPages['/']).toContain(feature.body);
  for (const entry of copy.entries)
    for (const outcome of entry.outcomes) expect(publicPages['/changelog']).toContain(outcome);
});

it('keeps operator, shared analytics and telemetry views outside the public registry', async () => {
  for (const path of [
    '/app.md',
    '/live.md',
    '/api/md/app',
    '/api/md/live',
    '/api/md/v1/analytics',
    '/missing.md',
  ]) {
    expect((await worker.fetch(new Request(origin + path), {})).status).toBe(404);
  }
  expect(await handleAgentEdge(new Request(origin + '/v1/analytics.md'))).toBeNull();
  expect(
    await handleAgentEdge(
      new Request(origin + '/v1/health', { headers: { accept: 'text/markdown' } }),
    ),
  ).toBeNull();
  const assets = {
    fetch: async () =>
      new Response('<html>public</html>', { headers: { 'Content-Type': 'text/html' } }),
  };
  for (const path of ['/app', '/live', '/v1/analytics'])
    expect(await publicHtmlResponse(new Request(origin + path), assets)).toBeNull();
  for (const accept of [
    '*/*',
    'text/markdown;q=0',
    'text/markdown,text/html',
    'text/markdown;q=0.1,text/html;q=1',
  ]) {
    const response = await worker.fetch(new Request(origin, { headers: { accept } }), {
      ASSETS: assets,
    });
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Link')).toContain('/index.md');
  }
  const options = await worker.fetch(
    new Request(origin + '/api/md/changelog', { method: 'OPTIONS' }),
    {},
  );
  expect(options.status).toBe(204);
  expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');
});

it('keeps unknown canonical origins local and declares public machine endpoint exceptions', async () => {
  for (const path of ['/api/md//evil.example/x', '//evil.example/x.md']) {
    const response = await handleAgentEdge(new Request(origin + path));
    expect(response?.status).toBe(404);
    expect(new URL(response!.headers.get('Content-Location')!).origin).toBe(origin);
    expect(response?.headers.get('Link')).toContain(`<${origin}/`);
  }
  const response = await handleAgentEdge(new Request(`${origin}/ai.txt`));
  expect(await response?.text()).toContain('public-machine-endpoints: /api/ai, /api/md/*');
});
