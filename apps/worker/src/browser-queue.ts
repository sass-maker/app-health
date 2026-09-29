import type { BrowserBindings, CollectedBrowserBatch } from './browser-analytics.js';
import type { BrowserArchiveStagingLookup } from './browser-archive.js';

export type BrowserArchiveBatchIdentity = Pick<
  CollectedBrowserBatch,
  'app_id' | 'environment_id' | 'batch_id'
>;

/** Fixed shard count is part of the dedupe contract; do not change inside its retention window. */
export async function browserArchiveShard(batch: CollectedBrowserBatch): Promise<string> {
  const identity = JSON.stringify([batch.app_id, batch.environment_id, batch.batch_id]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `${batch.workspace}:browser-archive-v1:${new Uint8Array(digest)[0] % 16}`;
}
/** Join accepted D1 identities to the same stable shards used by the Queue consumer. */
export async function lookupBrowserStagingReceipts(
  workspace: string,
  batches: readonly BrowserArchiveBatchIdentity[],
  env: BrowserBindings,
): Promise<BrowserArchiveStagingLookup> {
  if (!workspace || workspace.length > 200) throw new Error('Invalid archive workspace');
  if (batches.length > 1000) throw new Error('Archive staging lookup exceeds 1000 batches');
  if (!env.BROWSER_ARCHIVE) throw new Error('browser archive binding missing');
  const groups = new Map<string, BrowserArchiveBatchIdentity[]>();
  for (const batch of batches) {
    const shard = await browserArchiveShard({ ...batch, workspace } as CollectedBrowserBatch);
    const group = groups.get(shard) ?? [];
    group.push(batch);
    groups.set(shard, group);
  }
  const staged: BrowserArchiveBatchIdentity[] = [];
  let missing = 0;
  for (const [shard, group] of groups) {
    for (let start = 0; start < group.length; start += 100) {
      const result = await env.BROWSER_ARCHIVE.getByName(shard).lookupStaged(
        group.slice(start, start + 100),
      );
      staged.push(
        ...result.staged.map(({ app_id, environment_id, batch_id }) => ({
          app_id,
          environment_id,
          batch_id,
        })),
      );
      missing += result.missing;
    }
  }
  return { staged, missing };
}
/** Queue acknowledgements follow durable SQLite staging, never a fire-and-forget R2 upload. */
export async function consumeBrowserBatches(
  messages: readonly Message<CollectedBrowserBatch>[],
  env: BrowserBindings,
): Promise<void> {
  const groups = new Map<string, Message<CollectedBrowserBatch>[]>();
  for (const message of messages) {
    const shard = await browserArchiveShard(message.body);
    const group = groups.get(shard) ?? [];
    group.push(message);
    groups.set(shard, group);
  }
  for (const [shard, group] of groups) {
    // Bound RPC payloads even if a future Queue configuration increases its batch size.
    for (let start = 0; start < group.length; start += 100)
      await stageGroup(shard, group.slice(start, start + 100), env);
  }
}

async function stageGroup(
  shard: string,
  messages: readonly Message<CollectedBrowserBatch>[],
  env: BrowserBindings,
) {
  try {
    if (!env.BROWSER_ARCHIVE) throw new Error('browser archive binding missing');
    await env.BROWSER_ARCHIVE.getByName(shard).stage(messages.map((message) => message.body));
    // stage() is atomic: every input is either newly accepted or an identical
    // previously staged batch. Conflicts/capacity failures throw, so the full
    // group is safe to ack here; accepted lists only the newly inserted rows.
    for (const message of messages) {
      message.ack();
    }
  } catch {
    for (const message of messages) message.retry({ delaySeconds: 30 });
  }
}
