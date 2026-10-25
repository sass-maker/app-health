import type { CollectedBrowserBatch } from './browser-analytics.js';
import type { D1DatabaseLike } from './d1-adapter.js';
import { browserFactsDigestVersion, digestBrowserEventFacts } from './browser-facts-digest.js';
import { browserSessionScope } from './browser-analytics.js';

export async function prepareBrowserBatch(
  batch: CollectedBrowserBatch,
  session: string | undefined,
  local: boolean,
): Promise<CollectedBrowserBatch> {
  const scoped = session
    ? {
        ...batch,
        session_hash: await browserSessionScope(batch.app_id, batch.environment_id, session),
      }
    : batch;
  if (local || !scoped.events.length) return scoped;
  return {
    ...scoped,
    facts_digest_version: 2,
    facts_digest: await digestBrowserEventFacts(scoped, 2),
  };
}

/** A matching accepted legacy retry needs no re-enqueue of unauthenticated context. */
export async function compatibleBrowserBatch(
  db: D1DatabaseLike,
  batch: CollectedBrowserBatch,
): Promise<'accepted' | CollectedBrowserBatch | null> {
  const receipt = await db
    .prepare(
      `SELECT facts_digest_version, facts_digest, expanded_facts_digest
    FROM browser_visitor_batch_receipts WHERE workspace_id = ? AND app_id = ? AND environment_id = ? AND batch_id = ?`,
    )
    .bind(batch.workspace, batch.app_id, batch.environment_id, batch.batch_id)
    .first<{
      facts_digest_version: number | null;
      facts_digest: string | null;
      expanded_facts_digest: string | null;
    }>();
  if (!receipt || receipt.expanded_facts_digest !== null) return batch;
  if (
    receipt.facts_digest_version !== 1 ||
    !receipt.facts_digest ||
    browserFactsDigestVersion(batch) === 2
  )
    return null;
  const digest = await digestBrowserEventFacts(batch, 1);
  if (digest !== receipt.facts_digest) return null;
  return 'accepted';
}

/** Atomically reserve immutable client facts before Queue.send, including cross-version retries. */
export async function claimBrowserBatch(
  db: D1DatabaseLike,
  batch: CollectedBrowserBatch,
): Promise<boolean> {
  const digest = await digestBrowserEventFacts(batch, 2);
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO browser_expanded_batch_claims
      (workspace_id, app_id, environment_id, batch_id, digest, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(
        batch.workspace,
        batch.app_id,
        batch.environment_id,
        batch.batch_id,
        digest,
        Date.now() + 35 * 86400000,
      ),
    db
      .prepare(
        `SELECT digest FROM browser_expanded_batch_claims
      WHERE workspace_id = ? AND app_id = ? AND environment_id = ? AND batch_id = ?`,
      )
      .bind(batch.workspace, batch.app_id, batch.environment_id, batch.batch_id),
  ]);
  if (result.some((row) => !row.success)) throw new Error('Batch claim transaction failed');
  const claim = result[1]?.results?.[0];
  return claim?.digest === digest;
}
