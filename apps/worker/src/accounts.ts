import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { D1DatabaseLike, D1PreparedStatement } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';

export interface AccountBindings {
  APP_HEALTH_ACCOUNTS?: string;
  APP_HEALTH_DASHBOARD_HOST?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  DB?: D1DatabaseLike;
}

/** A runtime guard preserves the small repository interface used by local adapters. */
function isNativeD1(db: D1DatabaseLike): db is D1Database {
  return 'exec' in db && 'dump' in db;
}

type ConfiguredAccounts = AccountBindings & {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  APP_HEALTH_DASHBOARD_HOST: string;
};

export function accountsConfigured(env: AccountBindings): env is ConfiguredAccounts {
  return (
    env.APP_HEALTH_ACCOUNTS === 'enabled' &&
    Boolean(
      env.DB &&
      isNativeD1(env.DB) &&
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.BETTER_AUTH_SECRET &&
      env.BETTER_AUTH_SECRET.length >= 32 &&
      env.APP_HEALTH_DASHBOARD_HOST,
    )
  );
}

async function measureAuthDbOperation<T>(
  timings: OwnerRequestTimings,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    timings.authDbMs = (timings.authDbMs ?? 0) + performance.now() - started;
    timings.authDbOps = (timings.authDbOps ?? 0) + 1;
  }
}

function instrumentAuthStatement(
  statement: D1PreparedStatement,
  timings: OwnerRequestTimings,
  originals: WeakMap<object, D1PreparedStatement>,
): D1PreparedStatement {
  const wrapped = new Proxy(statement, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== 'function') return method;
      if (key === 'bind')
        return (...args: unknown[]) =>
          instrumentAuthStatement(
            Reflect.apply(method, target, args) as D1PreparedStatement,
            timings,
            originals,
          );
      if (key === 'first' || key === 'all' || key === 'run')
        return (...args: unknown[]) =>
          measureAuthDbOperation(
            timings,
            () => Reflect.apply(method, target, args) as Promise<unknown>,
          );
      return method.bind(target);
    },
  });
  originals.set(wrapped, statement);
  return wrapped;
}

function instrumentAuthDatabase(db: D1Database, timings: OwnerRequestTimings): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  return new Proxy(db, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== 'function') return method;
      if (key === 'prepare')
        return (...args: Parameters<D1Database['prepare']>) =>
          instrumentAuthStatement(
            Reflect.apply(method, target, args) as D1PreparedStatement,
            timings,
            originals,
          );
      if (key === 'batch')
        return (statements: D1PreparedStatement[]) =>
          measureAuthDbOperation(
            timings,
            () =>
              Reflect.apply(method, target, [
                statements.map((statement) => originals.get(statement) ?? statement),
              ]) as Promise<unknown>,
          );
      return method.bind(target);
    },
  });
}

/** Auth context initialization uses D1 I/O and must stay within its Worker request. */
export function createAccountAuth(env: AccountBindings, timings?: OwnerRequestTimings) {
  if (!accountsConfigured(env)) return null;
  const origin = `https://${env.APP_HEALTH_DASHBOARD_HOST}`;
  const auth = betterAuth<BetterAuthOptions>({
    appName: 'App Health',
    baseURL: origin,
    basePath: '/v1/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: timings ? instrumentAuthDatabase(env.DB, timings) : env.DB,
    trustedOrigins: [origin],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: 'select_account',
      },
    },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    advanced: {
      // Account tables are migration-managed; avoid introspecting D1 per auth context.
      database: { validateSchema: false },
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: true,
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
  });
  return auth;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface OwnerRequestTimings {
  authDbMs?: number;
  authDbOps?: number;
  authSetupMs?: number;
  sessionLookupMs?: number;
  workspaceScopeMs?: number;
  routeReadMs?: number;
}

export function withOwnerServerTiming(response: Response, timings?: OwnerRequestTimings): Response {
  if (!timings) return response;
  const values = [
    ['auth_setup', timings.authSetupMs],
    ['session_lookup', timings.sessionLookupMs],
    ['workspace_scope', timings.workspaceScopeMs],
    ['route_read', timings.routeReadMs],
  ]
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name, milliseconds]) => `${name};dur=${milliseconds.toFixed(2)}`);
  if (timings.authDbMs !== undefined && timings.authDbOps !== undefined)
    values.push(`auth_db;dur=${timings.authDbMs.toFixed(2)};desc="${timings.authDbOps} ops"`);
  if (!values.length) return response;
  const headers = new Headers(response.headers);
  headers.set('server-timing', values.join(', '));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** UNIQUE(owner_id) makes simultaneous first-session requests idempotent. */
export async function personalWorkspace(
  db: D1DatabaseLike,
  userId: string,
  onCreated?: () => void,
): Promise<Workspace> {
  const existing = await db
    .prepare('SELECT id, name FROM workspaces WHERE owner_id = ?')
    .bind(userId)
    .first<Workspace>();
  if (existing) return existing;
  const inserted = await db
    .prepare(
      'INSERT OR IGNORE INTO workspaces (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)',
    )
    .bind(`ws-${crypto.randomUUID()}`, userId, 'My workspace', Date.now())
    .run();
  const workspace = await db
    .prepare('SELECT id, name FROM workspaces WHERE owner_id = ?')
    .bind(userId)
    .first<Workspace>();
  if (!workspace) throw new Error('Workspace could not be created');
  if (inserted.meta.changes === 1) onCreated?.();
  return workspace;
}

async function workspaceAndApps(db: D1DatabaseLike, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT w.id AS workspace_id, w.name AS workspace_name, a.id AS app_id
       FROM workspaces w
       LEFT JOIN workspace_apps wa ON wa.workspace_id = w.id
       LEFT JOIN apps a ON a.id = wa.app_id AND a.archived_at IS NULL
       WHERE w.owner_id = ?
       ORDER BY a.id`,
    )
    .bind(userId)
    .all<{ workspace_id: string; workspace_name: string; app_id: string | null }>();
  return results;
}

export async function accountIdentity(
  request: Request,
  env: AccountBindings,
  onSignup?: (id: string) => void,
  timings?: OwnerRequestTimings,
): Promise<{ owner: OwnerIdentity; workspace: Workspace } | null> {
  const authSetupStarted = performance.now();
  const auth = createAccountAuth(env, timings);
  if (timings) timings.authSetupMs = performance.now() - authSetupStarted;
  if (!auth || !env.DB) return null;
  const sessionLookupStarted = performance.now();
  const session = await auth.api.getSession({ headers: request.headers });
  if (timings) timings.sessionLookupMs = performance.now() - sessionLookupStarted;
  if (!session || !session.user.emailVerified) return null;
  const workspaceScopeStarted = performance.now();
  let rows = await workspaceAndApps(env.DB, session.user.id);
  if (!rows.length) {
    await personalWorkspace(env.DB, session.user.id, () => onSignup?.(session.user.id));
    rows = await workspaceAndApps(env.DB, session.user.id);
  }
  if (timings) timings.workspaceScopeMs = performance.now() - workspaceScopeStarted;
  const workspaceRow = rows[0];
  if (!workspaceRow) throw new Error('Workspace could not be read');
  return {
    workspace: { id: workspaceRow.workspace_id, name: workspaceRow.workspace_name },
    owner: {
      id: session.user.id,
      label: session.user.name,
      workspaceId: workspaceRow.workspace_id,
      appIds: rows.flatMap((row) => (row.app_id === null ? [] : [row.app_id])),
    },
  };
}

/** Cookie authentication never inherits bearer credentials or trusts a client workspace id. */
export function accountMutationAllowed(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  return request.headers.get('origin') === new URL(request.url).origin;
}
