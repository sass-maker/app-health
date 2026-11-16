import {
  CatalogPublisherApprovalV1,
  CatalogPublisherReviewV1,
  CatalogPublisherError,
  CatalogPublisherEnrollmentV1,
  CatalogPublisherReportV1,
  CatalogPublisherIdentityV1,
  CatalogSyncRequestV1,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';
import { readPublicJson } from './public-body.js';
import {
  CatalogSyncConflict,
  catalogSnapshotStatus,
  syncCatalog,
  unlinkedCatalogApps,
} from './catalog-sync.js';

const PAIRING_TTL = 15 * 60_000;
const publisherPath = '/v1/catalog/publisher';
const ownerPath = '/v1/catalog/publishers';
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type Publisher = {
  id: string;
  verifier_hash: string;
  label: string;
  expires_at: number;
  workspace_id: string | null;
  approved_at: number | null;
  revoked_at: number | null;
  outside_app_ids_json: string;
};
async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function handleCatalogPublisher(
  request: Request,
  db: D1DatabaseLike | undefined,
  now = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url);
  if (![publisherPath, `${publisherPath}/enroll`, `${publisherPath}/error`].includes(url.pathname))
    return null;
  if (request.headers.has('origin'))
    return json(403, { error: 'Publisher requests require the local service' });
  if (!db) return json(503, { error: 'Catalog storage is unavailable' });
  try {
    if (url.pathname === `${publisherPath}/enroll`) return await enroll(request, db, now);
    const token = request.headers.get('authorization')?.match(/^Bearer (ahcp_[a-f0-9]{64})$/)?.[1];
    if (!token) return json(401, { error: 'Catalog publisher connection required' });
    const publisher = await db
      .prepare('SELECT * FROM catalog_publishers WHERE verifier_hash = ?')
      .bind(await hash(token))
      .first<Publisher>();
    if (
      !publisher ||
      publisher.revoked_at !== null ||
      (publisher.approved_at === null && publisher.expires_at <= now)
    )
      return json(401, { error: 'Catalog publisher connection expired or revoked' });
    if (url.pathname === publisherPath && request.method === 'GET') {
      const snapshot = publisher.workspace_id
        ? await catalogSnapshotStatus(db, publisher.workspace_id)
        : null;
      return json(200, {
        state: publisher.workspace_id ? 'approved' : 'pending',
        publisher_id: publisher.id,
        label: publisher.label,
        expires_at: publisher.expires_at,
        projection_hash: snapshot?.projection_hash ?? null,
        project_count: snapshot?.project_count ?? null,
      });
    }
    if (!publisher.workspace_id)
      return json(403, { error: 'Approve this connection in the owner dashboard first' });
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (url.pathname === `${publisherPath}/error`) {
      const input = CatalogPublisherReportV1.safeParse(await readPublicJson(request, 512));
      if (!input.success) return json(400, { error: 'Invalid publisher status' });
      await attempt(db, publisher, now, input.data.error, input.data.error === null);
      return json(200, { ok: true });
    }
    return await publish(request, db, publisher, now);
  } catch (error) {
    return publisherFailure(error);
  }
}

function enrollmentCaller(request: Request): string | null {
  const address = request.headers.get('cf-connecting-ip');
  if (!address || address.length > 45) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    const parts = address.split('.').map(Number);
    return parts.every((part) => part <= 255) ? parts.join('.') : null;
  }
  if (!/^[a-f0-9:]+$/i.test(address) || !address.includes(':')) return null;
  try {
    return new URL(`https://[${address}]`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function enroll(request: Request, db: D1DatabaseLike, now: number) {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  const caller = enrollmentCaller(request);
  if (!caller) return json(403, { error: 'Pairing requires a recognized network caller' });
  const enrollmentKey = await hash(`${Math.floor(now / PAIRING_TTL)}:${caller}`);
  const input = CatalogPublisherEnrollmentV1.safeParse(await readPublicJson(request, 512));
  if (!input.success) return json(400, { error: 'Provide a connection name' });
  const secret = `ahcp_${[...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const code = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const id = crypto.randomUUID();
  await db
    .prepare('DELETE FROM catalog_publishers WHERE workspace_id IS NULL AND expires_at <= ?')
    .bind(now)
    .run();
  const created = await db
    .prepare(
      `INSERT INTO catalog_publishers
    (id, verifier_hash, pairing_code, label, created_at, expires_at, enrollment_key)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM catalog_publishers WHERE workspace_id IS NULL) < 128
    AND (SELECT count(*) FROM catalog_publishers WHERE workspace_id IS NULL AND enrollment_key = ?) < 4 RETURNING id`,
    )
    .bind(
      id,
      await hash(secret),
      code,
      input.data.label,
      now,
      now + PAIRING_TTL,
      enrollmentKey,
      enrollmentKey,
    )
    .first<{ id: string }>();
  return created
    ? json(201, { publisher_id: id, code, secret, expires_at: now + PAIRING_TTL })
    : json(429, { error: 'Too many pending connections. Retry after existing requests expire.' });
}

async function attempt(
  db: D1DatabaseLike,
  publisher: Publisher,
  now: number,
  error: (typeof CatalogPublisherError.options)[number] | null,
  success = false,
) {
  await db
    .prepare(
      `UPDATE catalog_publishers SET last_attempt_at = ?, last_error = ?,
    last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
    )
    .bind(now, error, success ? 1 : 0, now, publisher.id, publisher.workspace_id)
    .run();
}

async function publish(request: Request, db: D1DatabaseLike, publisher: Publisher, now: number) {
  const input = CatalogSyncRequestV1.safeParse(await readPublicJson(request, 96 * 1024));
  if (
    !input.success ||
    input.data.preserve_outside_catalog_app_ids.length ||
    input.data.monitoring.projects.some((row) => row.scope === 'public' && !row.journey_revisions)
  )
    return json(400, {
      error:
        'A complete catalog projection with check revisions is required; outside-project decisions belong to the owner',
    });
  try {
    const response = await syncCatalog(
      db,
      publisher.workspace_id!,
      {
        ...input.data,
        preserve_outside_catalog_app_ids: JSON.parse(publisher.outside_app_ids_json) as string[],
      },
      now,
      { id: publisher.id, verifierHash: publisher.verifier_hash },
    );
    await attempt(db, publisher, now, null, true);
    return json(200, response);
  } catch (error) {
    const review = error instanceof CatalogSyncConflict && /reviewed|unlinked/.test(error.message);
    await attempt(
      db,
      publisher,
      now,
      review
        ? 'review_required'
        : error instanceof CatalogSyncConflict
          ? 'conflict'
          : 'service_unavailable',
    );
    if (error instanceof Error && error.message.includes('catalog publisher revoked'))
      return json(401, { error: 'Catalog publisher connection revoked' });
    return publisherFailure(error);
  }
}

function publisherFailure(error: unknown) {
  if (error instanceof CatalogSyncConflict) return json(409, { error: error.message });
  if (error instanceof SyntaxError) return json(400, { error: 'Invalid catalog JSON' });
  if (error instanceof Error && error.message === 'payload too large')
    return json(413, { error: 'Catalog projection exceeds its size limit' });
  return json(503, {
    error: 'Catalog synchronization unavailable; the last saved portfolio is retained',
  });
}

export async function handleCatalogPublisherOwner(
  request: Request,
  db: D1DatabaseLike | undefined,
  owner: OwnerIdentity,
  now = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    ![
      ownerPath,
      `${ownerPath}/pairing`,
      `${ownerPath}/approve`,
      `${ownerPath}/revoke`,
      `${ownerPath}/review`,
    ].includes(url.pathname)
  )
    return null;
  if (
    owner.authKind !== 'account' ||
    owner.workspaceRole !== 'owner' ||
    !owner.workspaceId ||
    owner.appId
  )
    return json(403, { error: 'Only the workspace account owner can manage catalog publishers' });
  if (!db) return json(503, { error: 'Catalog storage is unavailable' });
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin)
    return json(403, { error: 'Same-origin owner confirmation required' });
  try {
    if (url.pathname === ownerPath && request.method === 'GET') {
      const publishers = await db
        .prepare(
          `SELECT id, label, approved_at, revoked_at, last_attempt_at, last_success_at, last_error
        FROM catalog_publishers WHERE workspace_id = ? ORDER BY revoked_at IS NULL DESC, approved_at DESC LIMIT 10`,
        )
        .bind(owner.workspaceId)
        .all();
      return json(200, { publishers: publishers.results });
    }
    if (url.pathname === `${ownerPath}/pairing` && request.method === 'GET') {
      const code = url.searchParams.get('code') ?? '';
      if (!/^[A-F0-9]{12}$/.test(code))
        return json(400, { error: 'Enter the twelve-character connection code' });
      const pending = await db
        .prepare(
          `SELECT label FROM catalog_publishers WHERE pairing_code = ?
        AND workspace_id IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        )
        .bind(code, now)
        .first<{ label: string }>();
      return pending
        ? json(200, pending)
        : json(404, { error: 'Connection code expired or unavailable. Start pairing again.' });
    }
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (url.pathname === `${ownerPath}/review`)
      return await reviewOutside(request, db, owner.workspaceId, now);
    if (url.pathname === `${ownerPath}/approve`)
      return await approve(request, db, owner.workspaceId, now);
    if (url.pathname === `${ownerPath}/revoke`) {
      const input = CatalogPublisherIdentityV1.safeParse(await readPublicJson(request, 512));
      if (!input.success) return json(400, { error: 'Invalid publisher identity' });
      const revoked = await db
        .prepare(
          'UPDATE catalog_publishers SET revoked_at = ? WHERE id = ? AND workspace_id = ? RETURNING id',
        )
        .bind(now, input.data.publisher_id, owner.workspaceId)
        .first();
      return revoked ? json(200, { ok: true }) : json(404, { error: 'Publisher unavailable' });
    }
    return json(405, { error: 'method not allowed' });
  } catch (error) {
    return publisherFailure(error);
  }
}

async function approve(request: Request, db: D1DatabaseLike, workspace: string, now: number) {
  const input = CatalogPublisherApprovalV1.safeParse(await readPublicJson(request, 8 * 1024));
  if (!input.success)
    return json(400, { error: 'Confirm catalog-only access and all outside projects' });
  const snapshot = await catalogSnapshotStatus(db, workspace);
  if (!snapshot.source)
    return json(409, { error: 'Import the canonical catalog before connecting automatic updates' });
  const unlinked = await unlinkedCatalogApps(db, workspace);
  const outside = [...input.data.preserve_outside_catalog_app_ids].sort();
  if (
    outside.length !== new Set(outside).size ||
    JSON.stringify(outside) !== JSON.stringify(unlinked.map((app) => app.app_id).sort())
  )
    return json(409, { error: 'Review the current outside projects and retry the connection' });
  const approved = await db
    .prepare(
      `UPDATE catalog_publishers SET workspace_id = ?, approved_at = ?, outside_app_ids_json = ?, enrollment_key = NULL
    WHERE pairing_code = ? AND workspace_id IS NULL AND revoked_at IS NULL AND expires_at > ?
    AND (SELECT count(*) FROM catalog_publishers WHERE workspace_id = ? AND revoked_at IS NULL) < 10 RETURNING id`,
    )
    .bind(workspace, now, JSON.stringify(outside), input.data.code, now, workspace)
    .first<{ id: string }>();
  return approved
    ? json(200, { publisher_id: approved.id })
    : json(409, { error: 'Connection expired, already approved, or connection limit reached' });
}

async function reviewOutside(request: Request, db: D1DatabaseLike, workspace: string, now: number) {
  const input = CatalogPublisherReviewV1.safeParse(await readPublicJson(request, 8 * 1024));
  if (!input.success)
    return json(400, { error: 'Confirm automatic access and all current outside projects' });
  const unlinked = await unlinkedCatalogApps(db, workspace);
  const outside = [...input.data.preserve_outside_catalog_app_ids].sort();
  if (
    new Set(outside).size !== outside.length ||
    JSON.stringify(outside) !== JSON.stringify(unlinked.map((app) => app.app_id).sort())
  )
    return json(409, { error: 'Outside projects changed. Review the current list and retry.' });
  // The live unlinked-set comparison and active grant fence execute in the same SQL statement.
  const reviewed = await db
    .prepare(
      `UPDATE catalog_publishers SET outside_app_ids_json = ?, last_error = NULL, last_attempt_at = ?
    WHERE id = ? AND workspace_id = ? AND approved_at IS NOT NULL AND revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM workspace_apps wa JOIN apps a ON a.id = wa.app_id
      WHERE wa.workspace_id = ? AND a.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM catalog_project_imports c WHERE c.workspace_id = wa.workspace_id AND c.app_id = wa.app_id)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) ack WHERE ack.value = wa.app_id))
    AND NOT EXISTS (SELECT 1 FROM json_each(?) ack WHERE NOT EXISTS (
      SELECT 1 FROM workspace_apps wa JOIN apps a ON a.id = wa.app_id
      WHERE wa.workspace_id = ? AND a.archived_at IS NULL AND wa.app_id = ack.value
      AND NOT EXISTS (SELECT 1 FROM catalog_project_imports c WHERE c.workspace_id = wa.workspace_id AND c.app_id = wa.app_id))) RETURNING id`,
    )
    .bind(
      JSON.stringify(outside),
      now,
      input.data.publisher_id,
      workspace,
      workspace,
      JSON.stringify(outside),
      JSON.stringify(outside),
      workspace,
    )
    .first<{ id: string }>();
  return reviewed
    ? json(200, { publisher_id: reviewed.id })
    : json(409, { error: 'Connection or outside projects changed. Review again.' });
}
