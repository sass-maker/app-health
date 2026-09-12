import {
  CapabilitySelection,
  CreateEnvironmentRequest,
  type EnvironmentV1,
} from '@app-health/contracts';
import type { AppHealthRepositories } from './repository.js';
import type { OwnerIdentity } from './identity.js';

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function canManage(owner: OwnerIdentity, app: string) {
  return !owner.appId && (!owner.appIds || owner.appIds.includes(app));
}
class SetupBodyTooLarge extends Error {}
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let value = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.length;
    if (bytes > 4096) {
      await reader.cancel();
      throw new SetupBodyTooLarge('Request exceeds 4 KiB');
    }
    value += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(value + decoder.decode());
}
async function scopedEnvironment(repos: AppHealthRepositories, app: string, env: string) {
  const row = await repos.environments.getEnvironment(env);
  return row?.app_id === app ? row : null;
}
async function capabilityResponse(repos: AppHealthRepositories, app: string, env: string) {
  if (!repos.capabilities) return json(503, { error: 'Capability state is unavailable' });
  const [capabilities, key] = await Promise.all([
    repos.capabilities.getCapabilities(app, env),
    repos.keys.getActiveKeyForEnvironment(app, env),
  ]);
  return json(200, {
    app_id: app,
    environment_id: env,
    capabilities,
    private_key: key
      ? {
          id: key.id,
          environment_id: key.environment_id,
          created_at: key.created_at,
          revoked_at: key.revoked_at,
        }
      : null,
  });
}
async function capabilities(
  request: Request,
  repos: AppHealthRepositories,
  owner: OwnerIdentity,
  url: URL,
) {
  const app = url.searchParams.get('app_id') ?? '';
  const env = url.searchParams.get('environment_id') ?? '';
  if (!app || !env) return json(400, { error: 'Project and environment are required' });
  if (!canManage(owner, app)) return json(403, { error: 'Project access denied' });
  if (!(await scopedEnvironment(repos, app, env)))
    return json(404, { error: 'Environment not found' });
  if (!repos.capabilities) return json(503, { error: 'Capability state is unavailable' });
  if (request.method === 'PUT') {
    const parsed = CapabilitySelection.safeParse(await body(request));
    if (!parsed.success) return json(400, { error: 'Invalid capability selection' });
    await repos.capabilities.setCapabilities(app, env, parsed.data.enabled);
  } else if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  return capabilityResponse(repos, app, env);
}
async function issueKey(repos: AppHealthRepositories, environment: EnvironmentV1) {
  const { record, rawKey } = await repos.keys.rotateEnvironmentKey(
    environment.app_id,
    environment.id,
    Date.now(),
  );
  return json(201, {
    environment,
    key: {
      key: rawKey,
      app_id: record.app_id,
      environment_id: record.environment_id,
      created_at: record.created_at,
    },
  });
}
async function addEnvironment(request: Request, repos: AppHealthRepositories, app: string) {
  if (!(await repos.apps.getApp(app))) return json(404, { error: 'Project not found' });
  const parsed = CreateEnvironmentRequest.safeParse(await body(request));
  if (!parsed.success) return json(400, { error: 'Use a lower-case environment name' });
  const created = await repos.environments.createEnvironmentKey(app, parsed.data.name, Date.now());
  if (!created)
    return json(409, { error: 'Environment already exists or the environment limit was reached' });
  return json(201, {
    environment: created.environment,
    key: {
      key: created.rawKey,
      app_id: app,
      environment_id: created.environment.id,
      created_at: created.record.created_at,
    },
  });
}
export async function handleProjectRoutes(
  request: Request,
  repos: AppHealthRepositories,
  owner: OwnerIdentity,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/apps\/([^/]+)\/environments(?:\/([^/]+)\/keys)?$/);
  if (url.pathname !== '/v1/capabilities' && !match) return null;
  try {
    if (!match) return await capabilities(request, repos, owner, url);
    if (!canManage(owner, match[1])) return json(403, { error: 'Project access denied' });
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!match[2]) return await addEnvironment(request, repos, match[1]);
    const environment = await scopedEnvironment(repos, match[1], match[2]);
    return environment
      ? await issueKey(repos, environment)
      : json(404, { error: 'Environment not found' });
  } catch (error) {
    return json(
      error instanceof SyntaxError ? 400 : error instanceof SetupBodyTooLarge ? 413 : 503,
      {
        error:
          error instanceof SyntaxError
            ? 'Invalid JSON'
            : 'Project setup is unavailable. Please retry.',
      },
    );
  }
}
