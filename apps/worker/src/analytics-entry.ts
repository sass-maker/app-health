/** Unified production entrypoint for endpoint telemetry, logs, and analytics. */
import worker, { type Env } from './index.js';
import type { CollectedBrowserBatch } from './browser-analytics.js';
import { consumeBrowserBatches } from './browser-queue.js';
export { WorkspacePresence } from './browser-presence.js';
export { BrowserArchive } from './browser-archive.js';

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await worker.scheduled(controller, env);
  },
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
    worker.fetch(request, env, ctx),
  async queue(batch: MessageBatch<CollectedBrowserBatch>, env: Env): Promise<void> {
    await consumeBrowserBatches(batch.messages, env);
  },
} satisfies ExportedHandler<Env, CollectedBrowserBatch>;
