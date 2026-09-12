import { expect, it, vi } from 'vitest';
import { AppHealthService, InMemoryAdapter } from '../src/index.js';
import { EndpointCapacityError, validateEndpointCapacity } from '../src/endpoint-capacity.js';

const now = 1_725_000_000_000;
const event = (index: number) => ({
  event_id: crypto.randomUUID(),
  timestamp: now,
  method: 'GET',
  route: `/route-${index}`,
  status_code: 503,
  duration_ms: 10,
});

it('limits expanded groups across environments while retaining useful batch aggregation', () => {
  expect(() =>
    validateEndpointCapacity(Array.from({ length: 1000 }, () => event(1))),
  ).not.toThrow();
  expect(() =>
    validateEndpointCapacity(Array.from({ length: 250 }, (_, i) => event(i))),
  ).not.toThrow();
  expect(() => validateEndpointCapacity(Array.from({ length: 251 }, (_, i) => event(i)))).toThrow(
    EndpointCapacityError,
  );
  const crossEnvironment = Array.from({ length: 126 }, (_, i) => event(i)).flatMap((row) => [
    { ...row, environment: 'prod' },
    { ...row, environment: 'staging' },
  ]);
  expect(() => validateEndpointCapacity(crossEnvironment)).toThrow(EndpointCapacityError);
});

it('rejects provider expansion before inventory, failures, dedupe or installation side effects', async () => {
  const adapter = await InMemoryAdapter.create();
  const repos = adapter.asRepositories();
  repos.buckets.validateEvents = validateEndpointCapacity;
  const seen = vi.spyOn(repos.dedupe, 'markSeen');
  const observed = vi.spyOn(repos.inventory!, 'recordObserved');
  const failures = vi.spyOn(repos.failures!, 'recordFailures');
  const installed = vi.spyOn(repos.installation, 'recordIngest');
  const service = new AppHealthService(repos);
  const created = await service.createApp({ name: 'capacity', environment: 'prod' }, now);
  const events = Array.from({ length: 251 }, (_, i) => event(i));
  await expect(
    service.ingest(
      created.key.key,
      {
        schema_version: 'v1',
        runtime: 'node',
        environment: 'prod',
        events,
      },
      now,
    ),
  ).rejects.toThrow(EndpointCapacityError);
  const key = await service.verifyIngestKey(created.key.key);
  await expect(service.ingestEvents(key!, 'otel', undefined, events, now)).rejects.toThrow(
    EndpointCapacityError,
  );
  for (const spy of [seen, observed, failures, installed]) expect(spy).not.toHaveBeenCalled();
  expect(
    await service.ingest(
      created.key.key,
      {
        schema_version: 'v1',
        runtime: 'node',
        environment: 'prod',
        events: events.slice(0, 250),
      },
      now,
    ),
  ).toMatchObject({ ok: true, accepted: 250 });
});
