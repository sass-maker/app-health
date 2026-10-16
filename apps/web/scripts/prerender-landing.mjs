/* v8 ignore start -- build output is verified by browser acceptance. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
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
  const { LandingPage } = await server.ssrLoadModule('/src/LandingPage.tsx');
  const markup = renderToString(createElement(LandingPage));
  const output = new URL('../dist/index.html', import.meta.url);
  const html = await readFile(output, 'utf8');
  const start = html.indexOf('<div id="root">');
  const end = html.lastIndexOf('</div>');
  if (start < 0 || end < start) throw new Error('Landing root is missing from built HTML');
  await writeFile(
    output,
    `${html.slice(0, start)}<div id="root" data-prerendered="landing">${markup}</div>${html.slice(end + 6)}`,
  );
} finally {
  await server.close();
}
/* v8 ignore stop */
