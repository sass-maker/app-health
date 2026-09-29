import type { BrowserEventV1 } from '@app-health/contracts';

/** Digest contract for the immutable event facts carried by an accepted browser batch. */
export const BROWSER_EVENT_FACTS_DIGEST_VERSION = 1;

export type BrowserFactsBatch = {
  workspace: string;
  app_id: string;
  environment_id: string;
  batch_id: string;
  events: readonly BrowserEventV1[];
  visitor_hash?: string;
};

export function serializeBrowserEventFacts(batch: BrowserFactsBatch): string {
  return JSON.stringify([
    'app-health-browser-event-facts',
    BROWSER_EVENT_FACTS_DIGEST_VERSION,
    batch.workspace,
    batch.app_id,
    batch.environment_id,
    batch.batch_id,
    batch.visitor_hash?.toLowerCase() ?? null,
    batch.events.map((event) => [
      event.event_id,
      event.timestamp,
      event.type,
      event.path,
      event.name ?? null,
      event.referrer,
    ]),
  ]);
}

export async function digestSerializedBrowserEventFacts(canonical: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestBrowserEventFacts(batch: BrowserFactsBatch): Promise<string> {
  return digestSerializedBrowserEventFacts(serializeBrowserEventFacts(batch));
}
