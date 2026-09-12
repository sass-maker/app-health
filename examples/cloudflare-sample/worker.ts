import { createAppHealthClient, type AppHealthClient } from '@saas-maker/app-health';
import { honoMiddleware } from '@saas-maker/app-health/hono';
import { Hono } from 'hono';

interface Bindings {
  APP_HEALTH_BROWSER_SCRIPT: string;
  APP_HEALTH_INGEST_ORIGIN: string;
  APP_HEALTH_PRIVATE_KEY: string;
  APP_HEALTH_PUBLIC_KEY: string;
  APP_HEALTH_ENVIRONMENT: 'production' | 'staging';
}

type SampleEnvironment = { Bindings: Bindings };

function telemetry(env: Bindings): AppHealthClient {
  return createAppHealthClient({
    key: env.APP_HEALTH_PRIVATE_KEY,
    environment: env.APP_HEALTH_ENVIRONMENT,
    endpoint: `${env.APP_HEALTH_INGEST_ORIGIN}/v1/ingest`,
    logsEndpoint: `${env.APP_HEALTH_INGEST_ORIGIN}/v1/logs`,
    release: 'cloudflare-checkout-sample-1.0.0',
    runtime: 'worker',
    disableTimer: true,
  });
}

function checkoutPage(env: Bindings): string {
  const browserConfig = JSON.stringify({
    environment: env.APP_HEALTH_ENVIRONMENT,
    ingestOrigin: env.APP_HEALTH_INGEST_ORIGIN,
    publicKey: env.APP_HEALTH_PUBLIC_KEY,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Northstar Checkout</title>
    <style>
      body { max-width: 42rem; margin: 4rem auto; padding: 0 1.25rem; font: 16px/1.5 system-ui; }
      main { display: grid; gap: 1rem; }
      button { width: fit-content; padding: .65rem 1rem; font: inherit; }
      code { background: #eee; border-radius: .25rem; padding: .15rem .3rem; }
    </style>
    <script>window.checkoutConfig = ${browserConfig};</script>
    <script defer src="${env.APP_HEALTH_INGEST_ORIGIN}/tracker.js" data-key="${env.APP_HEALTH_PUBLIC_KEY}" data-endpoint="${env.APP_HEALTH_INGEST_ORIGIN}/v1/browser"></script>
    <script defer src="/assets/checkout.js"></script>
  </head>
  <body>
    <main>
      <p><code>${env.APP_HEALTH_ENVIRONMENT}</code> environment</p>
      <h1>Northstar checkout</h1>
      <p id="product">Loading the Trail Pack…</p>
      <form id="checkout-form">
        <button type="submit">Complete checkout</button>
      </form>
      <button id="unavailable" type="button">Simulate unavailable checkout</button>
      <p id="status" role="status">Ready when you are.</p>
    </main>
  </body>
</html>`;
}

const app = new Hono<SampleEnvironment>();

app.use(
  '/api/*',
  honoMiddleware<SampleEnvironment>({
    client: (context) => telemetry(context.env),
  }),
);

app.get('/', (context) => context.html(checkoutPage(context.env)));
app.get('/assets/checkout.js', (context) =>
  context.body(context.env.APP_HEALTH_BROWSER_SCRIPT, 200, {
    'content-type': 'text/javascript; charset=utf-8',
  }),
);
app.get('/api/products/:sku', (context) =>
  context.json({ sku: context.req.param('sku'), name: 'Trail Pack', price: 84 }),
);
app.post('/api/checkout', (context) => {
  const client = telemetry(context.env);
  client.log(`order.${context.env.APP_HEALTH_ENVIRONMENT}.completed`, {
    title: 'Checkout completed',
    props: { sku: 'trail-pack', amount: 84, currency: 'USD' },
  });
  context.executionCtx.waitUntil(client.flush());
  return context.json({ accepted: true }, 201);
});
app.get('/api/checkout/unavailable', (context) =>
  context.json({ error: 'checkout temporarily unavailable' }, 503),
);

export default app;
