import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { URL } from 'node:url';
import { publicRoutes, publicPages } from '../../worker/src/public-site.mjs';

test('every indexable built page has a source Markdown renderer', async () => {
  const dist = new URL('../dist/', import.meta.url);
  const registered = new Set(publicRoutes.map((route) => route.path));
  const found = new Set();
  for (const file of await readdir(dist)) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(new URL(file, dist), 'utf8');
    const path = file === 'index.html' ? '/' : `/${file.slice(0, -5)}`;
    if (/name="robots"[^>]*content="[^"]*noindex/.test(html)) {
      assert.ok(!registered.has(path), `Noindex route registered: ${path}`);
      continue;
    }
    assert.ok(registered.has(path), `Missing Markdown renderer: ${path}`);
    const route = publicRoutes.find((route) => route.path === path);
    assert.ok(html.includes('name="ai-summary"'));
    assert.ok(html.includes(`href="${route.md}"`));
    assert.equal(
      await readFile(new URL(new URL(route.md).pathname.slice(1), dist), 'utf8'),
      publicPages[path],
    );
    found.add(path);
  }
  assert.deepEqual(found, registered);
  const sitemap = await readFile(new URL('sitemap.xml', dist), 'utf8');
  assert.deepEqual(
    new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])),
    new Set(publicRoutes.map((route) => route.url)),
  );
  assert.ok((await readFile(new URL('llms-full.txt', dist), 'utf8')).length < 500000);
});
