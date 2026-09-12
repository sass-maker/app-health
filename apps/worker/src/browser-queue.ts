import type { BrowserBindings, CollectedBrowserBatch } from './browser-analytics.js';

/** Fixed shard count is part of the dedupe contract; do not change inside its retention window. */
export async function browserArchiveShard(batch: CollectedBrowserBatch): Promise<string> {
  const identity = JSON.stringify([batch.app_id, batch.environment_id, batch.batch_id]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `${batch.workspace}:browser-archive-v1:${new Uint8Array(digest)[0] % 16}`;
}
const identity = (batch: Pick<CollectedBrowserBatch, 'app_id' | 'environment_id' | 'batch_id'>) =>
  JSON.stringify([batch.app_id, batch.environment_id, batch.batch_id]);

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
    const result = await env.BROWSER_ARCHIVE.getByName(shard).stage(
      messages.map((message) => message.body),
    );
    const accepted = new Set(result.accepted.map(identity));
    for (const message of messages) {
      accepted.delete(identity(message.body));
      message.ack();
    }
  } catch {
    for (const message of messages) message.retry({ delaySeconds: 30 });
  }
}
