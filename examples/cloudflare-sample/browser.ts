import { createWebLogger, type WebLogger } from '@saas-maker/app-health/web';

interface CheckoutConfig {
  environment: 'production' | 'staging';
  ingestOrigin: string;
  publicKey: string;
}

interface BrowserTracker {
  track(name: string): void;
  flush(): Promise<void>;
  diagnostics(): { accepted: number; dropped: number; retries: number; queued: number };
}

declare global {
  interface Window {
    appHealth?: BrowserTracker;
    checkoutConfig: CheckoutConfig;
    checkoutSample?: { environment: string; logger: WebLogger };
  }
}

const config = window.checkoutConfig;
const logger = createWebLogger({
  publicKey: config.publicKey,
  environment: config.environment,
  endpoint: `${config.ingestOrigin}/v1/logs`,
});
const form = document.querySelector<HTMLFormElement>('#checkout-form');
const unavailable = document.querySelector<HTMLButtonElement>('#unavailable');
const product = document.querySelector<HTMLElement>('#product');
const status = document.querySelector<HTMLElement>('#status');

async function loadProduct(): Promise<void> {
  const response = await fetch('/api/products/trail-pack');
  const item = (await response.json()) as { name: string; price: number };
  if (product) product.textContent = `${item.name} · $${item.price}`;
}

async function completeCheckout(): Promise<void> {
  const response = await fetch('/api/checkout', { method: 'POST' });
  if (!response.ok) throw new Error(`Checkout returned ${response.status}`);
  const tracker = window.appHealth;
  if (!tracker) throw new Error('App Health tracker did not load');
  const event = `checkout.${config.environment}.completed`;
  tracker.track(event);
  logger.log(event, {
    title: 'Checkout confirmation shown',
    props: { sku: 'trail-pack', amount: 84, currency: 'USD' },
  });
  await Promise.all([tracker.flush(), logger.flush()]);
  if (status) status.textContent = 'Checkout complete.';
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (status) status.textContent = 'Completing checkout…';
  void completeCheckout().catch((cause: unknown) => {
    if (status) status.textContent = cause instanceof Error ? cause.message : 'Checkout failed';
  });
});

unavailable?.addEventListener('click', () => {
  void fetch('/api/checkout/unavailable').then((response) => {
    if (status) status.textContent = `Service unavailable (${response.status}).`;
  });
});

window.checkoutSample = { environment: config.environment, logger };
void loadProduct();
