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
export function createAccountAuth(env: AccountBindings) {
  if (!accountsConfigured(env)) return null;
  const origin = `https://${env.APP_HEALTH_DASHBOARD_HOST}`;
  const auth = betterAuth<BetterAuthOptions>({
    appName: 'App Health',
    baseURL: origin,
    basePath: '/v1/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
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

export async function accountIdentity(
  request: Request,
  env: AccountBindings,
  onSignup?: (id: string) => void,
): Promise<{ owner: OwnerIdentity; workspace: Workspace } | null> {
  const auth = createAccountAuth(env);
  if (!auth || !env.DB) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session || !session.user.emailVerified) return null;
  const workspace = await personalWorkspace(env.DB, session.user.id, () =>
    onSignup?.(session.user.id),
  );
  const { results } = await env.DB.prepare(
    'SELECT app_id FROM workspace_apps WHERE workspace_id = ?',
  )
    .bind(workspace.id)
    .all<{ app_id: string }>();
  return {
    workspace,
    owner: {
      id: session.user.id,
      label: session.user.name,
      workspaceId: workspace.id,
      appIds: results.map((row) => row.app_id),
    },
  };
}

/** Cookie authentication never inherits bearer credentials or trusts a client workspace id. */
export function accountMutationAllowed(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  return request.headers.get('origin') === new URL(request.url).origin;
}
