import { TrafficQualityQuery, type TrafficQuality } from '@app-health/contracts';
import { browserQuery } from './browser-query.js';
import { apiScopeAllows } from './api-scope.js';
import type { BrowserEnvironment } from './browser-routes.js';
import type { OwnerIdentity } from './identity.js';

const DAY = 86_400_000;
const MAX_WINDOW = 30 * DAY;
const MAX_LOOKBACK = 90 * DAY;
type CounterRow = {
  bot_class: 'verified' | 'user_agent';
  pageviews: number;
  sample_interval: number;
};
function counterNumber(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
    return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function counterRow(value: unknown): CounterRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.bot_class !== 'verified' && row.bot_class !== 'user_agent') return null;
  const pageviews = counterNumber(row.pageviews);
  const sample_interval = counterNumber(row.sample_interval);
  if (pageviews === null || sample_interval === null || sample_interval < 1) return null;
  return { bot_class: row.bot_class, pageviews, sample_interval };
}
function counterRows(body: unknown): CounterRow[] | null {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('data' in body) ||
    !Array.isArray(body.data) ||
    body.data.length > 2
  )
    return null;
  const rows: CounterRow[] = [];
  for (const raw of body.data) {
    const parsed = counterRow(raw);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return rows;
}
const json = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });

function validWindow(scope: TrafficQualityQuery, now: number) {
  return (
    scope.from < scope.to &&
    scope.to - scope.from <= MAX_WINDOW &&
    scope.to <= now &&
    scope.from >= now - MAX_LOOKBACK
  );
}

export async function handleTrafficQuality(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  local: boolean,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = TrafficQualityQuery.safeParse(Object.fromEntries(params));
  const now = Date.now();
  if (!parsed.success || [...params.keys()].some((key) => params.getAll(key).length !== 1))
    return json(400, { error: 'Expected only app_id, environment_id, from and to.' });
  const scope = parsed.data;
  if (!apiScopeAllows(owner, scope)) return json(403, { error: 'API scope forbidden.' });
  if (!local && !owner.appIds?.includes(scope.app_id))
    return json(403, { error: 'Project access denied.' });
  if (!validWindow(scope, now))
    return json(400, { error: 'Use a past interval of up to 30 days within the last 90 days.' });
  const base = {
    ...scope,
    generated_at: now,
    time_basis: 'receipt_time',
    qa_internal: 'not_separately_identified',
  } as const;
  const unknown = (reason: Extract<TrafficQuality['bots'], { status: 'unknown' }>['reason']) =>
    json(200, { ...base, bots: { status: 'unknown', reason } } satisfies TrafficQuality);
  if (local) return unknown('local');
  if (new TextEncoder().encode(`bot:${scope.app_id}`).length > 96) return unknown('index_too_long');
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.ANALYTICS_ENGINE_QUERY_TOKEN;
  if (!env.BROWSER_ANALYTICS || !accountId || !/^[a-f0-9]{32}$/i.test(accountId) || !token)
    return unknown('unavailable');
  try {
    const bots = await queryTrafficQuality(scope, { accountId, token });
    return json(200, { ...base, bots } satisfies TrafficQuality);
  } catch {
    return unknown('unavailable');
  }
}

export async function queryTrafficQuality(
  scope: TrafficQualityQuery,
  options: { accountId: string; token: string; fetchImpl?: typeof fetch },
): Promise<TrafficQuality['bots']> {
  scope = TrafficQualityQuery.parse(scope);
  const response = await browserQuery(
    `SELECT blob5 AS bot_class,
    SUM(double1 * _sample_interval) AS pageviews, MAX(_sample_interval) AS sample_interval
    FROM app_health_browser_v1 WHERE index1 = 'bot:${scope.app_id}'
    AND blob1 = '${scope.app_id}' AND blob2 = '${scope.environment_id}' AND blob3 = 'bot_batch'
    AND double2 >= ${scope.from} AND double2 < ${scope.to}
    GROUP BY bot_class LIMIT 3`,
    options,
  );
  if (!response.ok) return { status: 'unknown', reason: 'unavailable' };
  const rows = counterRows(await response.json());
  if (!rows) return { status: 'unknown', reason: 'invalid_response' };
  const classes = new Set(rows.map((row) => row.bot_class));
  if (classes.size !== rows.length) return { status: 'unknown', reason: 'invalid_response' };
  const counts = new Map(rows.map((row) => [row.bot_class, row.pageviews]));
  const cloudflare_verified = counts.get('verified') ?? 0;
  const recognized_user_agent = counts.get('user_agent') ?? 0;
  const pageview_attempts = cloudflare_verified + recognized_user_agent;
  if (!Number.isSafeInteger(pageview_attempts))
    return { status: 'unknown', reason: 'invalid_response' };
  if (!pageview_attempts) return { status: 'unknown', reason: 'no_records' };
  return {
    status: 'observed',
    pageview_attempts,
    cloudflare_verified,
    recognized_user_agent,
    estimated: rows.some((row) => row.sample_interval > 1),
    coverage: 'partial',
  };
}
