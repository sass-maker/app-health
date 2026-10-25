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
  session_hash?: string;
  visit_type?: string;
  attribution?: unknown;
  metadata?: unknown;
  facts_digest_version?: number;
};

export function browserFactsDigestVersion(batch: BrowserFactsBatch): 1 | 2 {
  return batch.events.some((event) => event.properties !== undefined || event.value !== undefined)
    ? 2
    : 1;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function serializeBrowserEventFacts(
  batch: BrowserFactsBatch,
  version = batch.facts_digest_version ?? browserFactsDigestVersion(batch),
): string {
  if (version !== 1 && version !== 2) throw new Error('Unsupported browser facts digest version');
  const facts: unknown[] = [
    'app-health-browser-event-facts',
    version,
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
      ...(version === 2 ? [canonical(event.properties ?? null), event.value ?? null] : []),
    ]),
  ];
  // Edge-derived geography/device metadata can change on a transport retry.
  // Authenticate the immutable client facts and scoped identities, not that enrichment.
  if (version === 2)
    facts.push(
      batch.session_hash ?? null,
      canonical(batch.attribution ?? null),
      batch.visit_type ?? null,
    );
  return JSON.stringify(facts);
}

export async function digestSerializedBrowserEventFacts(canonical: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestBrowserEventFacts(
  batch: BrowserFactsBatch,
  version?: number,
): Promise<string> {
  return digestSerializedBrowserEventFacts(serializeBrowserEventFacts(batch, version));
}
