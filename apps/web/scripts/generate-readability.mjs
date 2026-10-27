import * as prettier from 'prettier';
import { fileURLToPath, URL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import {
  publicIdentity,
  publicManifest,
  publicRoutes,
  publicPages,
  publicRobots,
  publicSitemap,
} from '../../worker/src/public-site.mjs';
import {
  buildAiTxt,
  buildFullMarkdown,
  buildMarkdownIndex,
} from '../../worker/src/agent-surfaces/documents.mjs';

const publicFile = (name) => new URL(`../public/${name}`, import.meta.url);
for (const route of publicRoutes) {
  await writeFile(publicFile(new URL(route.md).pathname.slice(1)), publicPages[route.path]);
}
await writeFile(publicFile('llms.txt'), buildMarkdownIndex(publicManifest, publicRoutes));
await writeFile(
  publicFile('llms-full.txt'),
  (await buildFullMarkdown(publicManifest, publicRoutes, (path) => publicPages[path])).replace(
    /^Generated: \d{4}-\d{2}-\d{2}$/m,
    `Source updated: ${publicManifest.updatedAt}`,
  ),
);
await writeFile(publicFile('ai.txt'), buildAiTxt(publicManifest, publicRoutes));
await writeFile(publicFile('robots.txt'), publicRobots);
await writeFile(publicFile('sitemap.xml'), publicSitemap);

// The maintained HTML entrypoint keeps its layout/scripts; all public identity
// metadata is refreshed from the same source as the page and Markdown.
const indexFile = new URL('../index.html', import.meta.url);
let html = await readFile(indexFile, 'utf8');
const escape = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
for (const attribute of [
  'name="description"',
  'property="og:description"',
  'name="twitter:description"',
]) {
  html = html.replace(
    new RegExp(`(<meta\\s+${attribute}\\s+content=")[^"]*(")`),
    `$1${escape(publicIdentity.summary)}$2`,
  );
}
html = html
  .replace(/<meta\b[^>]*name="ai-summary"[^>]*>\s*/g, '')
  .replace(/<link\b[^>]*rel="alternate"[^>]*type="text\/markdown"[^>]*>\s*/g, '');
html = html.replace(
  '</head>',
  `<meta name="ai-summary" content="${escape(publicIdentity.summary)}" />\n<link rel="alternate" type="text/markdown" href="${publicIdentity.origin}/index.md" />\n</head>`,
);
html = html.replace(
  /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g,
  (_match, start, json, end) => {
    const graph = JSON.parse(json);
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (value['@type'] === 'WebSite' && value.name === publicIdentity.name)
        value.description = publicIdentity.summary;
      for (const child of Object.values(value)) visit(child);
    };
    visit(graph);
    return `${start}\n${JSON.stringify(graph, null, 2).replaceAll('<', '\\u003c')}\n${end}`;
  },
);
await writeFile(
  indexFile,
  await prettier.format(html, {
    ...(await prettier.resolveConfig(fileURLToPath(indexFile))),
    parser: 'html',
  }),
);
