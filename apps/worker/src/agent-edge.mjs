/**
 * Portable agent-edge handler — copy or generate into each product.
 * Spec: foundry/ops/docs/agent-indexing-standard.md
 *
 * Usage in worker.mjs (before openNext.fetch):
 *   import { handleAgentEdge } from './agent-edge.mjs'
 *   const agent = handleAgentEdge(request)
 *   if (agent) return agent
 */

/* global Response, URL */

import {
  publicIdentity,
  publicManifest,
  publicPages,
  publicRobots,
  publicSitemap,
  handlePublicDocument,
} from './public-site.mjs';
export const AGENT_SURFACE = {
  name: publicIdentity.name,
  url: publicIdentity.origin,
  llmsTxt: publicManifest.llmsTxt,
  indexMd: publicPages['/'],
  catalog: {
    ...publicManifest.catalog,
    robots: `${publicIdentity.origin}/robots.txt`,
    openapi: `${publicIdentity.origin}/openapi.json`,
  },
};

const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'App Health public API',
    version: '1.0.0',
    description:
      'Privacy-first endpoint health for Node, Go, Cloudflare, and OpenTelemetry services. The public web API exposes read-only agent surfaces: the agent catalog, llms.txt, sitemap, and markdown alternates.',
    contact: { name: 'App Health', url: 'https://health.sassmaker.com' },
  },
  servers: [{ url: 'https://health.sassmaker.com' }],
  tags: [{ name: 'agent-surfaces', description: 'Machine-readable public surfaces' }],
  paths: {
    '/api/ai': {
      get: {
        operationId: 'getAgentCatalog',
        tags: ['agent-surfaces'],
        summary: 'Agent catalog',
        description: 'JSON inventory of public agent surfaces.',
        responses: {
          200: {
            description: 'Agent catalog',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AgentCatalog' } },
            },
          },
        },
      },
    },
    '/llms.txt': {
      get: {
        operationId: 'getLlmsTxt',
        tags: ['agent-surfaces'],
        summary: 'llms.txt index',
        responses: { 200: { description: 'Markdown index', content: { 'text/plain': {} } } },
      },
    },
    '/llms-full.txt': {
      get: {
        operationId: 'getLlmsFullTxt',
        tags: ['agent-surfaces'],
        summary: 'Full agent brief',
        responses: { 200: { description: 'Markdown brief', content: { 'text/plain': {} } } },
      },
    },
    '/sitemap.xml': {
      get: {
        operationId: 'getSitemap',
        tags: ['agent-surfaces'],
        summary: 'Sitemap',
        responses: { 200: { description: 'XML sitemap', content: { 'application/xml': {} } } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        tags: ['agent-surfaces'],
        summary: 'OpenAPI specification',
        description: 'This document.',
        responses: {
          200: { description: 'OpenAPI 3.1 spec', content: { 'application/json': {} } },
        },
      },
    },
  },
  components: {
    schemas: {
      AgentCatalog: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          llms: { type: 'string', format: 'uri' },
          llmsFull: { type: 'string', format: 'uri' },
          sitemap: { type: 'string', format: 'uri' },
          robots: { type: 'string', format: 'uri' },
          openapi: { type: 'string', format: 'uri' },
          markdown: {
            type: 'object',
            properties: { suffix: { type: 'string' }, negotiation: { type: 'boolean' } },
          },
        },
      },
    },
  },
};

function jsonError(status, code, message, path) {
  return new Response(JSON.stringify({ error: { code, message, path } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

/** @returns {Response} */
function openApiResponse() {
  return new Response(JSON.stringify(OPENAPI_SPEC, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    },
  });
}

/**
 * Re-bind the catalog to the requesting origin so preview and custom domains stay correct.
 * @param {URL} url
 * @returns {Response}
 */
function catalogResponse(url) {
  const rebind = (value) => (value ? String(value).replace(AGENT_SURFACE.url, url.origin) : value);
  return json({
    ...AGENT_SURFACE.catalog,
    url: url.origin,
    llms: `${url.origin}/llms.txt`,
    llmsFull: `${url.origin}/llms-full.txt`,
    sitemap: rebind(AGENT_SURFACE.catalog.sitemap) || `${url.origin}/sitemap.xml`,
    openapi: `${url.origin}/openapi.json`,
    surfaces: (AGENT_SURFACE.catalog.surfaces || []).map((surface) => ({
      ...surface,
      url: rebind(surface.url),
      md: rebind(surface.md),
    })),
  });
}

const AGENT_ROUTES = {
  '/openapi.json': openApiResponse,
  '/openapi.yaml': openApiResponse,
  '/robots.txt': () => text(publicRobots, 'text/plain; charset=utf-8'),
  '/sitemap.xml': () => text(publicSitemap, 'application/xml; charset=utf-8'),
  '/api/ai': (url) => catalogResponse(url),
};

/** @param {Request} request @returns {Promise<Response | null>} */
export async function handleAgentEdge(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/ai' && !url.pathname.startsWith('/v1/') && url.pathname !== '/mcp') {
    const document = await handlePublicDocument(request);
    if (document) return document;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const path = url.pathname || '/';
  const route = AGENT_ROUTES[path];
  if (route) {
    const response = route(url);
    return request.method === 'HEAD' && response ? new Response(null, response) : response;
  }
  if (path.startsWith('/api/'))
    return jsonError(404, 'not_found', `Unknown API path: ${path}`, path);
  return null;
}

function text(body, type, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=300',
      ...extra,
    },
  });
}

function json(data) {
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
