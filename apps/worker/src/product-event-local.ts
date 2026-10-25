import type { ProductEventV1 } from '@app-health/contracts';
import {
  canonicalProductJson,
  ProductError,
  type ProductScope,
  type ProductFact,
} from './product-event-model.js';
class LocalProductEvents {
  private batches = new Map<string, string>();
  private facts = new Map<string, ProductFact>();
  record(scope: ProductScope, batch: string, events: ProductEventV1[]) {
    const prefix = canonicalProductJson(scope),
      id = prefix + batch,
      digest = canonicalProductJson(events);
    if (this.batches.has(id) && this.batches.get(id) !== digest)
      throw new ProductError('Product batch identity conflict', 409);
    let accepted = 0;
    for (const event of events) {
      const saved = this.facts.get(prefix + event.event_id);
      if (saved && canonicalProductJson(saved.event) !== canonicalProductJson(event))
        throw new ProductError('Product event identity conflict', 409);
    }
    if (
      this.facts.size + events.filter((event) => !this.facts.has(prefix + event.event_id)).length >
        50000 ||
      (!this.batches.has(id) && this.batches.size >= 4000)
    )
      throw new ProductError('Local product archive capacity', 429);
    for (const event of events)
      if (!this.facts.has(prefix + event.event_id)) {
        this.facts.set(prefix + event.event_id, { scope, event });
        accepted++;
      }
    this.batches.set(id, digest);
    return { schema_version: 1, accepted, duplicates: events.length - accepted };
  }
  read(scope: Omit<ProductScope, 'channel'>, from: number, to: number) {
    return [...this.facts.values()].filter(
      ({ scope: s, event: e }) =>
        s.workspace === scope.workspace &&
        s.app_id === scope.app_id &&
        s.environment_id === scope.environment_id &&
        e.occurred_at >= from &&
        e.occurred_at < to,
    );
  }
}
export const localProductEvents = new LocalProductEvents();
