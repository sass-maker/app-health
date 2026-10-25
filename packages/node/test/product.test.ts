import { describe, expect, it } from 'vitest';
import { ProductBatchV1 } from '../../contracts/src/index.js';
import { createAppHealthClient } from '../src/index.js';
import { createFetchController } from './helpers.js';
import { buildProductEvent } from '../src/product.js';
const uuid = () => crypto.randomUUID();

describe('explicit client.track', () => {
  it('sends canonical case-sensitive events separately from endpoint telemetry and snapshots supplied properties', async () => {
    const transport = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_fixture',
      endpoint: 'http://localhost:8787/v1/ingest',
      environment: 'production',
      fetch: transport.fetch,
      disableTimer: true,
    });
    const properties = { plan: 'Pro' };
    client.record({ method: 'GET', route: '/orders/:id', status_code: 200, duration_ms: 1 });
    client.track('Order Paid', {
      visitor_id: uuid(),
      properties,
      type: 'revenue',
      revenue: { amount_minor: 1250, currency: 'USD' },
      value: 2,
    });
    properties.plan = 'Changed';
    await client.flush();
    expect(transport.requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/v1/ingest',
      '/v1/product-events',
    ]);
    const parsed = ProductBatchV1.parse(JSON.parse(transport.requests[1].body));
    expect(parsed.events[0]).toMatchObject({
      name: 'Order Paid',
      properties: { plan: 'Pro' },
      channel: 'server',
      revenue: { amount_minor: 1250, currency: 'USD' },
      value: 2,
    });
    expect(client.diagnostics()).toMatchObject({ sentEvents: 2, queued: 0 });
  });
  it('rejects PII identity, nested properties, malformed paths and invalid UUIDs before delivery', () => {
    for (const input of [
      { visitor_id: 'email@example.test' },
      { properties: { nested: { secret: 1 } } },
      { path: '/%3Fsecret=1' },
      { event_id: 'a'.repeat(64) },
      { revenue: { amount_minor: 1, currency: 'USD' } },
    ])
      expect(buildProductEvent('Order Paid', input as never, Date.now, uuid)).toBeNull();
    expect(
      buildProductEvent(
        'Button Click',
        { properties: { revenue: 'ordinary', value: 42 } },
        Date.now,
        uuid,
      )?.properties,
    ).toEqual({ revenue: 'ordinary', value: 42 });
  });
  it('bounds every product batch to100events/64KiB and retains IDs for retries', async () => {
    const transport = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_fixture',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: transport.fetch,
      disableTimer: true,
      maxQueueSize: 1000,
      maxBatchSize: 200,
    });
    const properties = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => ['k' + i, 'x'.repeat(255)]),
    );
    for (let i = 0; i < 40; i++) client.track('Large', { properties });
    await client.flush();
    expect(transport.requests.length).toBeGreaterThan(1);
    for (const request of transport.requests) {
      expect(new TextEncoder().encode(request.body).length).toBeLessThanOrEqual(65536);
      expect(ProductBatchV1.parse(JSON.parse(request.body)).events.length).toBeLessThanOrEqual(100);
    }
    expect(client.diagnostics().sentEvents).toBe(40);
  });
});
