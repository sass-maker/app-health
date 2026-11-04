import { isSafeBrowserArchiveDay } from './browser-archive-day-audit.js';
import type { ArchiveDayIndexCursor } from './browser-archive.js';
import type { BrowserEnvironment } from './browser-routes.js';
import type { OwnerIdentity } from './identity.js';
import { readPublicJson } from './public-body.js';

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function parseInput(
  value: unknown,
): { day: string; shard: number; cursor: ArchiveDayIndexCursor | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['day', 'shard', 'cursor'].includes(key)) ||
    typeof row.day !== 'string' ||
    !isSafeBrowserArchiveDay(row.day) ||
    !Number.isSafeInteger(row.shard) ||
    Number(row.shard) < 0 ||
    Number(row.shard) > 15
  )
    return null;
  const cursor = row.cursor ?? null;
  if (!validCursor(cursor, row.day)) return null;
  return { day: row.day, shard: Number(row.shard), cursor: cursor as ArchiveDayIndexCursor | null };
}

function validCursor(value: unknown, day: string): value is ArchiveDayIndexCursor | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const next = value as Record<string, unknown>;
  return (
    Object.keys(next).length === 3 &&
    next.event_day === day &&
    typeof next.object_key === 'string' &&
    next.object_key.length > 0 &&
    next.object_key.length <= 1024 &&
    Number.isSafeInteger(next.snapshot_sequence) &&
    Number(next.snapshot_sequence) >= 0
  );
}

function operatorRequestError(
  request: Request,
  owner: OwnerIdentity,
  local: boolean,
): Response | null {
  if (
    local ||
    !owner.workspaceId ||
    owner.appId ||
    owner.authKind !== 'account' ||
    owner.workspaceRole !== 'owner'
  )
    return json(403, { error: 'Full workspace owner access is required.' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json(403, { error: 'Same-origin operator request required.' });
  if ([...new URL(request.url).searchParams.keys()].length)
    return json(400, { error: 'Invalid scope index request.' });
  return null;
}

export async function browserScopeIndexOwnerRoute(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/browser/archive-scope-index') return null;
  const error = operatorRequestError(request, owner, local);
  if (error) return error;
  const workspace = owner.workspaceId!;
  let input;
  try {
    input = parseInput(await readPublicJson(request, 16 * 1024));
  } catch (error) {
    return json(error instanceof Error && error.message === 'payload too large' ? 413 : 400, {
      error: 'Invalid scope index request.',
    });
  }
  if (!input) return json(400, { error: 'Invalid scope index request.' });
  try {
    const shard = env.BROWSER_ARCHIVE?.getByName(`${workspace}:browser-archive-v1:${input.shard}`);
    if (!shard?.reindexScopeSegments)
      return json(503, { error: 'Archive scope indexing is unavailable.' });
    return json(200, await shard.reindexScopeSegments(input.day, input.cursor, workspace));
  } catch {
    return json(503, { error: 'Archive scope indexing failed. Retry the same cursor.' });
  }
}
