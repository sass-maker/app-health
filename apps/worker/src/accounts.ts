import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { D1DatabaseLike } from './d1-adapter.js';
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

/** Auth context initialization uses D1 I/O and must stay within its Worker request. */
export function createAccountAuth(env: AccountBindings, timings?: OwnerRequestTimings) {
  if (!accountsConfigured(env)) return null;
  const origin = `https://${env.APP_HEALTH_DASHBOARD_HOST}`;
  const auth = betterAuth<BetterAuthOptions>({
    appName: 'App Health',
    baseURL: origin,
    basePath: '/v1/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: timings ? withAuthReadTiming(env.DB, timings) : env.DB,
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
  authSetupMs?: number;
  sessionLookupMs?: number;
  sessionDbReadMs?: number;
  userDbReadMs?: number;
  workspaceScopeMs?: number;
  routeReadMs?: number;
}

/**
 * Measures Better Auth's session and user D1 reads separately. SQL is used
 * transiently for classification and is never retained or emitted.
 */
function withAuthReadTiming(db: D1Database, timings: OwnerRequestTimings): D1Database {
  const readTimingFor = (query: string): 'session' | 'user' | undefined => {
    if (/\bfrom\s+["`]?session["`]?(?=\s|\)|$)/i.test(query)) return 'session';
    if (/\bfrom\s+["`]?user["`]?(?=\s|\)|$)/i.test(query)) return 'user';
    return undefined;
  };

  const wrapStatement = (statement: D1PreparedStatement, read: 'session' | 'user' | undefined) =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'bind' && typeof value === 'function')
          return (...values: unknown[]) => wrapStatement(value.apply(target, values), read);
        if (property === 'all' && read && typeof value === 'function')
          return async (...args: unknown[]) => {
            const started = performance.now();
            try {
              return await value.apply(target, args);
            } finally {
              if (read === 'session') timings.sessionDbReadMs = performance.now() - started;
              else timings.userDbReadMs = performance.now() - started;
            }
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'prepare' && typeof value === 'function')
        return (query: string) => wrapStatement(value.call(target, query), readTimingFor(query));
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function withOwnerServerTiming(response: Response, timings?: OwnerRequestTimings): Response {
  if (!timings) return response;
  const values = [
    ['auth_setup', timings.authSetupMs],
    ['session_lookup', timings.sessionLookupMs],
    ['session_db_read', timings.sessionDbReadMs],
    ['user_db_read', timings.userDbReadMs],
    ['workspace_scope', timings.workspaceScopeMs],
    ['route_read', timings.routeReadMs],
  ]
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name, milliseconds]) => `${name};dur=${milliseconds.toFixed(2)}`);
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
