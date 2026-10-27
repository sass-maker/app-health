/* global URL */
import copy from '../../web/src/public-copy.json' with { type: 'json' };
import { createAgentSurfaceManifest } from './agent-surfaces/manifest.mjs';
import { createAgentSurfaceHandler } from './agent-surfaces/handler.mjs';
import { listMarkdownRoutes } from './agent-surfaces/documents.mjs';
import { absoluteMarkdownLinks } from './agent-surfaces/format.mjs';
import { advertiseMarkdown } from './agent-surfaces/adapters/static-assets.mjs';

export const publicIdentity = {
  name: 'App Health',
  origin: 'https://health.sassmaker.com',
  title: 'App Health — Web analytics, product events, and app health',
  summary: copy.hero.summary,
};
const origin = publicIdentity.origin;
const link = (label, path) => `[${label.trim()}](${new URL(path, origin).href})`;
const page = (path, title, description, lines) =>
  absoluteMarkdownLinks(
    [
      `# ${title}`,
      '',
      `> ${description}`,
      '',
      `Canonical: ${origin}${path}`,
      '',
      ...lines,
      '',
      '## Related',
      '',
      `${link('App Health', '/')} · ${link('Changelog', '/changelog')} · ${link('Source and roadmap', 'https://github.com/sass-maker/app-health/issues')}`,
      '',
    ].join('\n'),
    origin + path,
  );

const home = [
  copy.hero.audience,
  '',
  `## ${copy.hero.title} ${copy.hero.titleContinuation}`,
  '',
  copy.hero.summary,
  '',
  link(copy.hero.openLabel, '/app'),
  '',
  link(copy.hero.exploreLabel, '/#product'),
  '',
  copy.hero.availability,
  '',
  `\`${copy.hero.scriptExample}\``,
  '',
  `\`${copy.hero.eventExample}\``,
  '',
  `## ${copy.preview.name} — ${copy.preview.disclosure}`,
  '',
  'The preview below is illustrative data, not live customer telemetry.',
  '',
  ...copy.previewMetrics.map((metric) => `- ${metric.label}: ${metric.value} — ${metric.note}`),
  '',
  '### Illustrative chart (24 hours)',
  '',
  '| Hour | Page views | Events |',
  '| --- | ---: | ---: |',
  ...copy.samplePageviews.map(
    (value, hour) => `| ${hour}:00 | ${value} | ${Math.round(value / 5)} |`,
  ),
  '',
  '### Top pages (illustrative)',
  '',
  ...copy.pages.map(([path, count]) => `- \`${path}\`: ${count}`),
  '',
  '### Product events (illustrative)',
  '',
  ...copy.events.map(([name, count]) => `- \`${name}\`: ${count}`),
  '',
  ...copy.proofPoints.map((point) => `- ${point}`),
  '',
  copy.productSection.eyebrow,
  '',
  `## ${copy.productSection.title}`,
  '',
  copy.productSection.summary,
  '',
  ...copy.features.flatMap((feature) => [
    feature.eyebrow,
    '',
    `### ${feature.title}`,
    '',
    feature.body,
    '',
    feature.proof,
    '',
  ]),
  copy.integration.eyebrow.trim(),
  '',
  `## ${copy.integration.title}`,
  '',
  copy.integration.summary,
  '',
  link(copy.integration.actionLabel, '/app'),
  '',
  copy.integration.filename.trim(),
  '',
  copy.integration.platform,
  '',
  '```html',
  copy.integrationSnippet,
  '```',
  '',
  ...[
    copy.integration.namedEvents,
    copy.integration.activeSessions,
    copy.integration.backendHealth,
  ].map((text) => `- ${text.trim()}`),
  '',
  copy.status.eyebrow,
  '',
  `## ${copy.status.title}`,
  '',
  copy.status.summary,
  '',
  link(copy.status.changelogLabel, '/changelog'),
];
export const publicPages = {
  '/privacy': page('/privacy', copy.privacy.title, copy.privacy.summary, [
    copy.privacy.updated,
    '',
    ...copy.privacy.sections.flatMap(([title, description]) => [
      `## ${title}`,
      '',
      description,
      '',
    ]),
    `${copy.privacy.contactLabel} ${link(copy.privacy.email, `mailto:${copy.privacy.email}`)}`,
  ]),
  '/': page('/', publicIdentity.title, publicIdentity.summary, home),
  '/changelog': page('/changelog', 'Changelog — App Health', copy.changelog.summary, [
    copy.changelog.eyebrow,
    '',
    `## ${copy.changelog.title}`,
    '',
    copy.changelog.summary,
    '',
    ...copy.entries.flatMap((entry) => [
      `## ${entry.date} — ${entry.title}`,
      '',
      ...entry.outcomes.map((outcome) => `- ${outcome}`),
      '',
    ]),
    copy.changelog.analyticsDisclosure,
  ]),
};
export const excludedPaths = [
  '/admin',
  '/auth',
  '/api',
  '/dashboard',
  '/app',
  '/live',
  '/v1',
  '/mcp',
];
export const publicManifest = createAgentSurfaceManifest({
  name: publicIdentity.name,
  url: origin,
  summary: publicIdentity.summary,
  contact: 'https://github.com/sass-maker/app-health/issues',
  updatedAt: '2026-10-26',
  trainingAllowed: true,
  excludedPaths,
  sitemap: `${origin}/sitemap.xml`,
  openapi: `${origin}/openapi.json`,
  pages: publicPages,
  auth: { public: true, notes: 'Auth-walled app routes are not agent-indexed unless listed here.' },
  notes: [
    'Only the public product landing, changelog, and privacy notice are included. Operator dashboards, shared analytics, account data, logs, payments, and telemetry APIs are excluded.',
  ],
});
export const publicRoutes = listMarkdownRoutes(publicManifest);
export const handlePublicDocument = createAgentSurfaceHandler({
  manifest: publicManifest,
  preserveMarkdownPaths: ['/fonts/fleet-footer-precise-v1/README.md'],
});
export function advertisePublicHtml(request, response) {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  return publicPages[path]
    ? advertiseMarkdown(response, origin, path === '/' ? '/index.md' : `${path}.md`)
    : response;
}
export async function publicHtmlResponse(request, assets) {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  if (!publicPages[path] || !assets || !['GET', 'HEAD'].includes(request.method)) return null;
  const response = await assets.fetch(request);
  return advertisePublicHtml(request, response);
}
export const publicRobots = [
  '# Keep in sync with /llms.txt and /ai.txt.',
  '',
  ...[
    '*',
    'OAI-SearchBot',
    'ChatGPT-User',
    'Claude-SearchBot',
    'Claude-User',
    'PerplexityBot',
    'Perplexity-User',
    'GPTBot',
    'ClaudeBot',
    'Google-Extended',
    'Applebot-Extended',
    'CCBot',
    'Bytespider',
  ].flatMap((bot) => [
    `User-agent: ${bot}`,
    'Allow: /',
    ...excludedPaths.map((path) => `Disallow: ${path}`),
    'Allow: /api/ai$',
    'Allow: /api/md/',
    '',
  ]),
  `Sitemap: ${origin}/sitemap.xml`,
  '',
].join('\n');
export const publicSitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${publicRoutes.map((route) => `<url><loc>${route.url}</loc></url>`).join('')}</urlset>\n`;
