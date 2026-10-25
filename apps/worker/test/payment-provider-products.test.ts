import { expect, it } from 'vitest';
import { stripeProducts } from '../src/payment-provider-products.js';
import { providerFixture } from './payment-provider-fixture.js';
it('uses invoice product evidence only after a complete empty Checkout lookup, and refuses incomplete or ambiguous carts', async () => {
  const f = providerFixture();
  try {
    const session = await f.session();
    let checkout: unknown = { data: [], has_more: false },
      invoices: unknown = { data: [{ invoice: 'in_1' }], has_more: false },
      lines: unknown = {
        data: [{ pricing: { price_details: { product: 'prod_invoice' } } }],
        has_more: false,
      };
    const calls: URL[] = [];
    session.fetcher = async (input) => {
      const u = new URL(String(input));
      calls.push(u);
      return Response.json(
        u.pathname.endsWith('/checkout/sessions')
          ? checkout
          : u.pathname.endsWith('/invoice_payments')
            ? invoices
            : lines,
      );
    };
    expect(await stripeProducts(session, f.payment)).toEqual(['prod_invoice']);
    expect(calls[1].searchParams.get('payment[type]')).toBe('payment_intent');
    expect(calls[1].searchParams.get('payment[payment_intent]')).toBe('pi_1');
    for (const bad of [
      { data: [{ id: 'cs1' }, { id: 'cs2' }], has_more: false },
      { data: [], has_more: true },
    ]) {
      session.requests = 0;
      checkout = bad;
      const n = calls.length;
      expect(await stripeProducts(session, f.payment)).toBeNull();
      expect(calls.length - n).toBe(1);
    }
    checkout = { data: [], has_more: false };
    invoices = { data: [{ invoice: 'in_1' }, { invoice: 'in_2' }], has_more: false };
    session.requests = 0;
    expect(await stripeProducts(session, f.payment)).toBeNull();
    invoices = { data: [{ invoice: 'in_1' }], has_more: false };
    for (const bad of [
      { data: [], has_more: false },
      { data: [{}], has_more: false },
      { data: [{}], has_more: true },
    ]) {
      lines = bad;
      session.requests = 0;
      expect(await stripeProducts(session, f.payment)).toBeNull();
    }
    expect(await stripeProducts(session, { payment_intent: null })).toBeNull();
  } finally {
    f.sqlite.close();
  }
});
