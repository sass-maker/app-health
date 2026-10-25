import {
  object,
  resourceId,
  type ProviderSession,
  type Resource,
} from './payment-provider-model.js';
import { providerGet } from './payment-provider-api.js';

function completeRows(page: Resource): Resource[] | null {
  if (page.has_more !== false || !Array.isArray(page.data) || page.data.length > 25) return null;
  return page.data.map(object);
}
// Charge has no invoice field in 2026-09-30.endive. Resolve Checkout first,
// then InvoicePayment.payment.payment_intent, never count either as a sale.
export async function stripeProducts(
  session: ProviderSession,
  charge: Resource,
): Promise<string[] | null> {
  const intent = charge.payment_intent;
  if (typeof intent !== 'string') return null;
  resourceId(intent);
  const sessions = completeRows(
    await providerGet(session, '/checkout/sessions', { payment_intent: intent, limit: '2' }),
  );
  if (!sessions || sessions.length > 1) return null;
  if (sessions.length === 1) {
    const lines = completeRows(
      await providerGet(session, `/checkout/sessions/${resourceId(sessions[0].id)}/line_items`, {
        limit: '25',
      }),
    );
    return productList(lines, (line) => object(line.price).product);
  }
  const payments = completeRows(
    await providerGet(session, '/invoice_payments', {
      'payment[type]': 'payment_intent',
      'payment[payment_intent]': intent,
      limit: '2',
    }),
  );
  if (!payments || payments.length !== 1) return null;
  const invoice = resourceId(payments[0].invoice);
  const lines = completeRows(
    await providerGet(session, `/invoices/${invoice}/lines`, { limit: '25' }),
  );
  return productList(lines, (line) => object(object(line.pricing).price_details).product);
}
function productList(lines: Resource[] | null, product: (line: Resource) => unknown) {
  if (!lines?.length) return null;
  try {
    return [...new Set(lines.map((line) => resourceId(product(line))))];
  } catch {
    return null;
  }
}
