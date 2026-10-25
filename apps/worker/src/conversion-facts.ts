import { PRODUCT_EVENT_SCHEMA, type ProductEventV1 } from '@app-health/contracts';
import type { CollectedBrowserBatch } from './browser-analytics.js';
import type { ProductFact } from './product-event-model.js';
export type ConversionFact = {
  event: ProductEventV1;
  context: {
    app_id: string;
    environment_id: string;
    channel: ProductEventV1['channel'];
    visitor_hash?: string;
    session_hash?: string;
    attribution?: CollectedBrowserBatch['attribution'];
    metadata?: CollectedBrowserBatch['metadata'];
    referrer?: string;
  };
};
export function browserConversionFacts(batches: Iterable<CollectedBrowserBatch>): ConversionFact[] {
  const facts: ConversionFact[] = [];
  for (const batch of batches)
    for (const event of batch.events)
      facts.push({
        context: {
          app_id: batch.app_id,
          environment_id: batch.environment_id,
          channel: 'browser',
          visitor_hash: batch.visitor_hash,
          session_hash: batch.session_hash,
          attribution: batch.attribution,
          metadata: batch.metadata,
          referrer: event.referrer,
        },
        event: {
          schemaVersion: PRODUCT_EVENT_SCHEMA,
          event_id: event.event_id,
          occurred_at: event.timestamp,
          channel: 'browser',
          type: event.type === 'pageview' ? 'page_view' : 'event',
          path: event.path,
          name: event.name,
          properties: event.properties,
          value: event.value,
        },
      });
  return facts;
}
export function productConversionFacts(facts: ProductFact[]): ConversionFact[] {
  return facts.map(({ scope, event }) => ({
    event,
    context: {
      app_id: scope.app_id,
      environment_id: scope.environment_id,
      channel: scope.channel,
      visitor_hash: event.visitor_id,
      session_hash: event.session_id,
      attribution: event.attribution,
    },
  }));
}
