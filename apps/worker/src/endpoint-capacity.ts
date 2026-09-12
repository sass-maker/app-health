import { LATENCY_BUCKET_BOUNDS_MS } from '@app-health/contracts';

export class EndpointCapacityError extends Error {
  constructor() {
    super('Batch exceeds 250 endpoint measurement groups; send smaller batches.');
  }
}

/** One Worker invocation may emit at most 250 Analytics Engine points. */
export function validateEndpointCapacity(
  events: readonly {
    method: string;
    route: string;
    duration_ms: number;
    release?: string;
    environment?: string;
  }[],
  release?: string,
): void {
  const groups = new Set<string>();
  for (const event of events) {
    const index = LATENCY_BUCKET_BOUNDS_MS.findIndex((bound) => event.duration_ms <= bound);
    groups.add(
      JSON.stringify([
        event.environment ?? '',
        event.method,
        event.route,
        index,
        event.release ?? release ?? '',
      ]),
    );
    if (groups.size > 250) throw new EndpointCapacityError();
  }
}
