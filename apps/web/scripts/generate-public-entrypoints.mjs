import copy from '../src/public-copy.json' with { type: 'json' };
/* v8 ignore start -- build-only generator covered by canonical contract tests. */
import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

export const PUBLIC_ENTRYPOINTS = [
  {
    file: 'changelog.html',
    path: '/changelog',
    title: 'Changelog — App Health',
    description: copy.changelog.summary,
  },
  {
    file: 'privacy.html',
    path: '/privacy',
    title: 'Privacy — App Health',
    description: copy.privacy.summary,
  },
];

const CLARITY_TAG = `<script>
      window.clarity = window.clarity || function () {
        (window.clarity.q = window.clarity.q || []).push(arguments);
      };
      var clarityScript = document.createElement('script');
      clarityScript.async = true;
      clarityScript.src = 'https://www.clarity.ms/tag/y6bveiqm8k';
      document.head.appendChild(clarityScript);
    </script>`;

function replaceMeta(html, attribute, value) {
  const pattern = new RegExp(`(<meta\\s+${attribute}\\s+content=")[^"]*("\\s*\\/?>)`, 'i');
  if (!pattern.test(html)) throw new Error(`Missing metadata tag: ${attribute}`);
  return html.replace(pattern, `$1${value}$2`);
}

export function renderPublicEntrypoint(indexHtml, entry) {
  if (entry.path === '/privacy')
    indexHtml = indexHtml.replace(
      "if (!['/', '/changelog'].includes(window.location.pathname))",
      "if (!['/', '/changelog', '/privacy'].includes(window.location.pathname))",
    );
  const canonical = `https://health.sassmaker.com${entry.path}`;
  let html = replaceMeta(indexHtml, 'name="description"', entry.description);
  if (html.includes('name="ai-summary"'))
    html = replaceMeta(html, 'name="ai-summary"', entry.description);
  html = html.replace(
    /(<link\s+rel="alternate"\s+type="text\/markdown"\s+href=")[^"]*(")/,
    `$1${canonical}.md$2`,
  );
  html = replaceMeta(html, 'property="og:url"', canonical);
  html = replaceMeta(html, 'property="og:title"', entry.title);
  html = replaceMeta(html, 'property="og:description"', entry.description);
  html = replaceMeta(html, 'name="twitter:title"', entry.title);
  html = replaceMeta(html, 'name="twitter:description"', entry.description);
  html = html.replace(
    /<link rel="canonical" href="[^"]+" \/>/,
    `<link rel="canonical" href="${canonical}" />`,
  );
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${entry.title}</title>`);
  return entry.path === '/changelog'
    ? html.replace('</head>', `    ${CLARITY_TAG}\n  </head>`)
    : html;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  await Promise.all(
    PUBLIC_ENTRYPOINTS.map((entry) =>
      writeFile(
        new URL(`../${entry.file}`, import.meta.url),
        renderPublicEntrypoint(indexHtml, entry),
      ),
    ),
  );
  console.log(`Generated ${PUBLIC_ENTRYPOINTS.length} canonical public HTML entrypoint.`);
}
/* v8 ignore stop */
