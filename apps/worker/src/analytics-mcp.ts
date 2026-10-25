import type { OwnerIdentity } from './identity.js';
import { readPublicJson } from './public-body.js';

type Dispatch = (request: Request, owner: OwnerIdentity) => Promise<Response>;
const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const scopeProperties = { app_id: { type: 'string' }, environment_id: { type: 'string' } };
const tools: {
  name: string;
  description: string;
  path: string;
  properties: Record<string, unknown>;
  required: string[];
  write?: boolean;
}[] = [
  {
    name: 'sites',
    description: 'List projects and environments authorized by this token.',
    path: '/v1/apps',
    properties: {},
    required: [],
  },
  {
    name: 'traffic_report',
    description:
      'Pageviews, visitors, sources, named events and event breakdowns. Sampling is disclosed.',
    path: '/v1/analytics/report',
    properties: {
      ...scopeProperties,
      range: { enum: ['1h', '24h', '7d', '30d'] },
      event: { type: 'string' },
      breakdown: { enum: ['audience', 'acquisition', 'technology'] },
    },
    required: ['app_id', 'environment_id'],
  },
  {
    name: 'conversion_report',
    description:
      'Observed archived goals, ordered funnels, event properties and values. Source completeness is disclosed.',
    path: '/v1/analytics/conversions',
    properties: {
      ...scopeProperties,
      range: { enum: ['1h', '24h', '7d', '30d'] },
      event: { type: 'string' },
      filters: { type: 'object' },
    },
    required: ['app_id', 'environment_id'],
  },
  {
    name: 'revenue_report',
    description:
      'Custom recorded cashflows by default. Select basis=provider or a payment provider for provider-created-date revenue. Currencies and provider namespaces stay separate; read coverage_note.',
    path: '/v1/analytics/revenue',
    properties: {
      ...scopeProperties,
      basis: { enum: ['custom', 'provider'] },
      from: { type: 'integer' },
      to: { type: 'integer' },
      breakdown: { enum: ['source', 'page', 'country', 'campaign'] },
      mode: { enum: ['live', 'test'] },
      currency: { type: 'string' },
      provider: { enum: ['custom', 'stripe', 'polar', 'dodo'] },
      account_id: { type: 'string' },
    },
    required: ['app_id', 'environment_id', 'from', 'to'],
  },
  {
    name: 'list_definitions',
    description: 'List saved goals, funnels and segments.',
    path: '/v1/analytics/definitions',
    properties: scopeProperties,
    required: ['app_id', 'environment_id'],
  },
  {
    name: 'save_definition',
    description: 'Create or update one goal, funnel or saved segment. Requires manage permission.',
    path: '/v1/analytics/definitions',
    properties: { ...scopeProperties, id: { type: 'string' }, definition: { type: 'object' } },
    required: ['app_id', 'environment_id', 'definition'],
    write: true,
  },
  {
    name: 'delete_definition',
    description: 'Delete one goal, funnel or saved segment. Requires manage permission.',
    path: '/v1/analytics/definitions',
    properties: { ...scopeProperties, id: { type: 'string' } },
    required: ['app_id', 'environment_id', 'id'],
    write: true,
  },
];
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const rpcError = (id: unknown, code: number, message: string) =>
  json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function integrationSkill(owner: OwnerIdentity, origin: string) {
  return `---\nname: app-health-instance\ndescription: Query this App Health instance and manage authorized conversion definitions.\n---\n\n# App Health\n\nUse the stateless Streamable HTTP MCP endpoint at ${origin}/mcp.\nAuthenticate with Authorization: Bearer and an App Health workspace API token.\nKeep the token in your client's secret configuration. Never place it in browser storage, source control, prompts, URLs, or report output.\n\nThe token is restricted to these project/environment pairs:\n${(owner.apiScopes ?? []).map((scope) => `- ${scope.app_id} / ${scope.environment_id}`).join('\n')}\n\nAvailable reports include traffic and named events, archived goals/funnels/properties, and recorded revenue. Read sampling and source-coverage fields before interpreting counts. Revenue currencies remain separate. No provider completeness is inferred.\n\n${owner.apiPermission === 'manage' ? 'This token can also create, update and delete goals, funnels and saved segments.' : 'This token is read-only.'}\nIt cannot create API tokens, manage members or invitations, rotate ingest keys, or publish analytics shares.\n\nCall sites first, then a report with explicit app_id and environment_id. Use short periods when archive limits are reached. For conversion definitions, list_definitions precedes any mutation; reuse an existing definition id when updating.\n`;
}

function revenuePath(input: Record<string, unknown>) {
  const provider = input.provider;
  const basis = input.basis ?? (provider && provider !== 'custom' ? 'provider' : 'custom');
  if (
    (basis !== 'custom' && basis !== 'provider') ||
    (basis === 'provider' && provider === 'custom') ||
    (basis === 'custom' && provider !== undefined && provider !== 'custom')
  )
    throw new Error('Invalid revenue basis');
  return basis === 'provider' ? '/v1/analytics/provider-revenue' : '/v1/analytics/revenue';
}

async function callTool(params: unknown, owner: OwnerIdentity, origin: string, dispatch: Dispatch) {
  if (!params || typeof params !== 'object') throw new Error('Invalid tool parameters');
  const { name, arguments: args = {} } = params as { name?: unknown; arguments?: unknown };
  const tool = tools.find((entry) => entry.name === name);
  if (
    !tool ||
    (tool.write && owner.apiPermission !== 'manage') ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    throw new Error('Tool unavailable');
  const input = args as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !Object.hasOwn(tool.properties, key)) ||
    tool.required.some((key) => input[key] === undefined)
  )
    throw new Error('Invalid tool arguments');
  const target = new URL(name === 'revenue_report' ? revenuePath(input) : tool.path, origin);
  if (tool.write && input.id !== undefined) {
    if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id))
      throw new Error('Invalid definition id');
    target.pathname += `/${input.id}`;
  }
  for (const [key, value] of Object.entries(input)) {
    if (['definition', 'id', 'basis'].includes(key)) continue;
    if (key === 'filters') target.searchParams.set(key, JSON.stringify(value));
    else if (typeof value === 'string' || typeof value === 'number')
      target.searchParams.set(key, String(value));
    else throw new Error('Invalid tool argument value');
  }
  const method =
    name === 'delete_definition' ? 'DELETE' : tool.write ? (input.id ? 'PUT' : 'POST') : 'GET';
  const response = await dispatch(
    new Request(target, {
      method,
      ...(name === 'save_definition'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input.definition),
          }
        : {}),
    }),
    owner,
  );
  const body = await response.json();
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: !response.ok };
}

export async function handleAnalyticsMcp(
  request: Request,
  owner: OwnerIdentity,
  dispatch: Dispatch,
) {
  const origin = new URL(request.url).origin;
  if (request.headers.has('origin') && request.headers.get('origin') !== origin)
    return json(403, { error: 'Origin forbidden' });
  if (owner.authKind !== 'api-token') return json(401, { error: 'Workspace API token required' });
  if (request.method !== 'POST')
    return new Response(null, {
      status: 405,
      headers: { allow: 'POST', 'cache-control': 'no-store' },
    });
  const protocol = request.headers.get('mcp-protocol-version');
  if (protocol && !versions.includes(protocol))
    return json(400, { error: 'Unsupported MCP protocol version' });
  const accept = request.headers.get('accept') ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream'))
    return json(406, { error: 'Accept application/json and text/event-stream' });
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return json(415, { error: 'Use application/json' });
  let message: { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: unknown };
  try {
    const parsed = await readPublicJson(request, 32768);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return rpcError(null, -32600, 'Invalid request');
    message = parsed;
  } catch {
    return rpcError(null, -32700, 'Invalid JSON');
  }
  if (
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string' ||
    (Object.hasOwn(message, 'id') &&
      typeof message.id !== 'string' &&
      typeof message.id !== 'number')
  )
    return rpcError(null, -32600, 'Invalid request');
  if (!Object.hasOwn(message, 'id'))
    return message.method.startsWith('notifications/')
      ? new Response(null, { status: 202 })
      : json(400, { error: 'Request id required' });
  let result: unknown;
  if (message.method === 'initialize') {
    const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    result = {
      protocolVersion: requested && versions.includes(requested) ? requested : versions.at(-1),
      capabilities: { tools: {} },
      serverInfo: { name: 'App Health', version: '1.0.0' },
    };
  } else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list')
    result = {
      tools: tools
        .filter((tool) => !tool.write || owner.apiPermission === 'manage')
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: tool.properties,
            required: tool.required,
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: !tool.write,
            destructiveHint: tool.name === 'delete_definition',
          },
        })),
    };
  else if (message.method === 'tools/call') {
    try {
      result = await callTool(message.params, owner, origin, dispatch);
    } catch {
      return rpcError(message.id, -32602, 'Invalid or unauthorized tool arguments');
    }
  } else return rpcError(message.id, -32601, 'Method not found');
  return json(200, { jsonrpc: '2.0', id: message.id, result });
}
