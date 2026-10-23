/* v8 ignore start -- build output is verified by browser acceptance. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import Beasties from 'beasties';

const root = fileURLToPath(new URL('../', import.meta.url));
const criticalCss = new Beasties({
  path: fileURLToPath(new URL('../dist/', import.meta.url)),
  publicPath: '/',
  preload: false,
  pruneSource: false,
  reduceInlineStyles: false,
  inlineFonts: false,
  logLevel: 'warn',
});
const server = await createServer({
  root,
  configFile: false,
  mode: 'production',
  appType: 'custom',
  plugins: [react()],
  server: { middlewareMode: true, hmr: false, watch: null },
  ssr: { noExternal: ['@saas-maker/ui'] },
});
try {
  for (const [name, componentName, file] of [
    ['landing', 'LandingPage', 'index.html'],
    ['changelog', 'Changelog', 'changelog.html'],
  ]) {
    const module = await server.ssrLoadModule(`/src/${componentName}.tsx`);
    const markup = renderToString(createElement(module[componentName]));
    const output = new URL(`../dist/${file}`, import.meta.url);
    const html = await readFile(output, 'utf8');
    const start = html.indexOf('<div id="root">');
    const end = html.lastIndexOf('</div>');
    if (start < 0 || end < start) throw new Error(`${name} root is missing from built HTML`);
    const rendered = `${html.slice(0, start)}<div id="root" data-prerendered="${name}">${markup}</div>${html.slice(end + 6)}`;
    await writeFile(output, name === 'changelog' ? await criticalCss.process(rendered) : rendered);
  }
} finally {
  await server.close();
}
/* v8 ignore stop */
