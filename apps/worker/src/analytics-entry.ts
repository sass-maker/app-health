import { consumeProviderJobs } from './payment-provider-queue.js';
import { isProviderWake } from './payment-provider-wake.js';
import type { ProviderJobWake } from './payment-provider-model.js';
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
  async queue(
    batch: MessageBatch<CollectedBrowserBatch | ProviderJobWake>,
    env: Env,
  ): Promise<void> {
    const browser: Message<CollectedBrowserBatch>[] = [],
      providers: Message<ProviderJobWake>[] = [];
    for (const message of batch.messages) {
      if (isProviderWake(message.body)) providers.push(message as Message<ProviderJobWake>);
      else if (message.body && typeof message.body === 'object' && 'type' in message.body)
        message.ack();
      else browser.push(message as Message<CollectedBrowserBatch>);
    }
    if (providers.length) await consumeProviderJobs(providers, env);
    if (browser.length) await consumeBrowserBatches(browser, env);
  },
} satisfies ExportedHandler<Env, CollectedBrowserBatch | ProviderJobWake>;
